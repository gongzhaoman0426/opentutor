/** Pure motion helpers for trusted React scenes (the sandbox gets an equivalent set in CUSTOM_PRELUDE). */
export const clamp = (value: number, min = 0, max = 1) => Math.min(max, Math.max(min, value));
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
export const range = (t: number, start: number, end: number) => clamp((t - start) / ((end - start) || 1));
export const easeOutCubic = (t: number) => 1 - (1 - clamp(t)) ** 3;
export const easeInOutCubic = (t: number) => { const x = clamp(t); return x < 0.5 ? 4 * x * x * x : 1 - (-2 * x + 2) ** 3 / 2; };
export const easeOutBack = (t: number, s = 1.70158) => { const x = clamp(t) - 1; return 1 + (s + 1) * x ** 3 + s * x ** 2; };
export const stagger = (index: number, count: number, t: number, spread = 0.5) => range(t, (index / Math.max(1, count)) * spread, (index / Math.max(1, count)) * spread + (1 - spread));

const channels = (color: string) => { const hex = color.replace('#', ''); const full = hex.length === 3 ? [...hex].map(c => c + c).join('') : hex; return [0, 2, 4].map(i => parseInt(full.slice(i, i + 2), 16) || 0); };
export const mixColor = (a: string, b: string, t: number) => { const x = channels(a), y = channels(b); return `#${x.map((v, i) => Math.round(lerp(v, y[i], clamp(t))).toString(16).padStart(2, '0')).join('')}`; };
export const withAlpha = (color: string, alpha: number) => { const [r, g, b] = channels(color); return `rgba(${r},${g},${b},${clamp(alpha).toFixed(3)})`; };

/** Wrap by visual width: CJK glyphs count 1, ASCII 0.55. Returns at most `maxLines` lines, ellipsizing the last. */
export function wrapText(text: string, maxUnits: number, maxLines = 2): string[] {
  const lines: string[] = []; let line = ''; let used = 0;
  for (const char of [...text]) {
    const w = /[^\x00-\x7F]/.test(char) ? 1 : 0.55;
    if (used + w > maxUnits && line) { lines.push(line); line = ''; used = 0; }
    line += char; used += w;
  }
  if (line) lines.push(line);
  if (lines.length > maxLines) { const kept = lines.slice(0, maxLines); kept[maxLines - 1] = `${kept[maxLines - 1].slice(0, -1)}…`; return kept; }
  return lines;
}
