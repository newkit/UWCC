import encodeJpeg from '@jsquash/jpeg/encode';
import { add, errText, mem, round, showMedia, status } from './report';
import { Renderer } from './gl';

const TILE = 2048;

type TileDraw = (r: Renderer, x: number, y: number, w: number, h: number) => void | Promise<void>;

/** Render the image tile by tile on the GPU, collect the pixels, encode one JPEG in WASM. */
async function exportTiled(W: number, H: number, draw: TileDraw) {
  const t0 = performance.now();
  const big = new Uint8ClampedArray(W * H * 4); // throws RangeError if the device cannot allocate it
  const r = new Renderer(TILE, TILE);
  const tile = new Uint8Array(TILE * TILE * 4);
  let tiles = 0;
  for (let y = 0; y < H; y += TILE) {
    for (let x = 0; x < W; x += TILE) {
      const w = Math.min(TILE, W - x), h = Math.min(TILE, H - y);
      await draw(r, x, y, w, h);
      const px = tile.subarray(0, w * h * 4);
      r.read(w, h, px);
      for (let j = 0; j < h; j++) { // readPixels returns rows bottom-up
        big.set(px.subarray(j * w * 4, (j + 1) * w * 4), ((y + h - 1 - j) * W + x) * 4);
      }
      tiles++;
    }
    status(`Photo: rendering ${Math.round((100 * Math.min(H, y + TILE)) / H)} %`);
    await new Promise((res) => setTimeout(res)); // let the UI breathe
  }
  r.dispose();
  const t1 = performance.now();
  status('Photo: encoding JPEG');
  await new Promise((res) => setTimeout(res, 30));
  const jpeg = await encodeJpeg({ data: big, width: W, height: H } as unknown as ImageData, { quality: 90, progressive: false, optimize_coding: false });
  const t2 = performance.now();
  return { blob: new Blob([jpeg], { type: 'image/jpeg' }), tiles, renderSec: (t1 - t0) / 1000, encodeSec: (t2 - t1) / 1000 };
}

export async function syntheticPhotoTest(W: number, H: number, show: boolean) {
  const S = 'Photo (built-in synthetic image)';
  const label = `${round((W * H) / 1e6)} MP ${W}x${H}`;
  status('Photo: ' + label);
  add(S, label + ' starting', null);
  try {
    const res = await exportTiled(W, H, (r, x, y, w, h) => r.drawPattern(w, h, 0.5, [x / W, y / H, w / W, h / H]));
    const bmp = await createImageBitmap(res.blob).then((b) => { const ok = b.width === W && b.height === H; b.close(); return ok; }).catch(() => null);
    add(S, label, true, { tiles: res.tiles, renderSec: round(res.renderSec, 2), encodeSec: round(res.encodeSec, 2), outMB: round(res.blob.size / 1048576), browserCanReopen: bmp, heapMB: mem() });
    if (show) showMedia(res.blob, `synthetic_${W}x${H}.jpg`, 'image');
  } catch (e) {
    add(S, label, false, errText(e));
  }
}

export async function photoTest(file: File) {
  const S = 'Photo (your photos)';
  const label = file.name;
  status('Photo: ' + label);
  add(S, label + ' starting', null, { sizeMB: round(file.size / 1048576), type: file.type || 'unknown' });
  let bitmap: ImageBitmap | null = null;
  try {
    const t0 = performance.now();
    try {
      bitmap = await createImageBitmap(file);
    } catch (e) {
      add(S, label, false, 'browser could not decode this file: ' + errText(e));
      return;
    }
    const decodeSec = (performance.now() - t0) / 1000;
    const W = bitmap.width, H = bitmap.height;
    const src = bitmap;
    const res = await exportTiled(W, H, async (r, x, y, w, h) => {
      const crop = await createImageBitmap(src, x, y, w, h);
      r.drawSource(crop, w, h);
      crop.close();
    });
    add(S, label, true, { mp: round((W * H) / 1e6), size: `${W}x${H}`, decodeSec: round(decodeSec, 2), tiles: res.tiles, renderSec: round(res.renderSec, 2), encodeSec: round(res.encodeSec, 2), outMB: round(res.blob.size / 1048576), heapMB: mem() });
    showMedia(res.blob, file.name.replace(/\.[^.]+$/, '') + '_uwcc_spike.jpg', 'image');
  } catch (e) {
    add(S, label, false, errText(e));
  } finally {
    bitmap?.close();
  }
}
