// The batch queue: one job per selected file. The single-photo editor is
// the same thing with one job.

import { exportPhoto } from '../io/exportPhoto';
import { loadAnalysisCopy } from '../io/importPhoto';
import { isTaggedJpeg } from '../io/jpegMarker';
import { deliver, isProcessedName, type WriteResult } from '../io/output';
import type { Source } from '../io/sources';
import { type Adjustments, type Analysis, DEFAULT_ADJUSTMENTS, packParams } from '../model';
import type { Settings } from '../settings/settings';
import { analyze, applyReference } from '../worker/client';

export type JobStatus =
  | 'analyzing'   // waiting for or running the automatic analysis
  | 'ready'
  | 'skipped'     // already a UWCC result
  | 'unsupported' // not a photo this version can process
  | 'running'
  | 'done'
  | 'failed';

export type Job = {
  id: number;
  source: Source;
  status: JobStatus;
  /** Why the job is skipped, unsupported or failed. */
  message?: string;
  analysis?: Analysis;
  adjustments: Adjustments;
  /** Corrected thumbnail (data URL). */
  thumb?: string;
  width?: number;
  height?: number;
  /** 0..1 while running. */
  progress?: number;
  result?: WriteResult;
};

let nextId = 1;

export function createJob(source: Source, settings: Settings): Job {
  const job: Job = { id: nextId++, source, status: 'analyzing', adjustments: DEFAULT_ADJUSTMENTS };
  if (source.kind === 'video') return { ...job, status: 'unsupported', message: 'Video is not supported yet.' };
  if (source.kind === 'other') return { ...job, status: 'unsupported', message: 'Not a photo or video.' };
  if (settings.skipProcessed && isProcessedName(source.name, settings.suffix)) {
    return { ...job, status: 'skipped', message: 'Already corrected by UWCC.' };
  }
  return job;
}

/** True when the file is a result UWCC wrote earlier, whatever its name. */
export const alreadyCorrected = (source: Source) => isTaggedJpeg(source.file);

/** Automatic analysis plus a corrected thumbnail. */
export async function prepare(source: Source): Promise<Pick<Job, 'analysis' | 'thumb' | 'width' | 'height'>> {
  const copy = await loadAnalysisCopy(source.file, source.name);
  const analysis = await analyze(copy.pixels);
  const corrected = await applyReference(copy.pixels.slice(), packParams(analysis.correction, DEFAULT_ADJUSTMENTS));
  const canvas = document.createElement('canvas');
  canvas.width = copy.width;
  canvas.height = copy.height;
  canvas.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(corrected), copy.width, copy.height), 0, 0);
  return { analysis, thumb: canvas.toDataURL('image/jpeg', 0.8), width: copy.sourceWidth, height: copy.sourceHeight };
}

/** Correct one photo at full resolution and deliver the result. */
export async function process(
  job: Job,
  settings: Settings,
  fallbackDir: FileSystemDirectoryHandle | null,
  onProgress: (fraction: number) => void,
  signal: AbortSignal,
): Promise<WriteResult> {
  if (!job.analysis) throw new Error('This photo has not been analysed.');
  const blob = await exportPhoto(
    job.source.file,
    job.analysis.correction,
    job.adjustments,
    settings.jpegQuality,
    // Rendering is most of the visible work; encoding has no progress of its own.
    (fraction, stage) => onProgress(stage === 'render' ? fraction * 0.7 : 0.75),
    signal,
  );
  return deliver(job.source, blob, { mode: settings.outputMode, suffix: settings.suffix, fallbackDir });
}

export const isCancel = (error: unknown) => error instanceof DOMException && error.name === 'AbortError';
