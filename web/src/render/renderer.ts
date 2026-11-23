import { type Adjustments, shaderValues } from '../model';
import { FRAGMENT, VERTEX } from './shader';

type AnyCanvas = HTMLCanvasElement | OffscreenCanvas;

/** Draws a source image through the correction shader. Used for preview and for export tiles. */
export class CorrectionRenderer {
  readonly canvas: AnyCanvas;
  readonly gl: WebGL2RenderingContext;
  private uniforms: Record<string, WebGLUniformLocation | null> = {};
  private texture: WebGLTexture;

  constructor(canvas: AnyCanvas) {
    const gl = canvas.getContext('webgl2', { alpha: false, antialias: false, preserveDrawingBuffer: true }) as WebGL2RenderingContext | null;
    if (!gl) throw new Error('WebGL2 is not available in this browser.');
    this.canvas = canvas;
    this.gl = gl;

    const program = gl.createProgram()!;
    for (const [type, source] of [[gl.VERTEX_SHADER, VERTEX], [gl.FRAGMENT_SHADER, FRAGMENT]] as const) {
      const shader = gl.createShader(type)!;
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error('Shader compile failed: ' + gl.getShaderInfoLog(shader));
      gl.attachShader(program, shader);
    }
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error('Shader link failed: ' + gl.getProgramInfoLog(program));
    gl.useProgram(program);

    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const pos = gl.getAttribLocation(program, 'a_pos');
    gl.enableVertexAttribArray(pos);
    gl.vertexAttribPointer(pos, 2, gl.FLOAT, false, 0, 0);

    for (const name of ['u_tex', 'u_matrix', 'u_offset', 'u_strength', 'u_whiteBalance', 'u_exposure', 'u_contrast', 'u_saturation', 'u_split']) {
      this.uniforms[name] = gl.getUniformLocation(program, name);
    }
    this.texture = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.uniform1i(this.uniforms.u_tex, 0);
  }

  get maxTextureSize(): number {
    return this.gl.getParameter(this.gl.MAX_TEXTURE_SIZE) as number;
  }

  /** Upload the image to draw and size the canvas to it. */
  setSource(source: TexImageSource, width: number, height: number) {
    const gl = this.gl;
    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = width;
      this.canvas.height = height;
    }
    gl.viewport(0, 0, width, height);
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
  }

  /**
   * @param correction row-major 3x4: rows are [fromR, fromG, fromB, offset]
   * @param split show the original left of this x position (0..1); null turns the split off
   */
  draw(correction: Float32Array, adjustments: Adjustments, split: number | null = null) {
    const gl = this.gl;
    const u = this.uniforms;
    const c = correction;
    // GLSL matrices are column-major.
    gl.uniformMatrix3fv(u.u_matrix, false, new Float32Array([c[0], c[4], c[8], c[1], c[5], c[9], c[2], c[6], c[10]]));
    gl.uniform3f(u.u_offset, c[3], c[7], c[11]);
    const values = shaderValues(adjustments);
    gl.uniform1f(u.u_strength, adjustments.strength);
    gl.uniform3f(u.u_whiteBalance, ...values.whiteBalance);
    gl.uniform1f(u.u_exposure, values.exposure);
    gl.uniform1f(u.u_contrast, values.contrast);
    gl.uniform1f(u.u_saturation, adjustments.saturation);
    gl.uniform1f(u.u_split, split ?? -1);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  /** Read the drawn frame as RGBA, rows bottom-up (as WebGL returns them). */
  readPixels(width: number, height: number, out: Uint8Array) {
    const gl = this.gl;
    gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, out);
    const error = gl.getError();
    if (error) throw new Error('Reading pixels failed (WebGL error ' + error + ').');
  }

  dispose() {
    this.gl.getExtension('WEBGL_lose_context')?.loseContext();
  }
}

/** A canvas that is not attached to the page; OffscreenCanvas where available. */
export function createWorkCanvas(width: number, height: number): AnyCanvas {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(width, height);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  return canvas;
}
