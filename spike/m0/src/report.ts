// Collects results and renders them as plain text the tester can copy back.
export type Entry = { section: string; name: string; ok: boolean | null; data?: unknown };

const KEY = 'uwcc-m0-report';
let entries: Entry[] = [];

/** Results survive a reload, so a tab crash during a heavy step does not lose the report. */
export function restore() {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) ?? '[]') as Entry[];
    if (saved.length) {
      entries = saved;
      entries.push({ section: 'Session', name: 'page was reloaded here - if you did not reload it yourself, the browser killed the page during the step listed just above', ok: null });
    }
  } catch { /* storage unavailable */ }
  render();
}

function persist() {
  try { localStorage.setItem(KEY, JSON.stringify(entries)); } catch { /* storage unavailable */ }
}
const reportEl = () => document.getElementById('report')!;
const statusEl = () => document.getElementById('status')!;

export function status(text: string) {
  statusEl().textContent = text;
}

function fmt(v: unknown): string {
  if (v === undefined) return '';
  if (typeof v === 'string') return v;
  try { return JSON.stringify(v); } catch { return String(v); }
}

export function add(section: string, name: string, ok: boolean | null, data?: unknown) {
  entries.push({ section, name, ok, data });
  persist();
  render();
}

export function text(): string {
  let out = '';
  let last = '';
  for (const e of entries) {
    if (e.section !== last) { out += `\n== ${e.section} ==\n`; last = e.section; }
    const mark = e.ok === null ? '  ' : e.ok ? 'OK' : '!!';
    out += `${mark} ${e.name}${e.data !== undefined ? ': ' + fmt(e.data) : ''}\n`;
  }
  return out.trimStart();
}

export function json(): string {
  return JSON.stringify({ generated: new Date().toISOString(), entries }, null, 1);
}

export function clear() { entries = []; persist(); render(); }

function render() {
  const el = reportEl();
  el.textContent = text();
  el.scrollTop = el.scrollHeight;
}

export function errText(e: unknown): string {
  if (e instanceof Error) return `${e.name}: ${e.message}`;
  return String(e);
}

export function mem(): number | null {
  const m = (performance as any).memory;
  return m ? Math.round(m.usedJSHeapSize / 1048576) : null;
}

export const round = (n: number, d = 1) => Math.round(n * 10 ** d) / 10 ** d;

/** Show a result file (video or image) with a download link. */
export function showMedia(blob: Blob, name: string, kind: 'video' | 'image') {
  const box = document.getElementById('media')!;
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = name; a.textContent = `Download ${name} (${round(blob.size / 1048576)} MB)`;
  box.append(a);
  if (kind === 'video') {
    const v = document.createElement('video');
    v.src = url; v.controls = true; v.muted = true; v.playsInline = true;
    box.append(v);
  } else {
    const i = document.createElement('img');
    i.src = url;
    box.append(i);
  }
}
