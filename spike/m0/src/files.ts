import { add, errText } from './report';

/** Can the page create a file beside the user's files, read it back and remove it? */
export async function folderWriteTest() {
  const S = 'Folder write access';
  const pick = (window as any).showDirectoryPicker as undefined | ((o?: object) => Promise<any>);
  if (!pick) { add(S, 'showDirectoryPicker', false, 'not available in this browser - results would go to the download folder'); return; }
  try {
    const dir = await pick({ mode: 'readwrite' });
    let existing = 0;
    for await (const _ of dir.values()) { existing++; if (existing >= 1000) break; }
    const name = 'uwcc_spike_write_test.txt';
    const fh = await dir.getFileHandle(name, { create: true });
    const w = await fh.createWritable();
    await w.write('UWCC spike write test');
    await w.close();
    const back = await (await fh.getFile()).text();
    await dir.removeEntry(name);
    add(S, 'create, read back, delete a file in the chosen folder', back === 'UWCC spike write test', { entriesSeen: existing });
  } catch (e) {
    add(S, 'folder write', false, errText(e));
  }
}
