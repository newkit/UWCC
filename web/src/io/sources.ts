// Where files come from. A source may carry a file handle (allows replacing
// the file) and a directory handle (allows writing beside it); both exist
// only in browsers with the File System Access API.

export type Kind = 'photo' | 'video' | 'other';

export type Source = {
  name: string;
  file: File;
  kind: Kind;
  handle?: FileSystemFileHandle;
  dir?: FileSystemDirectoryHandle;
};

const PHOTO = /\.(jpe?g|png|webp|heic|heif|avif|bmp|gif|tiff?)$/i;
const VIDEO = /\.(mp4|mov|m4v|mkv|webm|avi|mts|m2ts|3gp)$/i;

const w = window as unknown as {
  showOpenFilePicker?: (options?: object) => Promise<FileSystemFileHandle[]>;
  showDirectoryPicker?: (options?: object) => Promise<FileSystemDirectoryHandle>;
};

export const fsAccess = {
  files: typeof w.showOpenFilePicker === 'function',
  folders: typeof w.showDirectoryPicker === 'function',
};

export function kindOf(name: string, type: string): Kind {
  if (type.startsWith('image/') || PHOTO.test(name)) return 'photo';
  if (type.startsWith('video/') || VIDEO.test(name)) return 'video';
  return 'other';
}

export function fromFiles(files: Iterable<File>): Source[] {
  return Array.from(files, (file) => ({ name: file.name, file, kind: kindOf(file.name, file.type) }));
}

async function fromHandle(handle: FileSystemFileHandle, dir?: FileSystemDirectoryHandle): Promise<Source> {
  const file = await handle.getFile();
  return { name: file.name, file, kind: kindOf(file.name, file.type), handle, dir };
}

/** Photos and videos directly inside a folder (not in sub-folders), sorted by name. */
export async function fromDirectory(dir: FileSystemDirectoryHandle): Promise<Source[]> {
  const sources: Source[] = [];
  const entries = (dir as unknown as { values(): AsyncIterable<FileSystemHandle> }).values();
  for await (const entry of entries) {
    if (entry.kind !== 'file') continue;
    const source = await fromHandle(entry as FileSystemFileHandle, dir);
    if (source.kind !== 'other') sources.push(source);
  }
  return sources.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
}

const isAbort = (error: unknown) => error instanceof DOMException && error.name === 'AbortError';

/** Returns null when the browser has no file picker with handles; the caller then uses a file input. */
export async function pickFiles(): Promise<Source[] | null> {
  if (!w.showOpenFilePicker) return null;
  try {
    const handles = await w.showOpenFilePicker({
      multiple: true,
      id: 'uwcc-open',
      types: [{
        description: 'Photos and videos',
        accept: { 'image/*': ['.jpg', '.jpeg', '.png', '.webp', '.heic', '.heif', '.avif'], 'video/*': ['.mp4', '.mov', '.m4v', '.mkv', '.webm'] },
      }],
    });
    return Promise.all(handles.map((h) => fromHandle(h)));
  } catch (error) {
    if (isAbort(error)) return [];
    throw error;
  }
}

export async function pickFolder(): Promise<Source[]> {
  if (!w.showDirectoryPicker) return [];
  try {
    return fromDirectory(await w.showDirectoryPicker({ mode: 'readwrite', id: 'uwcc-open' }));
  } catch (error) {
    if (isAbort(error)) return [];
    throw error;
  }
}

/** Ask where results should go. Opens in the folder of `near` when given. */
export async function pickOutputFolder(near?: FileSystemFileHandle): Promise<FileSystemDirectoryHandle | null> {
  if (!w.showDirectoryPicker) return null;
  try {
    return await w.showDirectoryPicker({ mode: 'readwrite', id: 'uwcc-open', ...(near ? { startIn: near } : {}) });
  } catch (error) {
    if (isAbort(error)) return null;
    throw error;
  }
}

/** Files and folders dropped on the page. Keeps handles where the browser provides them. */
export async function fromDrop(data: DataTransfer): Promise<Source[]> {
  type HandleItem = DataTransferItem & { getAsFileSystemHandle?: () => Promise<FileSystemHandle | null> };
  const items = Array.from(data.items) as HandleItem[];
  if (items.some((item) => typeof item.getAsFileSystemHandle === 'function')) {
    // All handles must be requested before the first await; the drop data is gone afterwards.
    const pending = items.filter((item) => item.kind === 'file').map((item) => item.getAsFileSystemHandle!());
    const sources: Source[] = [];
    for (const handle of await Promise.all(pending)) {
      if (!handle) continue;
      if (handle.kind === 'directory') sources.push(...(await fromDirectory(handle as FileSystemDirectoryHandle)));
      else sources.push(await fromHandle(handle as FileSystemFileHandle));
    }
    return sources;
  }
  return fromFiles(data.files);
}
