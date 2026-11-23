import { useCallback, useEffect, useRef, useState } from 'react';
import { downloadBlob, exportPhoto, outputName } from '../io/exportPhoto';
import { type LoadedPhoto, loadPhoto } from '../io/importPhoto';
import { type Adjustments, type Analysis, DEFAULT_ADJUSTMENTS, IDENTITY_CORRECTION } from '../model';
import { analyze } from '../worker/client';
import { Controls } from './Controls';
import { Viewer } from './Viewer';
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

const JPEG_QUALITY = 92;

function describe(analysis: Analysis): string {
  const loss = Math.round(analysis.depletion * 100);
  if (analysis.depletion < 0.05) return 'Red is healthy in this photo, so no automatic correction was applied.';
  if (analysis.depletion < 0.6) return `Red is partly lost (${loss}%). A reduced correction was applied.`;
  return `Red is almost gone (${loss}% lost). Full correction applied.`;
}

export function App() {
  const [photo, setPhoto] = useState<LoadedPhoto | null>(null);
  const [analysis, setAnalysis] = useState<Analysis | null>(null);
  const [adjustments, setAdjustments] = useState<Adjustments>(DEFAULT_ADJUSTMENTS);
  const [compare, setCompare] = useState(false);
  const [showOriginal, setShowOriginal] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const loadToken = useRef(0);

  const open = useCallback(async (file: Blob, name: string) => {
    const token = ++loadToken.current;
    setError(null);
    setBusy('Opening photo…');
    try {
      const loaded = await loadPhoto(file, name);
      const result = await analyze(loaded.analysisPixels);
      if (token !== loadToken.current) return; // a newer photo was opened meanwhile
      setPhoto(loaded);
      setAnalysis(result);
      setAdjustments(DEFAULT_ADJUSTMENTS);
    } catch (e) {
      if (token === loadToken.current) setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (token === loadToken.current) setBusy(null);
    }
  }, []);

  const openSample = async (sample: (typeof SAMPLES)[number]) => {
    setBusy('Opening photo…');
    try {
      const response = await fetch(sample.url);
      if (!response.ok) throw new Error('The sample photo could not be loaded.');
      await open(await response.blob(), sample.name);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(null);
    }
  };

  const save = async () => {
    if (!photo || !analysis) return;
    setError(null);
    try {
      const blob = await exportPhoto(photo.file, analysis.correction, adjustments, JPEG_QUALITY, (fraction, stage) => {
        setBusy(stage === 'render' ? `Correcting… ${Math.round(fraction * 100)}%` : 'Encoding JPEG…');
      });
      downloadBlob(blob, outputName(photo.name));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  // Drop a file anywhere on the page.
  useEffect(() => {
    const over = (e: DragEvent) => { if (e.dataTransfer?.types.includes('Files')) { e.preventDefault(); setDragOver(true); } };
    const leave = (e: DragEvent) => { if (!e.relatedTarget) setDragOver(false); };
    const drop = (e: DragEvent) => {
      e.preventDefault();
      setDragOver(false);
      const file = e.dataTransfer?.files[0];
      if (file) void open(file, file.name);
    };
    window.addEventListener('dragover', over);
    window.addEventListener('dragleave', leave);
    window.addEventListener('drop', drop);
    return () => {
      window.removeEventListener('dragover', over);
      window.removeEventListener('dragleave', leave);
      window.removeEventListener('drop', drop);
    };
  }, [open]);

  const pick = (
    <input
      ref={fileInput}
      type="file"
      accept="image/*"
      hidden
      onChange={(e) => {
        const file = e.target.files?.[0];
        if (file) void open(file, file.name);
        e.target.value = '';
      }}
    />
  );

  const hold = {
    onPointerDown: () => setShowOriginal(true),
    onPointerUp: () => setShowOriginal(false),
    onPointerLeave: () => setShowOriginal(false),
    onPointerCancel: () => setShowOriginal(false),
    onKeyDown: (e: React.KeyboardEvent) => { if (e.key === ' ' || e.key === 'Enter') setShowOriginal(true); },
    onKeyUp: () => setShowOriginal(false),
    onBlur: () => setShowOriginal(false),
  };

  return (
    <div className={'app' + (dragOver ? ' drag-over' : '')}>
      <header>
        <h1>UWCC <span>UnderWater Color Correction</span></h1>
        {photo && (
          <div className="actions">
            <button type="button" className="ghost" onClick={() => fileInput.current?.click()} disabled={!!busy}>Open</button>
            <button type="button" className="primary" onClick={save} disabled={!!busy}>Save</button>
          </div>
        )}
      </header>
      {pick}

      {error && <div className="banner error" role="alert">{error}<button type="button" onClick={() => setError(null)} aria-label="Dismiss">×</button></div>}

      {!photo ? (
        <main className="welcome">
          <div className="welcome-card">
            <h2>Bring the colour back to your underwater photos</h2>
            <p>Open a photo to correct it automatically, then fine-tune it. Everything happens on this device; nothing is uploaded.</p>
            <button type="button" className="primary big" onClick={() => fileInput.current?.click()} disabled={!!busy}>
              {busy ?? 'Open a photo'}
            </button>
            <p className="hint">or drop a photo anywhere on this page</p>
            <div className="samples">
              <span>Try a sample:</span>
              {SAMPLES.map((s) => (
                <button type="button" className="ghost" key={s.name} onClick={() => openSample(s)} disabled={!!busy}>{s.label}</button>
              ))}
            </div>
          </div>
        </main>
      ) : (
        <main className="editor">
          <section className="view">
            <Viewer
              photo={photo}
              correction={analysis?.correction ?? IDENTITY_CORRECTION}
              adjustments={adjustments}
              compare={compare}
              showOriginal={showOriginal}
              onError={setError}
            />
            {busy && <div className="busy" role="status">{busy}</div>}
          </section>
          <aside className="panel">
            <div className="panel-row">
              <button type="button" className={'ghost toggle' + (compare ? ' on' : '')} aria-pressed={compare} onClick={() => setCompare(!compare)}>
                Split view
              </button>
              <button type="button" className="ghost" {...hold}>Hold for original</button>
            </div>
            {analysis && <p className="info">{describe(analysis)}</p>}
            <Controls adjustments={adjustments} onChange={setAdjustments} disabled={!!busy} />
            <p className="meta">{photo.name} · {photo.width} × {photo.height}</p>
          </aside>
        </main>
      )}
    </div>
  );
}
