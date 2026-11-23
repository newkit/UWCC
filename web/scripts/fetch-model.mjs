// Fetches the depth model the app serves from its own origin (it is too
// large for the repository). Pinned to one revision and checked by hash, so
// every build ships the same file. Run by `npm run dev` and `npm run build`.

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REVISION = '4472b7362082ad9968fee890ca0f1e5aca36b93d';
const SOURCE = `https://huggingface.co/onnx-community/depth-anything-v2-small/resolve/${REVISION}/onnx/model_quantized.onnx`;
const SHA256 = 'fcf51f1b230362b28690bb9d1809bf0431f29cad20534e3f589bd7285547f20d';
const target = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'models', 'depth-anything-v2-small-q8.onnx');

const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');

if (existsSync(target) && hash(readFileSync(target)) === SHA256) {
  console.log('Depth model is in place.');
} else {
  console.log('Fetching the depth model (27 MB)...');
  const response = await fetch(SOURCE);
  if (!response.ok) throw new Error(`Download failed: ${response.status} ${response.statusText}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (hash(bytes) !== SHA256) throw new Error('The downloaded depth model does not match the expected hash.');
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, bytes);
  console.log('Depth model saved.');
}
