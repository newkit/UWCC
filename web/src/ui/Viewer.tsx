import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { LoadedPhoto } from '../io/importPhoto';
import type { Adjustments } from '../model';
import { CorrectionRenderer } from '../render/renderer';

type Props = {
  photo: LoadedPhoto;
  correction: Float32Array;
  adjustments: Adjustments;
  /** Split view: original on the left of a draggable divider. */
  compare: boolean;
  /** Show the untouched original while held. */
  showOriginal: boolean;
  onError: (message: string) => void;
};

export function Viewer({ photo, correction, adjustments, compare, showOriginal, onError }: Props) {
  const stageRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rendererRef = useRef<CorrectionRenderer | null>(null);
  const [box, setBox] = useState({ width: 0, height: 0 });
  const [split, setSplit] = useState(0.5);

  // Fit the image inside the available space, keeping its aspect ratio.
  useLayoutEffect(() => {
    const stage = stageRef.current!;
    const fit = () => {
      const scale = Math.min(stage.clientWidth / photo.preview.width, stage.clientHeight / photo.preview.height);
      setBox({ width: Math.floor(photo.preview.width * scale), height: Math.floor(photo.preview.height * scale) });
    };
    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(stage);
    return () => observer.disconnect();
  }, [photo]);

  useEffect(() => {
    try {
      rendererRef.current = new CorrectionRenderer(canvasRef.current!);
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error));
    }
    return () => { rendererRef.current = null; };
  }, [onError]);

  useEffect(() => {
    rendererRef.current?.setSource(photo.preview, photo.preview.width, photo.preview.height);
  }, [photo]);

  useEffect(() => {
    const renderer = rendererRef.current;
    if (!renderer) return;
    // Left of the split shows the original; a split of 2 puts the whole frame left of it.
    renderer.draw(correction, adjustments, showOriginal ? 2 : compare ? split : null);
  }, [photo, correction, adjustments, compare, showOriginal, split]);

  const drag = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!(event.buttons & 1) && event.pointerType === 'mouse') return;
    const rect = event.currentTarget.getBoundingClientRect();
    setSplit(Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width)));
  };

  return (
    <div className="stage" ref={stageRef}>
      <div
        className={'frame' + (compare ? ' comparing' : '')}
        style={{ width: box.width, height: box.height }}
        onPointerDown={compare ? (e) => { e.currentTarget.setPointerCapture(e.pointerId); drag(e); } : undefined}
        onPointerMove={compare ? drag : undefined}
      >
        <canvas ref={canvasRef} aria-label={`Preview of ${photo.name}`} />
        {compare && !showOriginal && (
          <>
            <div className="divider" style={{ left: `${split * 100}%` }} aria-hidden="true"><span /></div>
            <span className="tag left">Original</span>
            <span className="tag right">Corrected</span>
          </>
        )}
        {showOriginal && <span className="tag left">Original</span>}
      </div>
    </div>
  );
}
