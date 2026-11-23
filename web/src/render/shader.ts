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
uniform mat3 u_matrix;       // automatic correction, linear light
uniform vec3 u_offset;
uniform float u_strength;    // 0 = original, 1 = full correction
uniform vec3 u_whiteBalance; // channel gains
uniform float u_exposure;    // multiplier
uniform float u_contrast;    // multiplier around mid grey
uniform float u_saturation;  // -1 .. 1
uniform float u_split;       // show the original left of this x (0..1); negative = off

const vec3 LUMA = vec3(0.2126, 0.7152, 0.0722);

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
  vec3 corrected = max(u_matrix * lin + u_offset, 0.0);
  vec3 v = mix(lin, corrected, u_strength);
  vec3 s = toSrgb(v * u_whiteBalance * u_exposure);
  s = (s - 0.5) * u_contrast + 0.5;
  float luma = dot(s, LUMA);
  s = clamp(luma + (s - luma) * (1.0 + u_saturation), 0.0, 1.0);
  o_color = vec4(s, 1.0);
}`;
