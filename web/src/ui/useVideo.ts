import { useCallback, useEffect, useRef, useState } from 'react';

export type VideoState = {
  element: HTMLVideoElement | null;
  ready: boolean;
  width: number;
  height: number;
  /** Increments with every new frame shown. */
  frame: number;
  time: number;
  duration: number;
  playing: boolean;
  error: string | null;
  toggle: () => void;
  seek: (time: number) => void;
};

type FrameCallbacks = HTMLVideoElement & {
  requestVideoFrameCallback?: (callback: () => void) => number;
  cancelVideoFrameCallback?: (id: number) => void;
};

/** Plays a video file off-screen; its frames are drawn by the viewer through the correction shader. */
export function useVideo(file: Blob | null): VideoState {
  const ref = useRef<HTMLVideoElement | null>(null);
  const [state, setState] = useState({ ready: false, width: 0, height: 0, frame: 0, time: 0, duration: 0, playing: false, error: null as string | null });

  useEffect(() => {
    if (!file) return;
    const video = document.createElement('video') as FrameCallbacks;
    const url = URL.createObjectURL(file);
    video.playsInline = true;
    video.preload = 'auto';
    video.loop = true;
    video.src = url;
    ref.current = video;
    setState({ ready: false, width: 0, height: 0, frame: 0, time: 0, duration: 0, playing: false, error: null });

    let alive = true;
    let handle = 0;
    const tick = () => {
      if (!alive) return;
      setState((s) => ({ ...s, frame: s.frame + 1, time: video.currentTime }));
    };
    // Follow the video's own frames where the browser reports them; otherwise poll while playing.
    const loop = () => {
      if (!alive) return;
      tick();
      handle = video.requestVideoFrameCallback ? video.requestVideoFrameCallback(loop) : requestAnimationFrame(() => { if (!video.paused) loop(); });
    };
    const onLoaded = () => {
      setState((s) => ({ ...s, ready: true, width: video.videoWidth, height: video.videoHeight, duration: video.duration || 0 }));
      loop();
    };
    const onPlay = () => { setState((s) => ({ ...s, playing: true })); if (!video.requestVideoFrameCallback) loop(); };
    const onPause = () => setState((s) => ({ ...s, playing: false }));
    const onError = () => setState((s) => ({ ...s, error: 'This browser cannot play this video for preview.' }));
    video.addEventListener('loadeddata', onLoaded);
    video.addEventListener('seeked', tick);
    video.addEventListener('play', onPlay);
    video.addEventListener('pause', onPause);
    video.addEventListener('error', onError);

    return () => {
      alive = false;
      if (video.cancelVideoFrameCallback) video.cancelVideoFrameCallback(handle); else cancelAnimationFrame(handle);
      video.pause();
      video.removeAttribute('src');
      video.load();
      URL.revokeObjectURL(url);
      ref.current = null;
    };
  }, [file]);

  const toggle = useCallback(() => {
    const video = ref.current;
    if (!video) return;
    if (video.paused) void video.play().catch(() => {}); else video.pause();
  }, []);
  const seek = useCallback((time: number) => {
    const video = ref.current;
    if (video) video.currentTime = time;
  }, []);

  return { element: ref.current, ...state, toggle, seek };
}
