// UWCC marks every JPEG it writes with a comment segment, so a result can be
// recognised later even when its name gives no hint (for example an original
// that was replaced in overwrite mode).

import { VERSION } from '../version';

const SIGNATURE = 'UWCC corrected';

const isApp = (marker: number) => marker >= 0xe0 && marker <= 0xef;

/** Insert the comment segment after the leading APPn segments (JFIF/EXIF stay first). */
export function tagJpeg(jpeg: ArrayBuffer): Blob {
  const bytes = new Uint8Array(jpeg);
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return new Blob([jpeg], { type: 'image/jpeg' });
  let pos = 2;
  while (pos + 4 <= bytes.length && bytes[pos] === 0xff && isApp(bytes[pos + 1])) {
    pos += 2 + ((bytes[pos + 2] << 8) | bytes[pos + 3]);
  }
  if (pos > bytes.length) pos = 2;
  // The signature is what is checked for; the version after it records which build wrote the file.
  const text = new TextEncoder().encode(`${SIGNATURE} by UWCC ${VERSION}`);
  const segment = new Uint8Array(4 + text.length);
  segment.set([0xff, 0xfe, (text.length + 2) >> 8, (text.length + 2) & 0xff]);
  segment.set(text, 4);
  return new Blob([bytes.subarray(0, pos), segment, bytes.subarray(pos)], { type: 'image/jpeg' });
}

/** Does this file carry UWCC's comment segment? Reads only the file header. */
export async function isTaggedJpeg(file: Blob): Promise<boolean> {
  const bytes = new Uint8Array(await file.slice(0, 512 * 1024).arrayBuffer());
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return false;
  const decoder = new TextDecoder();
  let pos = 2;
  while (pos + 4 <= bytes.length && bytes[pos] === 0xff) {
    const marker = bytes[pos + 1];
    if (marker === 0xda || marker === 0xd9) break; // image data starts: no more header segments
    const length = (bytes[pos + 2] << 8) | bytes[pos + 3];
    if (length < 2) break;
    if (marker === 0xfe && decoder.decode(bytes.subarray(pos + 4, pos + 2 + length)).startsWith(SIGNATURE)) return true;
    pos += 2 + length;
  }
  return false;
}
