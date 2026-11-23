import { useCallback, useEffect, useRef, useState } from 'react';
import { alreadyCorrected, createJob, isCancel, type Job, prepare, process, renderThumb, thumbKey } from '../batch/queue';
import { fromDirectory, fromDrop, fromFiles, fsAccess, pickFiles, pickFolder, pickOutputFolder, type Source } from '../io/sources';
import type { Adjustments, Algorithm } from '../model';
import { type Settings, useSettings } from '../settings/settings';
import { removeStaleTempFiles } from '../io/tempFiles';
import { EditorView } from './EditorView';
import { QueueView, type RunState } from './QueueView';
import { SettingsDialog } from './SettingsDialog';
import turtleUrl from '../../../testdata/photos/turtle_before.jpg?url';
import coralUrl from '../../../testdata/photos/coral_before.jpg?url';
import dolphinsUrl from '../../../testdata/photos/dolphins_before.jpg?url';
import flashUrl from '../../../testdata/photos/coral_flash.jpg?url';

const SAMPLES = [
  { label: 'Turtle', name: 'turtle.jpg', url: turtleUrl },
  { label: 'Coral', name: 'coral.jpg', url: coralUrl },
  { label: 'Dolphins', name: 'dolphins.jpg', url: dolphinsUrl },
  { label: 'Coral with flash', name: 'coral_flash.jpg', url: flashUrl },
];

const text = (error: unknown) => (error instanceof Error ? error.message : String(error));
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** Tell the user, before anything is written, where results will go. */
function describeDestination(jobs: Job[], settings: Settings): string {
  const targets = jobs.filter((j) => ['ready', 'analyzing', 'done', 'failed', 'running'].includes(j.status));
  if (targets.length === 0) return '';
  const withDir = targets.filter((j) => j.source.dir);
  const withHandle = targets.filter((j) => j.source.handle);
  const next =
    withDir.length === targets.length
      ? `saved next to the originals in "${withDir[0].source.dir!.name}"`
      : fsAccess.folders && targets.every((j) => j.source.dir || j.source.handle)
        ? 'saved to a folder you choose when you start (the originals\' folder is suggested)'
        : 'saved to this browser\'s download folder';
  if (settings.outputMode === 'overwrite') {
    if (withHandle.length === 0) return `Originals cannot be replaced here; results are ${next}.`;
    return `JPEG photos and MP4 videos are replaced. Other results are ${next}.`;
  }
  return `Results are ${next}, with "${settings.suffix}" added to the name.`;
}

export function App() {
  const [jobs, setJobs] = useState<Job[]>([]);
  const [editing, setEditing] = useState<number | null>(null);
  const [run, setRun] = useState<RunState | null>(null);
  const [settings, setSettings] = useSettings();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [confirm, setConfirm] = useState<number[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [opening, setOpening] = useState(false);
  const [dragOver, setDragOver] = useState(false);

  const fileInput = useRef<HTMLInputElement>(null);
  const jobsRef = useRef(jobs);
  jobsRef.current = jobs;
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const prepChain = useRef<Promise<void>>(Promise.resolve());
  const abort = useRef<AbortController | null>(null);
  /** Ids of jobs taken out of the queue; their pending analysis is dropped. */
  const removed = useRef(new Set<number>());

  const patch = useCallback((id: number, change: Partial<Job>) => {
    setJobs((list) => list.map((job) => (job.id === id ? { ...job, ...change } : job)));
  }, []);

  const addSources = useCallback((sources: Source[]) => {
    if (sources.length === 0) return;
    setError(null);
    setNotice(null);
    const created = sources.map((source) => createJob(source, settingsRef.current));
    const wasEmpty = jobsRef.current.length === 0;
    setJobs((list) => [...list, ...created]);
    if (wasEmpty && created.length === 1 && created[0].status === 'analyzing') setEditing(created[0].id);
    // Analyse one at a time in the background.
    for (const job of created) {
      if (job.status !== 'analyzing') continue;
      prepChain.current = prepChain.current.then(async () => {
        if (removed.current.has(job.id)) return;
        try {
          if (settingsRef.current.skipProcessed && (await alreadyCorrected(job.source))) {
            patch(job.id, { status: 'skipped', message: 'Already corrected by UWCC.' });
            return;
          }
          patch(job.id, { ...(await prepare(job.source, job.algorithm)), status: 'ready' });
        } catch (e) {
          patch(job.id, { status: 'unsupported', message: text(e) });
        }
      });
    }
  }, [patch]);

  const guarded = async (action: () => Promise<Source[] | null>) => {
    setOpening(true);
    try {
      const sources = await action();
      if (sources === null) fileInput.current?.click();
      else addSources(sources);
    } catch (e) {
      setError(text(e));
    } finally {
      setOpening(false);
    }
  };

  const openSample = (sample: (typeof SAMPLES)[number]) => guarded(async () => {
    const response = await fetch(sample.url);
    if (!response.ok) throw new Error('The sample photo could not be loaded.');
    return fromFiles([new File([await response.blob()], sample.name, { type: 'image/jpeg' })]);
  });

  /** Process the given jobs one after another. */
  const start = useCallback(async (ids: number[], confirmed = false) => {
    if (abort.current) return;
    const current = settingsRef.current;
    // Photos first, so quick results appear early; then videos.
    const targets = jobsRef.current
      .filter((j) => ids.includes(j.id) && j.analysis)
      .sort((a, b) => Number(!!a.video) - Number(!!b.video));
    if (targets.length === 0) return;
    if (current.outputMode === 'overwrite' && !confirmed && targets.some((j) => j.source.handle)) {
      setConfirm(ids);
      return;
    }
    setError(null);
    setNotice(null);

    // Sources picked as single files have no folder of their own: ask once, before any work.
    let fallbackDir: FileSystemDirectoryHandle | null = null;
    const orphan = targets.find((j) => j.source.handle && !j.source.dir);
    if (orphan && current.outputMode === 'next') {
      try {
        fallbackDir = await pickOutputFolder(orphan.source.handle);
      } catch (e) {
        setError(text(e));
        return;
      }
      if (!fallbackDir) {
        setNotice('No folder was chosen, so nothing was processed.');
        return;
      }
    }

    const controller = new AbortController();
    abort.current = controller;
    let wakeLock: { release(): Promise<void> } | null = null;
    try {
      wakeLock = await (navigator as unknown as { wakeLock?: { request(type: string): Promise<{ release(): Promise<void> }> } }).wakeLock?.request('screen') ?? null;
    } catch { /* optional */ }

    const single = targets.length === 1;
    let finished = 0;
    if (!single) setRun({ active: true, total: targets.length, finished, cancelled: false });
    for (const job of targets) {
      if (controller.signal.aborted) break;
      patch(job.id, { status: 'running', progress: 0, message: undefined, result: undefined });
      try {
        // Read the job again: adjustments may have changed since the run was requested.
        const fresh = jobsRef.current.find((j) => j.id === job.id) ?? job;
        const result = await process(fresh, current, fallbackDir, (progress) => patch(job.id, { progress }), controller.signal);
        patch(job.id, { status: 'done', result, progress: 1 });
        if (single) setNotice(result.kind === 'replaced' ? `Replaced ${result.location}.` : `Saved as ${result.location}.${result.note ? ' ' + result.note : ''}`);
      } catch (e) {
        if (isCancel(e)) {
          patch(job.id, { status: 'ready', progress: undefined });
          break;
        }
        patch(job.id, { status: 'failed', message: text(e) });
        if (single) setError(`${job.source.name}: ${text(e)}`);
      }
      finished++;
      if (!single) setRun({ active: true, total: targets.length, finished, cancelled: false });
    }
    if (!single) setRun({ active: false, total: targets.length, finished, cancelled: controller.signal.aborted });
    abort.current = null;
    try { await wakeLock?.release(); } catch { /* ignore */ }
  }, [patch]);

  // Drop files or folders anywhere on the page.
  useEffect(() => {
    const over = (e: DragEvent) => { if (e.dataTransfer?.types.includes('Files')) { e.preventDefault(); setDragOver(true); } };
    const leave = (e: DragEvent) => { if (!e.relatedTarget) setDragOver(false); };
    const drop = (e: DragEvent) => {
      e.preventDefault();
      setDragOver(false);
      if (e.dataTransfer) fromDrop(e.dataTransfer).then(addSources).catch((err) => setError(text(err)));
    };
    window.addEventListener('dragover', over);
    window.addEventListener('dragleave', leave);
    window.addEventListener('drop', drop);
    return () => {
      window.removeEventListener('dragover', over);
      window.removeEventListener('dragleave', leave);
      window.removeEventListener('drop', drop);
    };
  }, [addSources]);

  useEffect(() => { void removeStaleTempFiles(); }, []);

  // Thumbnails show the method and adjustments of their file. They are rendered
  // again when those change, but not for the file being edited until it is left.
  const thumbsPending = useRef(new Set<string>());
  useEffect(() => {
    for (const job of jobs) {
      const key = thumbKey(job);
      const tag = `${job.id}/${key}`;
      if (!job.thumbSource || job.id === editing || job.thumbKey === key || thumbsPending.current.has(tag)) continue;
      thumbsPending.current.add(tag);
      prepChain.current = prepChain.current.then(async () => {
        try {
          if (!removed.current.has(job.id)) patch(job.id, { thumb: await renderThumb(job), thumbKey: key });
        } catch {
          // The previous thumbnail stays.
        } finally {
          thumbsPending.current.delete(tag);
        }
      });
    }
  }, [jobs, editing, patch]);

  // Hook for automated tests: add a folder without going through the system picker.
  useEffect(() => {
    (window as unknown as { uwccTest?: object }).uwccTest = {
      addDirectory: async (dir: FileSystemDirectoryHandle) => addSources(await fromDirectory(dir)),
    };
  }, [addSources]);

  const editingJob = jobs.find((j) => j.id === editing) ?? null;
  const running = jobs.some((j) => j.status === 'running');
  const active = !!run?.active;
  const readyIds = jobs.filter((j) => j.status === 'ready').map((j) => j.id);
  const overwrite = settings.outputMode === 'overwrite' && jobs.some((j) => j.source.handle);
  const noun = jobs.some((j) => j.source.kind === 'video') ? 'file' : 'photo';
  const startLabel = overwrite ? `Replace ${plural(readyIds.length, 'original')}` : `Correct ${plural(readyIds.length, noun)}`;
  const busy = editingJob?.status === 'running'
    ? editingJob.video
      ? `Correcting… ${Math.round((editingJob.progress ?? 0) * 100)}%`
      : (editingJob.progress ?? 0) < 0.7 ? `Correcting… ${Math.round(((editingJob.progress ?? 0) / 0.7) * 100)}%` : 'Encoding and saving…'
    : null;

  const remove = (ids: number[]) => {
    ids.forEach((id) => removed.current.add(id));
    setJobs((list) => list.filter((j) => !ids.includes(j.id)));
  };
  const clearAll = () => { remove(jobs.map((j) => j.id)); setEditing(null); setRun(null); setNotice(null); setError(null); };
  const applyToAll = (algorithm: Algorithm, adjustments: Adjustments) => {
    setJobs((list) => list.map((job) => ({ ...job, algorithm, adjustments })));
    setNotice(`Method and adjustments applied to all ${jobs.length} files.`);
  };

  return (
    <div className={'app' + (dragOver ? ' drag-over' : '')}>
      <header>
        <h1>UWCC <span>UnderWater Color Correction</span></h1>
        <div className="actions">
          {editingJob && jobs.length > 1 && <button type="button" className="ghost" onClick={() => setEditing(null)} disabled={running}>Back to list</button>}
          {jobs.length > 0 && !editingJob && <button type="button" className="ghost" onClick={clearAll} disabled={active}>Clear</button>}
          {jobs.length > 0 && <button type="button" className="ghost" onClick={() => guarded(pickFiles)} disabled={active || running || opening}>Add</button>}
          <button type="button" className="ghost" onClick={() => setSettingsOpen(true)} disabled={active || running}>Settings</button>
          {editingJob && (
            <button type="button" className="primary" onClick={() => start([editingJob.id])} disabled={running || !editingJob.analysis}>
              {settings.outputMode === 'overwrite' && editingJob.source.handle ? 'Replace original' : 'Save'}
            </button>
          )}
        </div>
      </header>

      <input
        ref={fileInput}
        type="file"
        accept="image/*,video/*"
        multiple
        hidden
        onChange={(e) => {
          addSources(fromFiles(e.target.files ?? []));
          e.target.value = '';
        }}
      />

      {error && <div className="banner error" role="alert"><span>{error}</span><button type="button" onClick={() => setError(null)} aria-label="Dismiss">×</button></div>}
      {notice && <div className="banner" role="status"><span>{notice}</span><button type="button" onClick={() => setNotice(null)} aria-label="Dismiss">×</button></div>}

      {jobs.length === 0 ? (
        <main className="welcome">
          <div className="welcome-card">
            <h2>Bring the colour back to your underwater photos and videos</h2>
            <p>Open one file to fine-tune it, or many to correct them all in one go. Everything happens on this device; nothing is uploaded.</p>
            <div className="welcome-buttons">
              <button type="button" className="primary big" onClick={() => guarded(pickFiles)} disabled={opening}>Open photos or videos</button>
              {fsAccess.folders && <button type="button" className="ghost big" onClick={() => guarded(pickFolder)} disabled={opening}>Open a folder</button>}
            </div>
            <p className="hint">or drop files{fsAccess.folders ? ' or a folder' : ''} anywhere on this page</p>
            <div className="samples">
              <span>Try a sample:</span>
              {SAMPLES.map((s) => (
                <button type="button" className="ghost" key={s.name} onClick={() => openSample(s)} disabled={opening}>{s.label}</button>
              ))}
            </div>
          </div>
        </main>
      ) : editingJob ? (
        <EditorView
          job={editingJob}
          multiple={jobs.length > 1}
          busy={busy}
          onChange={(adjustments) => patch(editingJob.id, { adjustments })}
          onAlgorithm={(algorithm) => patch(editingJob.id, { algorithm })}
          onApplyToAll={() => applyToAll(editingJob.algorithm, editingJob.adjustments)}
          onError={setError}
        />
      ) : (
        <QueueView
          jobs={jobs}
          run={run}
          destination={describeDestination(jobs, settings)}
          startLabel={startLabel}
          onEdit={setEditing}
          onRemove={(id) => remove([id])}
          onStart={() => { setRun(null); void start(readyIds); }}
          onCancel={() => abort.current?.abort()}
          onRetry={() => { setRun(null); void start(jobs.filter((j) => j.status === 'failed').map((j) => j.id)); }}
          onDismissSummary={() => setRun(null)}
        />
      )}

      <SettingsDialog open={settingsOpen} settings={settings} onChange={setSettings} onClose={() => setSettingsOpen(false)} />

      {confirm && (
        <div className="overlay" role="dialog" aria-modal="true" aria-labelledby="confirm-title">
          <div className="confirm">
            <h2 id="confirm-title">Replace {plural(confirm.length, 'original')}?</h2>
            <p>The corrected files will take the place of the originals, which cannot be restored afterwards. Replaced videos are re-encoded, so the original recording quality is lost for good.</p>
            <div className="dialog-actions">
              <button type="button" className="ghost" onClick={() => setConfirm(null)}>Cancel</button>
              <button type="button" className="danger" onClick={() => { const ids = confirm; setConfirm(null); void start(ids, true); }}>Replace</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
