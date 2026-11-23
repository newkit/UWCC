// Decodes a photo into the copies the app works with: a preview for the
// editor and a small one for the automatic analysis. The full-resolution
// pixels are decoded again at export, so they do not sit in memory meanwhile.

const PREVIEW_MAX = 2560;
const ANALYSIS_MAX = 256;

export type LoadedPhoto = {
  file: Blob;
  name: string;
  width: number;
  height: number;
  preview: HTMLCanvasElement;
};

function scaled(source: ImageBitmap, maxSide: number): HTMLCanvasElement {
  const scale = Math.min(1, maxSide / Math.max(source.width, source.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(source.width * scale));
  canvas.height = Math.max(1, Math.round(source.height * scale));
  const ctx = canvas.getContext('2d')!;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
  return canvas;
}

/** RGBA pixels of a small copy, for the automatic analysis. */
function analysisCopy(source: CanvasImageSource, width: number, height: number): { pixels: Uint8Array; width: number; height: number } {
  const scale = Math.min(1, ANALYSIS_MAX / Math.max(width, height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(width * scale));
  canvas.height = Math.max(1, Math.round(height * scale));
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
  const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
  return { pixels: new Uint8Array(data.buffer.slice(0)), width: canvas.width, height: canvas.height };
}

async function decode(file: Blob, name: string): Promise<ImageBitmap> {
  try {
    return await createImageBitmap(file);
  } catch {
    throw new Error(`This browser cannot open "${name}". Try a JPEG or PNG file.`);
  }
}

/** Everything the editor needs for one photo. */
export async function loadPhoto(file: Blob, name: string): Promise<LoadedPhoto> {
  const bitmap = await decode(file, name);
  try {
    const preview = scaled(bitmap, PREVIEW_MAX);
    return { file, name, width: bitmap.width, height: bitmap.height, preview };
  } finally {
    bitmap.close();
  }
}

/**
 * The small copy the automatic analysis runs on. Every photo is analysed
 * through this one path, so the editor and a batch run give the same result.
 */
export async function loadAnalysisCopy(file: Blob, name: string) {
  const bitmap = await decode(file, name);
  try {
    const mid = scaled(bitmap, 1024);
    return { ...analysisCopy(mid, mid.width, mid.height), sourceWidth: bitmap.width, sourceHeight: bitmap.height };
  } finally {
    bitmap.close();
  }
}
