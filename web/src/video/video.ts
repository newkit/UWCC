// Video support: analysis over time, and export through
// demux -> hardware decode -> correction shader -> hardware encode -> mux.
// Loaded on demand, so photo-only use does not pay for the container library.

import {
  ALL_FORMATS, BlobSource, BufferTarget, Conversion, ConversionCanceledError, Input, Mp4OutputFormat, Output,
  QUALITY_HIGH, StreamTarget, type StreamTargetChunk, VideoSampleSink, canEncodeVideo, type VideoCodec,
} from 'mediabunny';
import { ALGORITHMS, type Adjustments, type Algorithm, type Analyses, usesRange } from '../model';
import { rangeMapOf } from '../render/range';
import { CorrectionRenderer, createWorkCanvas } from '../render/renderer';
import { TEMP_PREFIX } from '../io/tempFiles';
import { correctionAt, type VideoKeys } from './keys';
import { analyze } from '../worker/client';

/** Metadata comment written into every video UWCC produces. */
const SIGNATURE = 'UWCC corrected';
const ANALYSIS_MAX = 256;
/** Seconds between analysed frames; stretched for long clips so the count stays bounded. */
const KEY_INTERVAL = 2;
const MAX_KEYS = 60;

export type { VideoKeys };

/** `keys` holds the correction over time for every method. */
export type VideoMeta = { keys: Record<Algorithm, VideoKeys>; duration: number; codec: string; frameRate: number };

const CODEC_NAMES: Record<string, string> = { avc: 'H.264', hevc: 'HEVC', vp9: 'VP9', av1: 'AV1', vp8: 'VP8', prores: 'ProRes' };

function open(file: Blob) {
  return new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
}

/** Light smoothing over time, so frame-to-frame differences in the analysis do not show as flicker. */
function smooth(corrections: Float32Array[]): Float32Array[] {
  if (corrections.length < 3) return corrections;
  return corrections.map((current, i) => {
    const prev = corrections[Math.max(0, i - 1)], next = corrections[Math.min(corrections.length - 1, i + 1)];
    const out = new Float32Array(current.length);
    for (let k = 0; k < current.length; k++) out[k] = 0.25 * prev[k] + 0.5 * current[k] + 0.25 * next[k];
    return out;
  });
}

/** Does this file carry UWCC's metadata comment? */
export async function isTaggedVideo(file: Blob): Promise<boolean> {
  const input = open(file);
  try {
    return ((await input.getMetadataTags()).comment ?? '').startsWith(SIGNATURE);
  } catch {
    return false;
  } finally {
    input.dispose();
  }
}

/** Analyse frames across the clip; also returns a small copy of the first frame for the thumbnail. */
export async function prepareVideo(file: Blob, name: string): Promise<{ analysis: Analyses; video: VideoMeta; thumbSource: string; width: number; height: number }> {
  const input = open(file);
  try {
    const track = await input.getPrimaryVideoTrack().catch(() => null);
    if (!track) throw new Error(`"${name}" is not a video this app can read.`);
    const codecName = CODEC_NAMES[track.codec ?? ''] ?? 'this kind of';
    if (!(await track.canDecode())) throw new Error(`This browser cannot decode ${codecName} video.`);

    const start = await track.getFirstTimestamp();
    const duration = Math.max(0, (await track.computeDuration()) - start);
    const stats = await track.computePacketStats(60);
    const interval = Math.max(KEY_INTERVAL, duration / MAX_KEYS);
    const count = Math.max(1, Math.floor(duration / interval) + 1);
    const times = Array.from({ length: count }, (_, i) => Math.min(i * interval, Math.max(0, duration - 0.05)));

    const scale = Math.min(1, ANALYSIS_MAX / Math.max(track.displayWidth, track.displayHeight));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(track.displayWidth * scale));
    canvas.height = Math.max(1, Math.round(track.displayHeight * scale));
    const ctx = canvas.getContext('2d', { willReadFrequently: true })!;

    const sink = new VideoSampleSink(track);
    const keyTimes: number[] = [];
    const analyses: Analyses[] = [];
    let firstPixels: Uint8Array | null = null;
    let index = 0;
    for await (const sample of sink.samplesAtTimestamps(times.map((t) => t + start))) {
      const time = times[index++];
      if (!sample) continue;
      sample.draw(ctx, 0, 0, canvas.width, canvas.height);
      sample.close();
      const pixels = new Uint8Array(ctx.getImageData(0, 0, canvas.width, canvas.height).data.buffer.slice(0));
      firstPixels ??= pixels;
      keyTimes.push(time);
      // Every method, with range from colour: the depth model is too slow to run on every frame of a clip.
      analyses.push(await analyze(pixels, canvas.width, canvas.height, true));
    }
    if (analyses.length === 0 || !firstPixels) throw new Error(`No frames could be decoded from "${name}".`);

    const keys = Object.fromEntries(ALGORITHMS.map(({ id }) => [
      id, { times: keyTimes, corrections: smooth(analyses.map((a) => a[id]!.correction)) },
    ])) as Record<Algorithm, VideoKeys>;
    ctx.putImageData(new ImageData(new Uint8ClampedArray(firstPixels), canvas.width, canvas.height), 0, 0);

    return {
      analysis: analyses[0],
      video: { keys, duration, codec: codecName, frameRate: stats.averagePacketRate },
      thumbSource: canvas.toDataURL('image/jpeg', 0.9),
      width: track.displayWidth,
      height: track.displayHeight,
    };
  } finally {
    input.dispose();
  }
}

type TempFile = { target: StreamTarget; finish: () => Promise<Blob>; remove: () => Promise<void> };

/** A temporary file in the browser's private storage, so a long clip is written to disk and not held in memory. */
async function tempFile(): Promise<TempFile | null> {
  try {
    const root = await navigator.storage.getDirectory();
    const name = `${TEMP_PREFIX}${Date.now()}-${Math.round(Math.random() * 1e6)}.mp4`;
    const handle = await root.getFileHandle(name, { create: true });
    const writable = await handle.createWritable();
    return {
      target: new StreamTarget(writable as unknown as WritableStream<StreamTargetChunk>),
      finish: () => handle.getFile(),
      remove: () => root.removeEntry(name).catch(() => {}),
    };
  } catch {
    return null; // no private storage, or it cannot be written from here
  }
}

export type VideoExport = { blob: Blob; cleanup: () => Promise<void> };

/**
 * Re-encode the clip with the correction applied to every frame. Audio is
 * copied unchanged. The result is complete before the caller sees it.
 */
export async function exportVideo(
  file: Blob,
  keys: VideoKeys,
  adjustments: Adjustments,
  onProgress: (fraction: number) => void,
  signal: AbortSignal,
): Promise<VideoExport> {
  const input = open(file);
  const temp = await tempFile();
  const memory = temp ? null : new BufferTarget();
  let renderer: CorrectionRenderer | null = null;
  try {
    const track = await input.getPrimaryVideoTrack();
    if (!track) throw new Error('No video track found.');
    const size = { width: track.displayWidth, height: track.displayHeight };
    const sourceBitrate = (await track.computePacketStats(120)).averageBitrate;

    // Keep the source codec where this device can encode it; otherwise H.264, with more bitrate to hold the quality.
    let codec: VideoCodec = track.codec ?? 'avc';
    let bitrate = sourceBitrate;
    if (!(await canEncodeVideo(codec, size))) {
      if (codec === 'hevc' || codec === 'av1' || codec === 'vp9') bitrate = sourceBitrate * 1.5;
      codec = 'avc';
      if (!(await canEncodeVideo(codec, size))) throw new Error(`This device cannot encode video at ${size.width} × ${size.height}.`);
    }

    const output = new Output({ format: new Mp4OutputFormat(), target: temp?.target ?? memory! });
    const start = await track.getFirstTimestamp();
    const conversion = await Conversion.init({
      input,
      output,
      showWarnings: false,
      tags: (tags) => ({ ...tags, comment: SIGNATURE }),
      video: {
        codec,
        bitrate: bitrate > 0 ? Math.round(bitrate) : QUALITY_HIGH,
        forceTranscode: true,
        process: async (sample) => {
          const frame = sample.toVideoFrame();
          try {
            const w = frame.displayWidth, h = frame.displayHeight;
            const correction = correctionAt(keys, sample.timestamp - start);
            // The range map is the only step that waits; everything on the shared renderer happens after it, in one go.
            const range = usesRange(correction) ? await rangeMapOf(frame, w, h, correction) : null;
            renderer ??= new CorrectionRenderer(createWorkCanvas(w, h));
            if (range) renderer.setRange(range);
            renderer.setSource(frame, w, h);
            renderer.draw(correction, adjustments);
            return renderer.canvas;
          } finally {
            frame.close();
          }
        },
      },
    });
    if (!conversion.isValid) {
      const reasons = conversion.discardedTracks.map((d) => `${d.track.type} track: ${d.reason}`).join('; ');
      throw new Error('This video cannot be converted' + (reasons ? ` (${reasons}).` : '.'));
    }
    conversion.onProgress = (progress) => onProgress(progress);
    const onAbort = () => void conversion.cancel();
    signal.addEventListener('abort', onAbort);
    try {
      if (signal.aborted) throw new DOMException('Cancelled', 'AbortError');
      await conversion.execute();
    } catch (error) {
      if (error instanceof ConversionCanceledError || signal.aborted) throw new DOMException('Cancelled', 'AbortError');
      throw error;
    } finally {
      signal.removeEventListener('abort', onAbort);
    }
    const blob = temp ? await temp.finish() : new Blob([memory!.buffer!], { type: 'video/mp4' });
    return { blob, cleanup: () => temp?.remove() ?? Promise.resolve() };
  } catch (error) {
    await temp?.remove();
    throw error;
  } finally {
    (renderer as CorrectionRenderer | null)?.dispose();
    input.dispose();
  }
}
