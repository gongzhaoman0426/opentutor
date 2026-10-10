import type { GenerationSettings, Palette } from './schema';

export const stylePresets: { id: GenerationSettings['theme']; name: string; description: string; palette: Palette }[] = [
  { id: 'sage', name: '自然留白', description: '米白背景，柔和草木绿', palette: { background: '#f3f4ec', surface: '#ffffff', text: '#183e31', muted: '#627367', accent: '#567c44' } },
  { id: 'ink', name: '深色聚焦', description: '墨绿背景，明亮文字', palette: { background: '#172421', surface: '#20342a', text: '#f5f5e9', muted: '#b9c8b9', accent: '#b7d48b' } },
  { id: 'ocean', name: '理性蓝调', description: '冷白与海蓝，清楚表达数据', palette: { background: '#eef4fa', surface: '#ffffff', text: '#15304a', muted: '#566b80', accent: '#2473b6' } },
  { id: 'sunset', name: '温暖手册', description: '暖纸色与陶橙，轻松讲述', palette: { background: '#faf1e5', surface: '#fffaf4', text: '#492d24', muted: '#866753', accent: '#b7552f' } },
];

const luminance = (hex: string) => {
  const values = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255).map(v => v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
  return values[0] * 0.2126 + values[1] * 0.7152 + values[2] * 0.0722;
};
const contrast = (a: string, b: string) => (Math.max(luminance(a), luminance(b)) + 0.05) / (Math.min(luminance(a), luminance(b)) + 0.05);

/** Keep model-chosen colors readable on both the page and object cards. */
export function resolvePalette(theme: GenerationSettings['theme'], palette?: Palette | null): Palette {
  const fallback = stylePresets.find(item => item.id === theme)?.palette ?? stylePresets[0].palette;
  if (!palette || Object.values(palette).some(value => !/^#[0-9a-f]{6}$/i.test(value))) return fallback;
  const result = { ...palette };
  const readable = (color: string) => contrast(color, result.background) >= 4.5 && contrast(color, result.surface) >= 4.5;
  if (!readable(result.text)) {
    const options = ['#14251c', '#ffffff'];
    const best = options.sort((a, b) => Math.min(contrast(b, result.background), contrast(b, result.surface)) - Math.min(contrast(a, result.background), contrast(a, result.surface)))[0];
    if (!readable(best)) return fallback;
    result.text = best;
  }
  if (!readable(result.muted)) result.muted = result.text;
  return result;
}
