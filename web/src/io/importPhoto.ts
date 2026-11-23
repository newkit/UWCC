// Decodes a photo and prepares the two copies the editor needs: a preview
// for the screen and a small one for analysis. The full-resolution pixels
// are decoded again at export, so they do not sit in memory while editing.

const PREVIEW_MAX = 2560;
const ANALYSIS_MAX = 256;

export type LoadedPhoto = {
  file: Blob;
  name: string;
  width: number;
  height: number;
  preview: HTMLCanvasElement;
  analysisPixels: Uint8Array;
};

function scaled(source: ImageBitmap, maxSide: number): HTMLCanvasElement {
  const scale = Math.min(1, maxSide / Math.max(source.width, source.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(source.width * scale));
  canvas.height = Math.max(1, Math.round(source.height * scale));
  const ctx = canvas.getContext('2d', { willReadFrequently: maxSide <= ANALYSIS_MAX })!;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
  return canvas;
}

export async function loadPhoto(file: Blob, name: string): Promise<LoadedPhoto> {
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    throw new Error(`This browser cannot open "${name}". Try a JPEG or PNG file.`);
  }
  try {
    const preview = scaled(bitmap, PREVIEW_MAX);
    // Downscale in two steps from the preview: cheaper, and averages better than one big jump.
    const small = document.createElement('canvas');
    const scale = Math.min(1, ANALYSIS_MAX / Math.max(preview.width, preview.height));
    small.width = Math.max(1, Math.round(preview.width * scale));
    small.height = Math.max(1, Math.round(preview.height * scale));
    const ctx = small.getContext('2d', { willReadFrequently: true })!;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(preview, 0, 0, small.width, small.height);
    const data = ctx.getImageData(0, 0, small.width, small.height).data;
    return {
      file, name, width: bitmap.width, height: bitmap.height, preview,
      analysisPixels: new Uint8Array(data.buffer.slice(0)),
    };
  } finally {
    bitmap.close();
  }
}
