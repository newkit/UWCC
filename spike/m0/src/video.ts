import {
  ALL_FORMATS, BlobSource, BufferSource, BufferTarget, CanvasSource, Conversion, Input, Mp4OutputFormat, Output,
  QUALITY_HIGH, canEncodeVideo, type VideoCodec,
} from 'mediabunny';
import { add, errText, mem, round, showMedia, status } from './report';
import { Renderer } from './gl';

const NAMES: Record<string, string> = { avc: 'H.264', hevc: 'HEVC', vp9: 'VP9', av1: 'AV1' };

/** Encode a generated animation to MP4. Measures the encoder alone. */
async function makeSynthetic(codec: VideoCodec, w: number, h: number, fps: number, frames: number) {
  const r = new Renderer(w, h, { identity: true });
  const target = new BufferTarget();
  const output = new Output({ format: new Mp4OutputFormat(), target });
  const src = new CanvasSource(r.canvas, { codec, bitrate: QUALITY_HIGH });
  output.addVideoTrack(src, { frameRate: fps });
  await output.start();
  const t0 = performance.now();
  for (let i = 0; i < frames; i++) {
    r.drawPattern(w, h, i / fps);
    await src.add(i / fps, 1 / fps);
  }
  await output.finalize();
  const sec = (performance.now() - t0) / 1000;
  r.dispose();
  return { buffer: target.buffer!, fps: frames / sec, sec };
}

export type RoundTrip = { blob: Blob; frames: number; sec: number; mediaSec: number };

/** Demux -> decode -> shader -> encode -> mux. The pipeline the app depends on. */
async function roundTrip(input: Input, codec: VideoCodec, limitSec: number, label: string): Promise<RoundTrip> {
  const target = new BufferTarget();
  const output = new Output({ format: new Mp4OutputFormat(), target });
  let renderer: Renderer | null = null;
  let frames = 0;
  let lastTs = 0;
  const conversion = await Conversion.init({
    input, output,
    showWarnings: false,
    trim: limitSec > 0 ? { start: 0, end: limitSec } : undefined,
    video: {
      codec, bitrate: QUALITY_HIGH, forceTranscode: true,
      process: (sample) => {
        const frame = sample.toVideoFrame();
        const w = frame.displayWidth, h = frame.displayHeight;
        renderer ??= new Renderer(w, h);
        renderer.drawSource(frame, w, h);
        frame.close();
        frames++;
        lastTs = sample.timestamp + sample.duration;
        return renderer.canvas;
      },
    },
  });
  if (!conversion.isValid) {
    const why = conversion.discardedTracks.map((d) => `${d.track.type}: ${d.reason}`).join('; ');
    throw new Error('conversion not possible - ' + why);
  }
  const discarded = conversion.discardedTracks.map((d) => `${d.track.type}: ${d.reason}`);
  if (discarded.length) add('Video', label + ' discarded tracks', false, discarded);
  conversion.onProgress = (p) => status(`${label}: ${Math.round(p * 100)} %`);
  const t0 = performance.now();
  await conversion.execute();
  const sec = (performance.now() - t0) / 1000;
  (renderer as Renderer | null)?.dispose();
  return { blob: new Blob([target.buffer!], { type: 'video/mp4' }), frames, sec, mediaSec: lastTs };
}

/** Re-open a produced file to confirm it is a readable MP4 with the expected tracks. */
async function verify(blob: Blob) {
  const input = new Input({ source: new BlobSource(blob), formats: ALL_FORMATS });
  try {
    const v = await input.getPrimaryVideoTrack();
    const a = await input.getPrimaryAudioTrack();
    return {
      video: v ? `${v.codec} ${v.displayWidth}x${v.displayHeight}` : null,
      audio: a ? a.codec : null,
      durationSec: round(await input.computeDuration(), 2),
      decodable: v ? await v.canDecode() : false,
    };
  } finally { input.dispose(); }
}

export async function syntheticVideoTests(include4k: boolean) {
  const S = 'Video (built-in synthetic clip)';
  const sizes: [string, number, number][] = [['1080p', 1920, 1080]];
  if (include4k) sizes.push(['4K', 3840, 2160]);
  const codecs: VideoCodec[] = ['avc', 'hevc', 'vp9'];
  let shown = false;
  for (const [sizeName, w, h] of sizes) {
    for (const codec of codecs) {
      const label = `${NAMES[codec]} ${sizeName}`;
      status(`Video: ${label}`);
      try {
        if (!(await canEncodeVideo(codec, { width: w, height: h }))) { add(S, label, false, 'encoder not available'); continue; }
        add(S, label + ' starting', null);
        const frames = 90, fps = 30;
        const syn = await makeSynthetic(codec, w, h, fps, frames);
        const input = new Input({ source: new BufferSource(syn.buffer), formats: ALL_FORMATS });
        const rt = await roundTrip(input, codec, 0, label);
        input.dispose();
        const check = await verify(rt.blob);
        const speed = rt.mediaSec / rt.sec;
        add(S, label, rt.frames === frames && check.decodable, {
          encodeOnlyFps: round(syn.fps), roundTripFps: round(rt.frames / rt.sec), xRealtimeAt30fps: round(speed, 2),
          frames: rt.frames, outMB: round(rt.blob.size / 1048576, 2), check, heapMB: mem(),
        });
        if (!shown && codec === 'avc') { showMedia(rt.blob, `synthetic_${sizeName}_${codec}.mp4`, 'video'); shown = true; }
      } catch (e) {
        add(S, label, false, errText(e));
      }
    }
  }
}

export async function clipTest(file: File, codec: VideoCodec, limitSec: number) {
  const S = 'Video (your clips)';
  const label = file.name;
  status(`Video: ${label}`);
  const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
  try {
    const v = await input.getPrimaryVideoTrack();
    if (!v) { add(S, label, false, 'no video track found / format not readable'); return; }
    const a = await input.getPrimaryAudioTrack();
    const stats = await v.computePacketStats(120);
    const duration = await input.computeDuration();
    const info = {
      sizeMB: round(file.size / 1048576), container: (await input.getFormat()).name, codec: v.codec, codecString: await v.getCodecParameterString(),
      size: `${v.displayWidth}x${v.displayHeight}`, rotation: v.rotation, fps: round(stats.averagePacketRate, 2),
      mbps: round(stats.averageBitrate / 1e6), durationSec: round(duration), hdr: await v.hasHighDynamicRange(),
      audio: a ? a.codec : null, canDecodeVideo: await v.canDecode(), canDecodeAudio: a ? await a.canDecode() : null,
    };
    add(S, label + ' source', info.canDecodeVideo, info);
    if (!info.canDecodeVideo) return;
    const size = { width: v.displayWidth, height: v.displayHeight };
    let outCodec = codec;
    if (!(await canEncodeVideo(outCodec, size))) {
      add(S, `${label} ${NAMES[outCodec]} encoder not available at this size, trying H.264`, false);
      outCodec = 'avc';
      if (!(await canEncodeVideo(outCodec, size))) { add(S, label, false, 'no encoder available at ' + info.size); return; }
    }
    add(S, label + ' starting', null, { encodeAs: NAMES[outCodec], limitSec: limitSec || 'whole clip' });
    const rt = await roundTrip(input, outCodec, limitSec, label);
    const check = await verify(rt.blob);
    add(S, label + ' result', check.decodable && rt.frames > 0, {
      frames: rt.frames, mediaSec: round(rt.mediaSec), wallSec: round(rt.sec), fps: round(rt.frames / rt.sec),
      xRealtime: round(rt.mediaSec / rt.sec, 2), outMB: round(rt.blob.size / 1048576), check, heapMB: mem(),
    });
    showMedia(rt.blob, file.name.replace(/\.[^.]+$/, '') + '_uwcc_spike.mp4', 'video');
  } catch (e) {
    add(S, label, false, errText(e));
  } finally {
    input.dispose();
  }
}
