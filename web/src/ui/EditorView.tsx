import { useEffect, useState } from 'react';
import { currentAnalysis, fixedRange, type Job } from '../batch/queue';
import { type LoadedPhoto, loadPhoto } from '../io/importPhoto';
import { ALGORITHMS, type Adjustments, type Algorithm, type Analysis, IDENTITY_CORRECTION, NO_NEUTRAL, hasNeutral } from '../model';
import { pickNeutral } from '../render/neutral';
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
  ancuti: 'The white-balance stage of Ancuti et al. (2018) alone: adds red where there is green, then balances the channels to grey. Always applies in full.',
  uwccAlways: 'UWCC\'s own correction without its check for a colour cast: applied in full even where the colours already look natural. Use it when the automatic choice leaves a file uncorrected.',
  seathruDepth: 'The Sea-thru model (Akkaynak and Treibitz, 2019) with distance from a depth-estimation network (Depth Anything V2 Small) that runs on this device. Experimental. Open water far away can turn dark and noisy.',
  udcp: 'Haze removal by the underwater dark channel prior (Drews et al., 2013). It restores contrast only; the colour cast stays, so combine it with "Pick neutral" or the temperature control. Near objects in front of open water can show a faint halo.',
  ancutiFusion: 'Colour balance and fusion after Ancuti et al. (2018): the white balance, then a blend of a contrast-corrected and a sharpened version, weighted by local contrast, saliency and saturation. The blend is worked out on a reduced copy and applied to the full image.',
  seathru: 'The Sea-thru model (Akkaynak and Treibitz, 2019): removes haze and restores colour by distance. The distance is estimated from the image, because no depth map is available. Experimental; it needs some red left in the footage.',
};

function describe(algorithm: Algorithm, analysis: Analysis, video: boolean): string {
  if (algorithm === 'seathruDepth' && video) return 'For videos this method estimates distance from colour, like "Sea-thru (estimated range)": the depth model is too slow to run on every frame.';
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
  const [picking, setPicking] = useState(false);
  const video = useVideo(isVideo ? job.source.file : null);

  useEffect(() => {
    setPhoto(null);
    setPicking(false);
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
  const status = busy ?? (waiting ? (shown && job.message ? job.message : isVideo ? 'Opening video…' : 'Opening photo…') : null);
  const analysis = currentAnalysis(job);
  const correction = !analysis
    ? IDENTITY_CORRECTION
    : job.video ? correctionAt(job.video.keys[job.algorithm], video.time) : analysis.correction;
  const view = isVideo
    ? video.ready && video.element ? { source: video.element, width: video.width, height: video.height } : null
    : photo ? { source: photo.preview, width: photo.preview.width, height: photo.preview.height } : null;
  const pick = (u: number, v: number) => {
    setPicking(false);
    if (!view) return;
    const adjustments = job.adjustments;
    pickNeutral(view.source, view.width, view.height, u, v, correction, adjustments.strength, fixedRange(job))
      .then((neutral) => onChange({ ...adjustments, neutral }))
      .catch((e) => onError(e instanceof Error ? e.message : String(e)));
  };
  const size = isVideo ? { width: video.width, height: video.height } : photo ? { width: photo.width, height: photo.height } : null;

  return (
    <main className="editor">
      <section className="view">
        {isVideo && video.ready && video.element && (
          <Viewer
            source={video.element} width={video.width} height={video.height} frame={video.frame} label={job.source.name}
            correction={correction} adjustments={job.adjustments} compare={compare} showOriginal={showOriginal} picking={picking} onPick={pick} onError={onError}
          />
        )}
        {!isVideo && photo && (
          <Viewer
            source={photo.preview} width={photo.preview.width} height={photo.preview.height} label={job.source.name}
            correction={correction} range={fixedRange(job)} adjustments={job.adjustments} compare={compare} showOriginal={showOriginal} picking={picking} onPick={pick} onError={onError}
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
        <div className="panel-row neutral">
          <button type="button" className={'ghost toggle' + (picking ? ' on' : '')} aria-pressed={picking} disabled={!!busy || waiting} onClick={() => setPicking(!picking)}>
            Pick neutral
          </button>
          <button type="button" className="ghost" disabled={!!busy || waiting || !hasNeutral(job.adjustments)} onClick={() => onChange({ ...job.adjustments, neutral: NO_NEUTRAL })}>
            Clear neutral
          </button>
        </div>
        {picking && <p className="info" role="status">Click something in the picture that should be grey or white, such as sand, a tank or a slate.</p>}
        {!picking && hasNeutral(job.adjustments) && (
          <p className="info">Balanced on the spot you picked{isVideo ? '; the same balance is used for the whole clip' : ''}.</p>
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
