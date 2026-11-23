// The batch queue: one job per selected file. The single-photo editor is
// the same thing with one job.

import { exportPhoto } from '../io/exportPhoto';
import { loadAnalysisCopy, resizedPixels } from '../io/importPhoto';
import { isTaggedJpeg } from '../io/jpegMarker';
import { deliver, isProcessedName, type WriteResult } from '../io/output';
import type { Source } from '../io/sources';
import { type Adjustments, type Algorithm, type Analyses, type Analysis, CONTROLS, DEFAULT_ADJUSTMENTS, DEFAULT_ALGORITHM, packParams, usesDepthModel } from '../model';
import type { Settings } from '../settings/settings';
import type { VideoMeta } from '../video/video';
import { analyze, analyzeWithRange, applyReference, mapsFromPixels } from '../worker/client';

export type JobStatus =
  | 'analyzing'   // waiting for or running the automatic analysis
  | 'ready'
  | 'skipped'     // already a UWCC result
  | 'unsupported' // not a photo or video this browser can process
  | 'running'
  | 'done'
  | 'failed';

export type Job = {
  id: number;
  source: Source;
  status: JobStatus;
  /** Why the job is skipped, unsupported or failed. */
  message?: string;
  /** The automatic analysis by every method; `algorithm` picks the one in use. */
  analysis?: Analyses;
  algorithm: Algorithm;
  adjustments: Adjustments;
  /** Photos only: the range map from the depth model, once a method that needs it was chosen. */
  depthRange?: Float32Array;
  /** Videos only: the correction over time (per method), and clip facts. */
  video?: VideoMeta;
  /** Small uncorrected copy (data URL) the thumbnail is rendered from. */
  thumbSource?: string;
  /** Corrected thumbnail (data URL), and the method and adjustments it shows (`thumbKey`). */
  thumb?: string;
  thumbKey?: string;
  width?: number;
  height?: number;
  /** 0..1 while running. */
  progress?: number;
  result?: WriteResult;
};

let nextId = 1;

export function createJob(source: Source, settings: Settings): Job {
  const job: Job = { id: nextId++, source, status: 'analyzing', algorithm: settings.defaultAlgorithm, adjustments: DEFAULT_ADJUSTMENTS };
  if (source.kind === 'other') return { ...job, status: 'unsupported', message: 'Not a photo or video.' };
  if (settings.skipProcessed && isProcessedName(source.name, settings.suffix)) {
    return { ...job, status: 'skipped', message: 'Already corrected by UWCC.' };
  }
  return job;
}

/** The analysis of the method the job is set to. */
export const currentAnalysis = (job: Job): Analysis | undefined => job.analysis?.[job.algorithm];

// The video code is loaded on first use.
const videoModule = () => import('../video/video');

/** True when the file is a result UWCC wrote earlier, whatever its name. */
export async function alreadyCorrected(source: Source): Promise<boolean> {
  if (source.kind === 'video') return (await videoModule()).isTaggedVideo(source.file);
  return isTaggedJpeg(source.file);
}

/**
 * The range map the job's method was analysed on, when that is not the one
 * estimated from colour: preview, thumbnail and export must use the same map.
 */
export const fixedRange = (job: Pick<Job, 'algorithm' | 'video' | 'depthRange'>): Float32Array | undefined =>
  usesDepthModel(job.algorithm) && !job.video ? job.depthRange : undefined;

/** Has the job's method still to be analysed with the depth model? */
export const needsDepth = (job: Job): boolean =>
  usesDepthModel(job.algorithm) && job.source.kind === 'photo' && !!job.analysis && !job.analysis[job.algorithm];

/** Run the depth model on a photo and analyse it by `algorithm` on the resulting range map. */
export async function prepareDepth(source: Source, algorithm: Algorithm): Promise<{ analysis: Analysis; depthRange: Float32Array }> {
  const { depthInputSize, depthRange } = await import('../depth/depth');
  const copy = await loadAnalysisCopy(source.file, source.name);
  const size = depthInputSize(copy.mid.width, copy.mid.height);
  const range = await depthRange(resizedPixels(copy.mid, size.width, size.height), size.width, size.height);
  return { analysis: await analyzeWithRange(algorithm, copy.pixels, copy.width, copy.height, range), depthRange: range };
}

/** Identifies what a thumbnail shows, so that it is rendered again when the method or an adjustment changes. */
export const thumbKey = (job: Pick<Job, 'algorithm' | 'adjustments'>) =>
  `${job.algorithm}:${CONTROLS.map((c) => job.adjustments[c.key]).join(',')}:${job.adjustments.neutral.join(',')}`;

/** The job's thumbnail with its current method and adjustments (for a video: of the first frame). */
export async function renderThumb(job: Pick<Job, 'thumbSource' | 'analysis' | 'video' | 'depthRange' | 'algorithm' | 'adjustments'>): Promise<string> {
  const correction = job.video ? job.video.keys[job.algorithm].corrections[0] : job.analysis?.[job.algorithm]?.correction;
  if (!job.thumbSource || !correction) throw new Error('This file has not been analysed.');
  const image = new Image();
  image.src = job.thumbSource;
  await image.decode();
  const canvas = document.createElement('canvas');
  canvas.width = image.naturalWidth;
  canvas.height = image.naturalHeight;
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(image, 0, 0);
  const pixels = new Uint8Array(ctx.getImageData(0, 0, canvas.width, canvas.height).data.buffer);
  const maps = await mapsFromPixels(pixels, canvas.width, canvas.height, correction, fixedRange(job));
  const corrected = await applyReference(pixels, canvas.width, packParams(correction, job.adjustments), maps);
  ctx.putImageData(new ImageData(new Uint8ClampedArray(corrected), canvas.width, canvas.height), 0, 0);
  return canvas.toDataURL('image/jpeg', 0.8);
}

function toDataUrl(pixels: Uint8Array, width: number, height: number): string {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  canvas.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(pixels), width, height), 0, 0);
  return canvas.toDataURL('image/jpeg', 0.9);
}

/** Automatic analysis plus a thumbnail corrected by the given method. */
export async function prepare(
  source: Source,
  algorithm: Algorithm,
): Promise<Pick<Job, 'analysis' | 'video' | 'thumbSource' | 'thumb' | 'thumbKey' | 'width' | 'height'>> {
  let found: Pick<Job, 'analysis' | 'video' | 'thumbSource' | 'width' | 'height'>;
  if (source.kind === 'video') {
    found = await (await videoModule()).prepareVideo(source.file, source.name);
  } else {
    const copy = await loadAnalysisCopy(source.file, source.name);
    found = {
      analysis: await analyze(copy.pixels, copy.width, copy.height),
      thumbSource: toDataUrl(copy.pixels, copy.width, copy.height),
      width: copy.sourceWidth,
      height: copy.sourceHeight,
    };
  }
  // A method that waits for the depth model gets its thumbnail when that is done; until then the default method's.
  const shown = { algorithm: found.video || found.analysis?.[algorithm] ? algorithm : DEFAULT_ALGORITHM, adjustments: DEFAULT_ADJUSTMENTS };
  return { ...found, thumb: await renderThumb({ ...found, ...shown }), thumbKey: thumbKey(shown) };
}

/** Correct one photo or video at full resolution and deliver the result. */
export async function process(
  job: Job,
  settings: Settings,
  fallbackDir: FileSystemDirectoryHandle | null,
  onProgress: (fraction: number) => void,
  signal: AbortSignal,
): Promise<WriteResult> {
  const analysis = currentAnalysis(job);
  if (!analysis) throw new Error('This file has not been analysed.');
  const target = { mode: settings.outputMode, suffix: settings.suffix, fallbackDir };
  if (job.video) {
    const { exportVideo } = await videoModule();
    const result = await exportVideo(job.source.file, job.video.keys[job.algorithm], job.adjustments, onProgress, signal);
    let delivered: WriteResult | null = null;
    try {
      delivered = await deliver(job.source, result.blob, { ...target, format: 'mp4' });
      return delivered;
    } finally {
      // A download reads the temporary file after this returns; it is removed later, or at the next start.
      if (delivered?.kind === 'download') setTimeout(() => void result.cleanup(), 30 * 60_000);
      else await result.cleanup();
    }
  }
  const blob = await exportPhoto(
    job.source.file,
    analysis.correction,
    job.adjustments,
    settings.jpegQuality,
    // Rendering is most of the visible work; encoding has no progress of its own.
    (fraction, stage) => onProgress(stage === 'render' ? fraction * 0.7 : 0.75),
    signal,
    fixedRange(job),
  );
  return deliver(job.source, blob, target);
}

export const isCancel = (error: unknown) => error instanceof DOMException && error.name === 'AbortError';
