import { useEffect, useState } from 'react';
import type { Job } from '../batch/queue';
import { type LoadedPhoto, loadPhoto } from '../io/importPhoto';
import { type Adjustments, type Analysis, IDENTITY_CORRECTION } from '../model';
import { Controls } from './Controls';
import { Viewer } from './Viewer';

type Props = {
  job: Job;
  /** More than one job in the queue: offer "apply to all". */
  multiple: boolean;
  busy: string | null;
  onChange: (adjustments: Adjustments) => void;
  onApplyToAll: () => void;
  onError: (message: string) => void;
};

function describe(analysis: Analysis): string {
  const loss = Math.round(analysis.depletion * 100);
  if (analysis.depletion < 0.05) return 'Red is healthy in this photo, so no automatic correction was applied.';
  if (analysis.depletion < 0.6) return `Red is partly lost (${loss}%). A reduced correction was applied.`;
  return `Red is almost gone (${loss}% lost). Full correction applied.`;
}

export function EditorView({ job, multiple, busy, onChange, onApplyToAll, onError }: Props) {
  const [photo, setPhoto] = useState<LoadedPhoto | null>(null);
  const [compare, setCompare] = useState(false);
  const [showOriginal, setShowOriginal] = useState(false);

  useEffect(() => {
    let current = true;
    setPhoto(null);
    loadPhoto(job.source.file, job.source.name)
      .then((loaded) => { if (current) setPhoto(loaded); })
      .catch((e) => { if (current) onError(e instanceof Error ? e.message : String(e)); });
    return () => { current = false; };
  }, [job.id, job.source, onError]);

  const hold = {
    onPointerDown: () => setShowOriginal(true),
    onPointerUp: () => setShowOriginal(false),
    onPointerLeave: () => setShowOriginal(false),
    onPointerCancel: () => setShowOriginal(false),
    onKeyDown: (e: React.KeyboardEvent) => { if (e.key === ' ' || e.key === 'Enter') setShowOriginal(true); },
    onKeyUp: () => setShowOriginal(false),
    onBlur: () => setShowOriginal(false),
  };

  const waiting = !photo || job.status === 'analyzing';
  const status = busy ?? (waiting ? 'Opening photo…' : null);

  return (
    <main className="editor">
      <section className="view">
        {photo && (
          <Viewer
            photo={photo}
            correction={job.analysis?.correction ?? IDENTITY_CORRECTION}
            adjustments={job.adjustments}
            compare={compare}
            showOriginal={showOriginal}
            onError={onError}
          />
        )}
        {status && <div className="busy" role="status">{status}</div>}
      </section>
      <aside className="panel">
        <div className="panel-row">
          <button type="button" className={'ghost toggle' + (compare ? ' on' : '')} aria-pressed={compare} onClick={() => setCompare(!compare)}>
            Split view
          </button>
          <button type="button" className="ghost" {...hold}>Hold for original</button>
        </div>
        {job.analysis && <p className="info">{describe(job.analysis)}</p>}
        <Controls adjustments={job.adjustments} onChange={onChange} disabled={!!busy || waiting} />
        {multiple && (
          <button type="button" className="ghost wide" onClick={onApplyToAll} disabled={!!busy || waiting}>
            Apply these adjustments to all photos
          </button>
        )}
        <p className="meta">{job.source.name}{photo ? ` · ${photo.width} × ${photo.height}` : ''}</p>
      </aside>
    </main>
  );
}
