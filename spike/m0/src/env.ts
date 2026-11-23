import { add, errText } from './report';
import { Renderer } from './gl';

export async function envReport() {
  const S = 'Device';
  const n = navigator as any;
  add(S, 'userAgent', null, navigator.userAgent);
  add(S, 'platform', null, { platform: n.userAgentData?.platform ?? navigator.platform, mobile: n.userAgentData?.mobile ?? null, capacitor: !!(window as any).Capacitor, standalone: matchMedia('(display-mode: standalone)').matches || !!n.standalone });
  add(S, 'screen', null, { w: screen.width, h: screen.height, dpr: devicePixelRatio });
  add(S, 'cpu/memory', null, { cores: navigator.hardwareConcurrency ?? null, deviceMemoryGB: n.deviceMemory ?? null });
  add(S, 'context', null, { secure: isSecureContext, crossOriginIsolated });
  const has = (k: string) => k in window;
  add(S, 'WebCodecs', has('VideoDecoder') && has('VideoEncoder'), { VideoDecoder: has('VideoDecoder'), VideoEncoder: has('VideoEncoder'), AudioDecoder: has('AudioDecoder'), AudioEncoder: has('AudioEncoder'), VideoFrame: has('VideoFrame') });
  add(S, 'WebAssembly', typeof WebAssembly === 'object');
  add(S, 'OffscreenCanvas', has('OffscreenCanvas'));
  add(S, 'File System Access', null, { showOpenFilePicker: has('showOpenFilePicker'), showDirectoryPicker: has('showDirectoryPicker'), showSaveFilePicker: has('showSaveFilePicker'), opfs: !!navigator.storage?.getDirectory });
  add(S, 'other APIs', null, { wakeLock: 'wakeLock' in navigator, share: 'share' in navigator, canShareFiles: typeof n.canShare === 'function', createImageBitmap: has('createImageBitmap') });
  try {
    const est = await navigator.storage?.estimate?.();
    if (est) add(S, 'storage estimate (MB)', null, { quota: Math.round((est.quota ?? 0) / 1048576), usage: Math.round((est.usage ?? 0) / 1048576) });
  } catch { /* not available */ }
  try {
    const r = new Renderer(16, 16);
    add(S, 'WebGL2', true, r.info());
    r.dispose();
  } catch (e) {
    add(S, 'WebGL2', false, errText(e));
  }
}

type Cfg = { label: string; codec: string; w: number; h: number; fps: number; bitrate: number };

const DEC: Cfg[] = [
  { label: 'H.264 High 1080p', codec: 'avc1.640028', w: 1920, h: 1080, fps: 30, bitrate: 0 },
  { label: 'H.264 High 4K', codec: 'avc1.640033', w: 3840, h: 2160, fps: 30, bitrate: 0 },
  { label: 'HEVC Main 1080p', codec: 'hvc1.1.6.L123.B0', w: 1920, h: 1080, fps: 30, bitrate: 0 },
  { label: 'HEVC Main 4K', codec: 'hvc1.1.6.L153.B0', w: 3840, h: 2160, fps: 30, bitrate: 0 },
  { label: 'HEVC Main10 4K', codec: 'hvc1.2.4.L153.B0', w: 3840, h: 2160, fps: 30, bitrate: 0 },
  { label: 'VP9 1080p', codec: 'vp09.00.40.08', w: 1920, h: 1080, fps: 30, bitrate: 0 },
  { label: 'AV1 1080p', codec: 'av01.0.08M.08', w: 1920, h: 1080, fps: 30, bitrate: 0 },
];

const ENC: Cfg[] = [
  { label: 'H.264 1080p30', codec: 'avc1.640028', w: 1920, h: 1080, fps: 30, bitrate: 12e6 },
  { label: 'H.264 1080p60', codec: 'avc1.64002A', w: 1920, h: 1080, fps: 60, bitrate: 20e6 },
  { label: 'H.264 4K30', codec: 'avc1.640033', w: 3840, h: 2160, fps: 30, bitrate: 45e6 },
  { label: 'H.264 4K60', codec: 'avc1.640034', w: 3840, h: 2160, fps: 60, bitrate: 60e6 },
  { label: 'HEVC 1080p30', codec: 'hvc1.1.6.L123.B0', w: 1920, h: 1080, fps: 30, bitrate: 8e6 },
  { label: 'HEVC 4K30', codec: 'hvc1.1.6.L153.B0', w: 3840, h: 2160, fps: 30, bitrate: 30e6 },
  { label: 'HEVC 4K60', codec: 'hvc1.1.6.L156.B0', w: 3840, h: 2160, fps: 60, bitrate: 45e6 },
];

export async function codecReport() {
  const S = 'Codec support (browser self-report)';
  if (!('VideoDecoder' in window) || !('VideoEncoder' in window)) { add(S, 'WebCodecs missing', false); return; }
  for (const c of DEC) {
    const res: Record<string, boolean | string> = {};
    for (const hw of ['no-preference', 'prefer-hardware'] as const) {
      try {
        const r = await VideoDecoder.isConfigSupported({ codec: c.codec, codedWidth: c.w, codedHeight: c.h, hardwareAcceleration: hw });
        res[hw] = !!r.supported;
      } catch (e) { res[hw] = errText(e); }
    }
    add(S, 'decode ' + c.label, res['no-preference'] === true, res);
  }
  for (const c of ENC) {
    const res: Record<string, boolean | string> = {};
    for (const hw of ['no-preference', 'prefer-hardware'] as const) {
      try {
        const r = await VideoEncoder.isConfigSupported({ codec: c.codec, width: c.w, height: c.h, framerate: c.fps, bitrate: c.bitrate, hardwareAcceleration: hw });
        res[hw] = !!r.supported;
      } catch (e) { res[hw] = errText(e); }
    }
    add(S, 'encode ' + c.label, res['no-preference'] === true, res);
  }
}
