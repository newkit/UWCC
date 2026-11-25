// Where results go (SPECIFICATION.md §7): beside the source, replacing the
// source, or, when neither is possible, the photo library on iOS
// (`photos.ts`) and the browser's download folder elsewhere.

import type { OutputMode } from '../settings/settings';
import { photoLibrary } from './photos';
import type { Source } from './sources';

export type WriteResult = {
  kind: 'folder' | 'replaced' | 'download' | 'photos';
  /** Human-readable place of the result. */
  location: string;
  /** Set when the requested mode could not be honoured for this item. */
  note?: string;
  /** For `photos`: the result, waiting to be saved through the share sheet (`io/photos.ts`). */
  pending?: File;
};

type Permissioned = { queryPermission?: (o: object) => Promise<PermissionState>; requestPermission?: (o: object) => Promise<PermissionState> };

/** True when the handle may be written to, asking the user if needed. */
export async function ensureWritable(handle: FileSystemHandle): Promise<boolean> {
  const h = handle as unknown as Permissioned;
  if (!h.queryPermission) return true; // e.g. the origin-private file system: always writable
  try {
    if ((await h.queryPermission({ mode: 'readwrite' })) === 'granted') return true;
    return (await h.requestPermission?.({ mode: 'readwrite' })) === 'granted';
  } catch {
    return false;
  }
}

async function exists(dir: FileSystemDirectoryHandle, name: string): Promise<boolean> {
  try {
    await dir.getFileHandle(name);
    return true;
  } catch {
    return false;
  }
}

/** `a_uwcc.jpg`, then `a_uwcc-2.jpg`, ...: an existing file is never replaced silently. */
async function freeName(dir: FileSystemDirectoryHandle, name: string): Promise<string> {
  if (!(await exists(dir, name))) return name;
  const dot = name.lastIndexOf('.');
  const [base, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ''];
  for (let n = 2; n < 10_000; n++) {
    const candidate = `${base}-${n}${ext}`;
    if (!(await exists(dir, candidate))) return candidate;
  }
  throw new Error('Could not find a free file name.');
}

async function writeFile(handle: FileSystemFileHandle, blob: Blob) {
  // The browser writes to a temporary file and swaps it in on close, so a
  // failed or interrupted write leaves the existing file untouched.
  const writable = await handle.createWritable();
  try {
    await writable.write(blob);
    await writable.close();
  } catch (error) {
    await writable.abort().catch(() => {});
    throw error;
  }
}

export function downloadBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

export type OutputFormat = 'jpg' | 'mp4';

/** `GOPR0042.JPG` -> `GOPR0042_uwcc.jpg` */
export function outputName(sourceName: string, suffix: string, format: OutputFormat = 'jpg'): string {
  return `${sourceName.replace(/\.[^./\\]+$/, '')}${suffix}.${format}`;
}

/** Does this name look like a result UWCC wrote earlier (`x_uwcc.jpg`, `x_uwcc-2.jpg`)? */
export function isProcessedName(name: string, suffix: string): boolean {
  const base = name.replace(/\.[^./\\]+$/, '');
  const escaped = suffix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`${escaped}(-\\d+)?$`, 'i').test(base);
}

/** Can a result in `format` take the place of a file with this name? */
const sameFormat = (name: string, format: OutputFormat) => (format === 'jpg' ? /\.jpe?g$/i : /\.(mp4|m4v)$/i).test(name);

/**
 * Deliver one result.
 * @param fallbackDir folder chosen by the user for sources that have no folder of their own
 */
export async function deliver(
  source: Source,
  blob: Blob,
  options: { mode: OutputMode; suffix: string; fallbackDir: FileSystemDirectoryHandle | null; format?: OutputFormat },
): Promise<WriteResult> {
  let note: string | undefined;
  const format = options.format ?? 'jpg';

  if (options.mode === 'overwrite') {
    if (!source.handle) {
      note = 'This browser gave no write access to the original, so it was not replaced.';
    } else if (!sameFormat(source.name, format)) {
      note = `The original is not ${format === 'jpg' ? 'a JPEG' : 'an MP4'} file, so it was kept and the result saved as a new file.`;
    } else if (!(await ensureWritable(source.handle))) {
      note = 'Write access to the original was not granted, so it was not replaced.';
    } else {
      await writeFile(source.handle, blob);
      return { kind: 'replaced', location: source.name };
    }
  }

  const name = outputName(source.name, options.suffix, format);
  const dir = source.dir ?? options.fallbackDir;
  if (dir && (await ensureWritable(dir))) {
    const finalName = await freeName(dir, name);
    await writeFile(await dir.getFileHandle(finalName, { create: true }), blob);
    return { kind: 'folder', location: `${dir.name}/${finalName}`, note };
  }
  if (photoLibrary) {
    const file = new File([blob], name, { type: format === 'jpg' ? 'image/jpeg' : 'video/mp4' });
    return { kind: 'photos', location: 'Waiting for “Save to Photos”', note, pending: file };
  }
  downloadBlob(blob, name);
  return { kind: 'download', location: `Downloads/${name}`, note };
}
