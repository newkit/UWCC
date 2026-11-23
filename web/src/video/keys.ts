// The correction over the length of a clip. Kept apart from `video.ts` so
// the editor can use it without loading the container library.

/** The correction over the length of a clip: one per analysed frame, interpolated in between. */
export type VideoKeys = { times: number[]; corrections: Float32Array[] };


/** Correction at time `t` (seconds from the start of the clip). */
export function correctionAt(keys: VideoKeys, t: number): Float32Array {
  const { times, corrections } = keys;
  if (corrections.length === 1 || t <= times[0]) return corrections[0];
  const last = times.length - 1;
  if (t >= times[last]) return corrections[last];
  let i = 0;
  while (i < last && times[i + 1] < t) i++;
  const f = (t - times[i]) / (times[i + 1] - times[i]);
  const a = corrections[i], b = corrections[i + 1];
  const out = new Float32Array(a.length);
  for (let k = 0; k < a.length; k++) out[k] = a[k] + (b[k] - a[k]) * f;
  return out;
}
