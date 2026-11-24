// The correction shader. It implements the same per-pixel steps, in the same
// order, as `core/src/reference.rs`. Change both together.

export const VERTEX = `#version 300 es
in vec2 a_pos;
out vec2 v_uv;
void main() {
  v_uv = vec2(a_pos.x * 0.5 + 0.5, 0.5 - a_pos.y * 0.5); // image top-left at canvas top-left
  gl_Position = vec4(a_pos, 0.0, 1.0);
}`;

export const FRAGMENT = `#version 300 es
precision highp float;
in vec2 v_uv;
out vec4 o_color;

uniform sampler2D u_tex;
uniform float u_encoded;     // 1 = the automatic correction works on sRGB-encoded values
uniform vec2 u_comp;         // compensation of red and of blue from green
uniform float u_ranged;      // 1 = range-dependent step is active
uniform float u_backscatter[24]; // per channel, 8 samples over range: backscatter to subtract
uniform float u_logGain[24];     // per channel, 8 samples over range: log of the gain that undoes attenuation
uniform highp sampler2D u_range; // range map, one float per cell, 0 near .. 1 far
uniform vec2 u_rangeSize;    // its size in cells
uniform vec4 u_rangeRect;    // the part of the whole image this draw covers: x, y, width, height (0..1)
uniform float u_fusion;      // 1 = fusion step is active
uniform float u_gamma;      // exponent of the gamma-corrected input
uniform float u_tone;       // slope of the tone curve at black; 1 = none
uniform vec2 u_sharpen;      // shift and scale of the sharpened input's detail
uniform highp sampler2D u_fusionA; // fusion maps: offset (rgb) and weight of the first input (a)
uniform highp sampler2D u_fusionB; // fusion maps: blurred balanced image (rgb)
uniform vec2 u_fusionSize;   // their size in cells
uniform mat3 u_matrix;       // affine part of the automatic correction
uniform vec3 u_offset;
uniform float u_strength;    // 0 = original, 1 = full correction
uniform vec3 u_whiteBalance; // channel gains
uniform float u_exposure;    // multiplier
uniform float u_contrast;    // multiplier around mid grey
uniform float u_saturation;  // -1 .. 1
uniform float u_split;       // show the original left of this x (0..1); negative = off

const vec3 LUMA = vec3(0.2126, 0.7152, 0.0722);

// Bilinear lookup done by hand, so that it is the same arithmetic as RangeMap::sample in the core.
float rangeAt(vec2 uv) {
  vec2 p = clamp(uv * u_rangeSize - 0.5, vec2(0.0), u_rangeSize - 1.0);
  ivec2 i0 = ivec2(floor(p));
  ivec2 i1 = min(i0 + 1, ivec2(u_rangeSize) - 1);
  vec2 f = p - floor(p);
  float top = mix(texelFetch(u_range, i0, 0).r, texelFetch(u_range, ivec2(i1.x, i0.y), 0).r, f.x);
  float bottom = mix(texelFetch(u_range, ivec2(i0.x, i1.y), 0).r, texelFetch(u_range, i1, 0).r, f.x);
  return mix(top, bottom, f.y);
}

// The same lookup for the fusion maps; as FusionMaps::sample in the core.
vec4 fusionAt(highp sampler2D map, vec2 uv) {
  vec2 p = clamp(uv * u_fusionSize - 0.5, vec2(0.0), u_fusionSize - 1.0);
  ivec2 i0 = ivec2(floor(p));
  ivec2 i1 = min(i0 + 1, ivec2(u_fusionSize) - 1);
  vec2 f = p - floor(p);
  vec4 top = mix(texelFetch(map, i0, 0), texelFetch(map, ivec2(i1.x, i0.y), 0), f.x);
  vec4 bottom = mix(texelFetch(map, ivec2(i0.x, i1.y), 0), texelFetch(map, i1, 0), f.x);
  return mix(top, bottom, f.y);
}

vec3 toLinear(vec3 c) {
  return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(vec3(0.04045), c));
}

vec3 toSrgb(vec3 c) {
  c = clamp(c, 0.0, 1.0);
  return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(vec3(0.0031308), c));
}

void main() {
  vec3 src = texture(u_tex, v_uv).rgb;
  if (v_uv.x < u_split) {
    o_color = vec4(src, 1.0);
    return;
  }
  vec3 lin = toLinear(src);
  vec3 x = u_encoded > 0.5 ? src : lin;
  float green = x.g;
  x.r += u_comp.x * (1.0 - x.r) * green;
  x.b += u_comp.y * (1.0 - x.b) * green;
  if (u_ranged > 0.5) {
    // Position in the range tables: linear between samples, as Correction::lookup in the core.
    float t = clamp(rangeAt(u_rangeRect.xy + v_uv * u_rangeRect.zw), 0.0, 1.0) * 7.0;
    int node = min(int(floor(t)), 6);
    float f = t - float(node);
    for (int ch = 0; ch < 3; ch++) {
      int k = ch * 8 + node;
      float scatter = mix(u_backscatter[k], u_backscatter[k + 1], f);
      float logGain = mix(u_logGain[k], u_logGain[k + 1], f);
      x[ch] = max(x[ch] - scatter, 0.0) * exp(logGain);
    }
  }
  vec3 corrected = max(u_matrix * x + u_offset, 0.0);
  if (u_fusion > 0.5) {
    // Blend a gamma-corrected and a sharpened version, as the fusion step in the core's reference.
    vec2 at = u_rangeRect.xy + v_uv * u_rangeRect.zw;
    vec4 a = fusionAt(u_fusionA, at);
    vec3 blur = fusionAt(u_fusionB, at).rgb;
    vec3 y = clamp(corrected, 0.0, 1.0);
    vec3 first = pow(y, vec3(u_gamma));
    vec3 second = 0.5 * (y + clamp((y - blur - u_sharpen.x) * u_sharpen.y, 0.0, 1.0));
    corrected = max(a.a * first + (1.0 - a.a) * second + a.rgb, 0.0);
  }
  if (u_encoded > 0.5) corrected = toLinear(min(corrected, 1.0));
  // Tone curve: lifts shadows and mid-tones, keeps white; as tone_curve in the core's reference.
  corrected = corrected * u_tone / (1.0 + (u_tone - 1.0) * corrected);
  vec3 v = mix(lin, corrected, u_strength);
  vec3 s = toSrgb(v * u_whiteBalance * u_exposure);
  s = (s - 0.5) * u_contrast + 0.5;
  float luma = dot(s, LUMA);
  s = clamp(luma + (s - luma) * (1.0 + u_saturation), 0.0, 1.0);
  o_color = vec4(s, 1.0);
}`;
