/** Evaluated inside QuickJS, never injected as host functions or closures. */
export const ANIMATION_HELPERS_SOURCE = String.raw`((fps) => {
  const finite = (value, name) => {
    if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error('anim: ' + name + ' must be a finite number');
    return value;
  };
  const clamp = (value, min = 0, max = 1) => {
    finite(value, 'value'); finite(min, 'min'); finite(max, 'max');
    if (min > max) throw new Error('anim.clamp: min must be <= max');
    return Math.min(max, Math.max(min, value));
  };
  const lerp = (from, to, t) => {
    finite(from, 'from'); finite(to, 'to'); finite(t, 't');
    return finite(from * (1 - t) + to * t, 'lerp result');
  };
  const easings = Object.freeze({
    linear: t => t,
    outCubic: t => 1 - Math.pow(1 - t, 3),
    inOutCubic: t => t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2,
    outQuint: t => 1 - Math.pow(1 - t, 5),
    backOut: t => 1 + 2.70158 * Math.pow(t - 1, 3) + 1.70158 * Math.pow(t - 1, 2),
  });
  const ease = (t, name = 'outCubic') => {
    if (typeof name !== 'string' || !Object.prototype.hasOwnProperty.call(easings, name)) throw new Error('anim.ease: easing must be linear, outCubic, inOutCubic, outQuint or backOut');
    t = clamp(t);
    // Exact endpoints keep completed transforms stable, including backOut.
    return t === 0 || t === 1 ? t : easings[name](t);
  };
  const tween = (cue, seconds, delay = 0, easing = 'outCubic') => {
    finite(fps, 'fps'); finite(seconds, 'seconds'); finite(delay, 'delay');
    if (fps <= 0 || seconds <= 0 || delay < 0 || !Number.isFinite(seconds + delay)) throw new Error('anim.tween: fps and seconds must be > 0; delay must be >= 0');
    if (!cue || typeof cue !== 'object' || typeof cue.started !== 'boolean' || typeof cue.completed !== 'boolean'
      || !Number.isFinite(cue.frame) || !Number.isFinite(cue.durationFrames) || cue.durationFrames <= 0 || cue.frame < 0 || cue.frame > cue.durationFrames) {
      throw new Error('anim.tween: pass an existing cues.<id> with valid frame and durationFrames');
    }
    // Check the easing even before its cue starts, so repairs are deterministic.
    ease(0, easing);
    if (!cue.started) return 0;
    if (cue.completed) return 1;
    // Compress the entire delayed transition for short utterances. No free-running
    // clock, continuation after speech or half-finished state at its frozen end.
    const available = cue.durationFrames / fps;
    const scale = Math.min(1, available / (delay + seconds));
    const localSeconds = cue.frame / fps;
    return ease((localSeconds - delay * scale) / (seconds * scale), easing);
  };
  const pointOnBezier = (p0, p1, p2, p3, t) => {
    for (const point of [p0, p1, p2, p3]) {
      if (!Array.isArray(point) || point.length !== 2) throw new Error('anim.pointOnBezier: each point must be [x, y]');
      finite(point[0], 'point x'); finite(point[1], 'point y');
    }
    t = clamp(t);
    const inverse = 1 - t;
    return [0, 1].map(index => finite(inverse * inverse * inverse * p0[index]
      + 3 * inverse * inverse * t * p1[index] + 3 * inverse * t * t * p2[index]
      + t * t * t * p3[index], 'Bezier result'));
  };
  return Object.freeze({ clamp, lerp, ease, tween, pointOnBezier });
})`;
