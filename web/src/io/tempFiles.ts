// Video exports are written to a temporary file in the browser's private
// storage first. This module names those files and clears leftovers.

export const TEMP_PREFIX = 'uwcc-export-';

/** Remove temporary files left behind by an export that was interrupted (page closed, crash). */
export async function removeStaleTempFiles() {
  try {
    const root = await navigator.storage.getDirectory();
    const names: string[] = [];
    for await (const entry of (root as unknown as { values(): AsyncIterable<FileSystemHandle> }).values()) {
      if (entry.kind === 'file' && entry.name.startsWith(TEMP_PREFIX)) names.push(entry.name);
    }
    await Promise.all(names.map((n) => root.removeEntry(n).catch(() => {})));
  } catch {
    // No private storage: nothing to clean.
  }
}
