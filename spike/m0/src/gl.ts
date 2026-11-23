// Minimal WebGL2 renderer: applies a fixed colour matrix, standing in for the real correction shader.

const VS = `#version 300 es
in vec2 p;
out vec2 uv;
void main() {
  uv = vec2(p.x * 0.5 + 0.5, 0.5 - p.y * 0.5); // image top-left at canvas top-left
  gl_Position = vec4(p, 0.0, 1.0);
}`;

const FS = `#version 300 es
precision highp float;
in vec2 uv;
out vec4 o;
uniform sampler2D tex;
uniform int mode;        // 0 = sample texture, 1 = procedural pattern
uniform vec4 region;     // procedural: x, y, w, h of this tile in the full image (0..1)
uniform float time;
uniform mat3 m;
uniform vec3 off;
vec3 pattern(vec2 q) {
  float t = time;
  vec3 c = vec3(0.02, 0.35 + 0.25 * sin(q.x * 40.0 + t * 3.0), 0.75 + 0.2 * cos(q.y * 30.0 - t * 2.0));
  float d = length(q - vec2(0.5 + 0.3 * sin(t), 0.5 + 0.3 * cos(t * 1.3)));
  c += vec3(0.0, 0.3, 0.2) * smoothstep(0.25, 0.0, d);
  c += 0.06 * fract(sin(dot(floor(q * 900.0), vec2(12.9898, 78.233)) + t) * 43758.5453); // fine detail
  return c;
}
void main() {
  vec3 c = mode == 0 ? texture(tex, uv).rgb : pattern(region.xy + uv * region.zw);
  o = vec4(clamp(m * c + off, 0.0, 1.0), 1.0);
}`;

export type GLInfo = { maxTextureSize: number; maxRenderbufferSize: number; maxViewport: number[]; renderer: string; offscreen: boolean };

export class Renderer {
  canvas: OffscreenCanvas | HTMLCanvasElement;
  gl: WebGL2RenderingContext;
  private u: Record<string, WebGLUniformLocation | null> = {};
  private tex: WebGLTexture;
  offscreen: boolean;

  constructor(width: number, height: number, opts: { identity?: boolean } = {}) {
    let canvas: OffscreenCanvas | HTMLCanvasElement | null = null;
    let gl: WebGL2RenderingContext | null = null;
    this.offscreen = false;
    if (typeof OffscreenCanvas !== 'undefined') {
      canvas = new OffscreenCanvas(width, height);
      gl = canvas.getContext('webgl2', { alpha: false, antialias: false, preserveDrawingBuffer: true }) as WebGL2RenderingContext | null;
      this.offscreen = !!gl;
    }
    if (!gl) {
      canvas = document.createElement('canvas');
      canvas.width = width; canvas.height = height;
      gl = canvas.getContext('webgl2', { alpha: false, antialias: false, preserveDrawingBuffer: true }) as WebGL2RenderingContext | null;
    }
    if (!gl || !canvas) throw new Error('WebGL2 not available');
    this.canvas = canvas; this.gl = gl;

    const prog = gl.createProgram()!;
    for (const [type, src] of [[gl.VERTEX_SHADER, VS], [gl.FRAGMENT_SHADER, FS]] as const) {
      const s = gl.createShader(type)!;
      gl.shaderSource(s, src); gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error('shader: ' + gl.getShaderInfoLog(s));
      gl.attachShader(prog, s);
    }
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error('link: ' + gl.getProgramInfoLog(prog));
    gl.useProgram(prog);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(prog, 'p');
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    for (const n of ['tex', 'mode', 'region', 'time', 'm', 'off']) this.u[n] = gl.getUniformLocation(prog, n);

    this.tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.uniform1i(this.u.tex, 0);

    // Column-major. Roughly the measured correction: red rebuilt from green minus some blue, blue reduced.
    const m = opts.identity
      ? [1, 0, 0, 0, 1, 0, 0, 0, 1]
      : [0.05, 0, 0, 1.6, 1.0, 0.05, -0.13, 0.03, 0.42];
    gl.uniformMatrix3fv(this.u.m, false, new Float32Array(m));
    gl.uniform3f(this.u.off, 0, opts.identity ? 0 : -0.012, opts.identity ? 0 : -0.03);
  }

  info(): GLInfo {
    const gl = this.gl;
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    return {
      maxTextureSize: gl.getParameter(gl.MAX_TEXTURE_SIZE),
      maxRenderbufferSize: gl.getParameter(gl.MAX_RENDERBUFFER_SIZE),
      maxViewport: Array.from(gl.getParameter(gl.MAX_VIEWPORT_DIMS) as Int32Array),
      renderer: ext ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)) : String(gl.getParameter(gl.RENDERER)),
      offscreen: this.offscreen,
    };
  }

  resize(w: number, h: number) {
    if (this.canvas.width !== w || this.canvas.height !== h) { this.canvas.width = w; this.canvas.height = h; }
    this.gl.viewport(0, 0, w, h);
  }

  /** Draw an image/video frame through the colour matrix. */
  drawSource(src: TexImageSource, w: number, h: number) {
    const gl = this.gl;
    this.resize(w, h);
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src);
    gl.uniform1i(this.u.mode, 0);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  /** Draw a generated test pattern; region selects a tile of the full image. */
  drawPattern(w: number, h: number, time: number, region: [number, number, number, number] = [0, 0, 1, 1]) {
    const gl = this.gl;
    this.resize(w, h);
    gl.uniform1i(this.u.mode, 1);
    gl.uniform1f(this.u.time, time);
    gl.uniform4f(this.u.region, ...region);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  /** Read back the current frame, rows top to bottom. */
  read(w: number, h: number, out: Uint8Array) {
    const gl = this.gl;
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, out);
    const err = gl.getError();
    if (err) throw new Error('readPixels GL error ' + err);
  }

  dispose() {
    this.gl.getExtension('WEBGL_lose_context')?.loseContext();
  }
}
