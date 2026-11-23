import { type Adjustments, FUSION_AT, RANGE_NODES, shaderValues } from '../model';

/** The maps of the image a correction may need, each in the flat form the core returns. */
export type FrameMaps = { range?: Float32Array; fusion?: Float32Array };
import { FRAGMENT, VERTEX } from './shader';

type AnyCanvas = HTMLCanvasElement | OffscreenCanvas;

/** Draws a source image through the correction shader. Used for preview and for export tiles. */
export class CorrectionRenderer {
  readonly canvas: AnyCanvas;
  readonly gl: WebGL2RenderingContext;
  private uniforms: Record<string, WebGLUniformLocation | null> = {};
  private texture: WebGLTexture;
  private rangeTexture: WebGLTexture;
  private rangeSize: [number, number] = [1, 1];
  private fusionTextures: [WebGLTexture, WebGLTexture];
  private fusionSize: [number, number] | null = null;

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

    for (const name of [
      'u_tex', 'u_encoded', 'u_comp', 'u_ranged', 'u_backscatter', 'u_logGain', 'u_range', 'u_rangeSize', 'u_rangeRect',
      'u_fusion', 'u_gamma', 'u_sharpen', 'u_fusionA', 'u_fusionB', 'u_fusionSize',
      'u_matrix', 'u_offset', 'u_strength', 'u_whiteBalance', 'u_exposure', 'u_contrast', 'u_saturation', 'u_split',
    ]) {
      this.uniforms[name] = gl.getUniformLocation(program, name);
    }
    this.texture = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.uniform1i(this.uniforms.u_tex, 0);

    // The range map lives in texture unit 1; a one-cell map at middle range until a real one is set.
    this.rangeTexture = gl.createTexture()!;
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.rangeTexture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.uniform1i(this.uniforms.u_range, 1);
    // The two fusion maps live in units 2 and 3.
    this.fusionTextures = [gl.createTexture()!, gl.createTexture()!];
    this.fusionTextures.forEach((texture, i) => {
      gl.activeTexture(gl.TEXTURE2 + i);
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, 1, 1, 0, gl.RGBA, gl.FLOAT, new Float32Array(4));
    });
    gl.uniform1i(this.uniforms.u_fusionA, 2);
    gl.uniform1i(this.uniforms.u_fusionB, 3);
    gl.activeTexture(gl.TEXTURE0);
    this.setRange(new Float32Array([1, 1, 0.5]));
  }

  /** Set the maps of the image for corrections that need them. Maps not given keep their previous content. */
  setMaps(maps: FrameMaps) {
    if (maps.range) this.setRange(maps.range);
    if (maps.fusion) this.setFusion(maps.fusion);
  }

  /** Set the fusion maps: width, height, then two blocks of four values per cell (as the core returns them). */
  setFusion(maps: Float32Array) {
    const gl = this.gl;
    const width = maps[0], height = maps[1], block = width * height * 4;
    this.fusionTextures.forEach((texture, i) => {
      gl.activeTexture(gl.TEXTURE2 + i);
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, width, height, 0, gl.RGBA, gl.FLOAT, maps.subarray(2 + i * block, 2 + (i + 1) * block));
    });
    gl.activeTexture(gl.TEXTURE0);
    this.fusionSize = [width, height];
  }

  /** Set the range map for corrections that need one: width, height, then one value per cell (as the core returns it). */
  setRange(map: Float32Array) {
    const gl = this.gl;
    const width = map[0], height = map[1];
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.rangeTexture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R32F, width, height, 0, gl.RED, gl.FLOAT, map.subarray(2, 2 + width * height));
    gl.activeTexture(gl.TEXTURE0);
    this.rangeSize = [width, height];
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
   * @param correction the flat form described at `CORRECTION_LEN`
   * @param split show the original left of this x position (0..1); null turns the split off
   * @param rect the part of the whole image the current source covers, as [x, y, width, height] in 0..1;
   *   needed when drawing tiles, so that each finds its place in the range map
   */
  draw(correction: Float32Array, adjustments: Adjustments, split: number | null = null, rect: [number, number, number, number] = [0, 0, 1, 1]) {
    const gl = this.gl;
    const u = this.uniforms;
    const c = correction;
    // GLSL matrices are column-major.
    gl.uniformMatrix3fv(u.u_matrix, false, new Float32Array([c[0], c[4], c[8], c[1], c[5], c[9], c[2], c[6], c[10]]));
    gl.uniform3f(u.u_offset, c[3], c[7], c[11]);
    gl.uniform1f(u.u_encoded, c[12]);
    gl.uniform2f(u.u_comp, c[13], c[14]);
    const tables = 3 * RANGE_NODES;
    gl.uniform1fv(u.u_backscatter, c.subarray(15, 15 + tables));
    gl.uniform1fv(u.u_logGain, c.subarray(15 + tables, 15 + 2 * tables));
    gl.uniform1f(u.u_ranged, c[15 + 2 * tables]);
    gl.uniform2f(u.u_rangeSize, ...this.rangeSize);
    gl.uniform4f(u.u_rangeRect, ...rect);
    // Without fusion maps the step is skipped, as in the core's reference.
    gl.uniform1f(u.u_fusion, this.fusionSize ? c[FUSION_AT] : 0);
    gl.uniform1f(u.u_gamma, c[FUSION_AT + 1]);
    gl.uniform2f(u.u_sharpen, c[FUSION_AT + 2], c[FUSION_AT + 3]);
    gl.uniform2f(u.u_fusionSize, ...(this.fusionSize ?? [1, 1]));
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
