import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { type Adjustments, usesRange } from '../model';
import { rangeMapOf } from '../render/range';
import { CorrectionRenderer } from '../render/renderer';

type Props = {
  /** The image to show: a photo preview, or a video element. */
  source: TexImageSource;
  width: number;
  height: number;
  /** Changes whenever the source has new content (a new video frame). */
  frame?: number;
  label: string;
  correction: Float32Array;
  adjustments: Adjustments;
  /** Split view: original on the left of a draggable divider. */
  compare: boolean;
  /** Show the untouched original while held. */
  showOriginal: boolean;
  /** Neutral picker active: the next click on the image reports its position (0..1 from the top left). */
  picking?: boolean;
  onPick?: (u: number, v: number) => void;
  onError: (message: string) => void;
};

export function Viewer({ source, width, height, frame = 0, label, correction, adjustments, compare, showOriginal, picking = false, onPick, onError }: Props) {
  const stageRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rendererRef = useRef<CorrectionRenderer | null>(null);
  const uploaded = useRef<{ source: TexImageSource; frame: number } | null>(null);
  const [box, setBox] = useState({ width: 0, height: 0 });
  const [split, setSplit] = useState(0.5);
  // Counts range maps handed to the renderer, so that the frame is drawn again when one arrives.
  const [rangeVersion, setRangeVersion] = useState(0);
  const ranged = usesRange(correction);

  // Fit the image inside the available space, keeping its aspect ratio.
  useLayoutEffect(() => {
    const stage = stageRef.current!;
    const fit = () => {
      const scale = Math.min(stage.clientWidth / width, stage.clientHeight / height);
      setBox({ width: Math.floor(width * scale), height: Math.floor(height * scale) });
    };
    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(stage);
    return () => observer.disconnect();
  }, [width, height]);

  useEffect(() => {
    try {
      rendererRef.current = new CorrectionRenderer(canvasRef.current!);
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error));
    }
    return () => { rendererRef.current = null; uploaded.current = null; };
  }, [onError]);

  // Corrections that depend on range need a map of the frame on screen. It is
  // estimated off the main thread, so it arrives a moment after the frame.
  useEffect(() => {
    if (!ranged || width === 0 || height === 0) return;
    const renderer = rendererRef.current;
    rangeMapOf(source as CanvasImageSource, width, height)
      .then((map) => {
        if (rendererRef.current !== renderer || !renderer) return;
        renderer.setRange(map);
        setRangeVersion((v) => v + 1);
      })
      .catch((error) => onError(error instanceof Error ? error.message : String(error)));
  }, [ranged, source, width, height, frame, onError]);

  useEffect(() => {
    const renderer = rendererRef.current;
    if (!renderer || width === 0 || height === 0) return;
    if (uploaded.current?.source !== source || uploaded.current.frame !== frame) {
      renderer.setSource(source, width, height);
      uploaded.current = { source, frame };
    }
    // Left of the split shows the original; a split of 2 puts the whole frame left of it.
    renderer.draw(correction, adjustments, showOriginal ? 2 : compare ? split : null);
  }, [source, width, height, frame, correction, adjustments, compare, showOriginal, split, rangeVersion]);

  const drag = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!(event.buttons & 1) && event.pointerType === 'mouse') return;
    const rect = event.currentTarget.getBoundingClientRect();
    setSplit(Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width)));
  };

  const pick = (event: React.PointerEvent<HTMLDivElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    onPick?.(Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width)), Math.min(1, Math.max(0, (event.clientY - rect.top) / rect.height)));
  };

  return (
    <div className="stage" ref={stageRef}>
      <div
        className={'frame' + (picking ? ' picking' : compare ? ' comparing' : '')}
        style={{ width: box.width, height: box.height }}
        onPointerDown={picking ? pick : compare ? (e) => { e.currentTarget.setPointerCapture(e.pointerId); drag(e); } : undefined}
        onPointerMove={compare && !picking ? drag : undefined}
      >
        <canvas ref={canvasRef} aria-label={`Preview of ${label}`} />
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
