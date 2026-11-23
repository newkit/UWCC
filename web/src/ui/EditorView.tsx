import { useEffect, useState } from 'react';
import { currentAnalysis, type Job } from '../batch/queue';
import { type LoadedPhoto, loadPhoto } from '../io/importPhoto';
import { ALGORITHMS, type Adjustments, type Algorithm, type Analysis, IDENTITY_CORRECTION } from '../model';
import { correctionAt } from '../video/keys';
import { Controls } from './Controls';
import { useVideo } from './useVideo';
import { Viewer } from './Viewer';

type Props = {
  job: Job;
  /** More than one job in the queue: offer "apply to all". */
  multiple: boolean;
  busy: string | null;
  onChange: (adjustments: Adjustments) => void;
  onAlgorithm: (algorithm: Algorithm) => void;
  onApplyToAll: () => void;
  onError: (message: string) => void;
};

/** What the other methods do, in a sentence; UWCC's own is described from its measurements. */
const METHOD_NOTES: Record<Exclude<Algorithm, 'uwcc'>, string> = {
  matrix: 'Borrows red from green and blue by shifting the hue, then stretches each channel to full range. Always applies in full; very blue footage can turn pink.',
  ancuti: 'White balance after Ancuti et al. (2018): adds red where there is green, then balances the channels to grey. Always applies in full.',
  seathru: 'The Sea-thru model (Akkaynak and Treibitz, 2019): removes haze and restores colour by distance. The distance is estimated from the image, because no depth map is available. Experimental; it needs some red left in the footage.',
};

function describe(algorithm: Algorithm, analysis: Analysis, video: boolean): string {
  if (algorithm !== 'uwcc') return METHOD_NOTES[algorithm];
  const what = video ? 'at the start of this clip' : 'in this photo';
  if (analysis.strength < 0.05) return `Colours already look natural ${what}, so no automatic correction was applied.`;
  const partial = analysis.strength < 0.95 ? ` Applied at ${Math.round(analysis.strength * 100)}%, because some natural colour is present.` : '';
  if (analysis.depletion > 0.6) return `Red is almost gone ${what} (${Math.round(analysis.depletion * 100)}% lost), so it was rebuilt from green.${partial}`;
  return `Red is weak ${what}. The colour cast was removed.${partial}`;
}

const clock = (seconds: number) => `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;

export function EditorView({ job, multiple, busy, onChange, onAlgorithm, onApplyToAll, onError }: Props) {
  const isVideo = job.source.kind === 'video';
  const [photo, setPhoto] = useState<LoadedPhoto | null>(null);
  const [compare, setCompare] = useState(false);
  const [showOriginal, setShowOriginal] = useState(false);
  const video = useVideo(isVideo ? job.source.file : null);

  useEffect(() => {
    setPhoto(null);
    if (isVideo) return;
    let current = true;
    loadPhoto(job.source.file, job.source.name)
      .then((loaded) => { if (current) setPhoto(loaded); })
      .catch((e) => { if (current) onError(e instanceof Error ? e.message : String(e)); });
    return () => { current = false; };
  }, [job.id, job.source, isVideo, onError]);

  useEffect(() => {
    if (video.error) onError(video.error);
  }, [video.error, onError]);

  const hold = {
    onPointerDown: () => setShowOriginal(true),
    onPointerUp: () => setShowOriginal(false),
    onPointerLeave: () => setShowOriginal(false),
    onPointerCancel: () => setShowOriginal(false),
    onKeyDown: (e: React.KeyboardEvent) => { if (e.key === ' ' || e.key === 'Enter') setShowOriginal(true); },
    onKeyUp: () => setShowOriginal(false),
    onBlur: () => setShowOriginal(false),
  };

  const shown = isVideo ? video.ready && video.element : photo;
  const waiting = !shown || job.status === 'analyzing';
  const status = busy ?? (waiting ? (isVideo ? 'Opening video…' : 'Opening photo…') : null);
  const analysis = currentAnalysis(job);
  const correction = !analysis
    ? IDENTITY_CORRECTION
    : job.video ? correctionAt(job.video.keys[job.algorithm], video.time) : analysis.correction;
  const size = isVideo ? { width: video.width, height: video.height } : photo ? { width: photo.width, height: photo.height } : null;

  return (
    <main className="editor">
      <section className="view">
        {isVideo && video.ready && video.element && (
          <Viewer
            source={video.element} width={video.width} height={video.height} frame={video.frame} label={job.source.name}
            correction={correction} adjustments={job.adjustments} compare={compare} showOriginal={showOriginal} onError={onError}
          />
        )}
        {!isVideo && photo && (
          <Viewer
            source={photo.preview} width={photo.preview.width} height={photo.preview.height} label={job.source.name}
            correction={correction} adjustments={job.adjustments} compare={compare} showOriginal={showOriginal} onError={onError}
          />
        )}
        {isVideo && video.ready && (
          <div className="transport">
            <button type="button" onClick={video.toggle} aria-label={video.playing ? 'Pause' : 'Play'}>{video.playing ? 'Pause' : 'Play'}</button>
            <input
              type="range" min={0} max={video.duration || 0} step={0.01} value={Math.min(video.time, video.duration || 0)}
              onChange={(e) => video.seek(Number(e.target.value))} aria-label="Position in the clip"
            />
            <span>{clock(video.time)} / {clock(video.duration)}</span>
          </div>
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
        <label className="field method">
          <span>Method</span>
          <select value={job.algorithm} disabled={!!busy || waiting} onChange={(e) => onAlgorithm(e.target.value as Algorithm)}>
            {ALGORITHMS.map((a) => <option key={a.id} value={a.id}>{a.label}</option>)}
          </select>
        </label>
        {analysis && <p className="info">{describe(job.algorithm, analysis, isVideo)}</p>}
        {job.video && job.video.keys[job.algorithm].times.length > 1 && (
          <p className="info">The correction follows the clip: it was measured at {job.video.keys[job.algorithm].times.length} points and changes smoothly between them.</p>
        )}
        <Controls adjustments={job.adjustments} onChange={onChange} disabled={!!busy || waiting} />
        {multiple && (
          <button type="button" className="ghost wide" onClick={onApplyToAll} disabled={!!busy || waiting}>
            Apply method and adjustments to all files
          </button>
        )}
        <p className="meta">
          {job.source.name}{size ? ` · ${size.width} × ${size.height}` : ''}{job.video ? ` · ${clock(job.video.duration)} · ${job.video.codec}` : ''}
        </p>
      </aside>
    </main>
  );
}
