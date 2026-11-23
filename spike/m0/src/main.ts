import type { VideoCodec } from 'mediabunny';
import * as report from './report';
import { codecReport, envReport } from './env';
import { clipTest, syntheticVideoTests } from './video';
import { photoTest, syntheticPhotoTest } from './photo';
import { folderWriteTest } from './files';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const controls = () => Array.from(document.querySelectorAll<HTMLButtonElement | HTMLInputElement | HTMLSelectElement>('button, input, select'));

/** Run one job at a time, keep the screen awake, never leave the UI locked. */
async function run(name: string, job: () => Promise<void>) {
  controls().forEach((c) => { if (!['copy', 'download'].includes(c.id)) c.disabled = true; });
  let lock: any = null;
  try { lock = await (navigator as any).wakeLock?.request('screen'); } catch { /* optional */ }
  const t0 = performance.now();
  try {
    await job();
    report.status(`${name} finished in ${Math.round((performance.now() - t0) / 1000)} s - copy the report below`);
  } catch (e) {
    report.add('Session', name + ' aborted', false, report.errText(e));
    report.status(name + ' failed - see report');
  } finally {
    try { await lock?.release(); } catch { /* ignore */ }
    controls().forEach((c) => (c.disabled = false));
  }
}

report.restore();

$('runAuto').onclick = () => run('Built-in test', async () => {
  report.add('Session', 'built-in test started', null, new Date().toISOString());
  await envReport();
  await codecReport();
  await syntheticVideoTests($<HTMLInputElement>('auto4k').checked);
  await syntheticPhotoTest(4000, 3000, true);
  if ($<HTMLInputElement>('auto48').checked) await syntheticPhotoTest(8000, 6000, false);
});

$<HTMLInputElement>('clipFiles').onchange = (ev) => {
  const input = ev.target as HTMLInputElement;
  const files = Array.from(input.files ?? []);
  if (!files.length) return;
  const codec = $<HTMLSelectElement>('clipCodec').value as VideoCodec;
  const limit = Number($<HTMLSelectElement>('clipLimit').value);
  void run('Video test', async () => { for (const f of files) await clipTest(f, codec, limit); }).then(() => (input.value = ''));
};

$<HTMLInputElement>('photoFiles').onchange = (ev) => {
  const input = ev.target as HTMLInputElement;
  const files = Array.from(input.files ?? []);
  if (!files.length) return;
  void run('Photo test', async () => { for (const f of files) await photoTest(f); }).then(() => (input.value = ''));
};

$('folderTest').onclick = () => run('Folder test', folderWriteTest);

$('copy').onclick = async () => {
  const text = report.text();
  try {
    await navigator.clipboard.writeText(text);
    report.status('Report copied to the clipboard');
  } catch {
    const r = document.createRange();
    r.selectNodeContents($('report'));
    const sel = getSelection()!;
    sel.removeAllRanges(); sel.addRange(r);
    report.status('Could not copy automatically - the report is selected, copy it manually');
  }
};

$('download').onclick = () => {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([report.json()], { type: 'application/json' }));
  a.download = 'uwcc-m0-report.json';
  a.click();
};

$('clear').onclick = () => { report.clear(); $('media').replaceChildren(); report.status('Idle'); };
