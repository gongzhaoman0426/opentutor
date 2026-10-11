import type { UiLocale } from '../i18n/config';
import { translateUi } from '../i18n/translate';

/** Frame counts describe browser rendering; encoding and muxing have no comparable frame counter. */
export interface RenderProgress {
  phase: 'preparing' | 'rendering' | 'encoding' | 'muxing';
  renderedFrames: number;
  totalFrames: number;
  elapsedMs: number;
  framesPerSecond?: number;
}

export const renderPhaseLabels: Record<RenderProgress['phase'], string> = {
  preparing: '准备导出',
  rendering: '绘制视频画面',
  encoding: '编码视频',
  muxing: '合成音视频',
};

export function formatRenderProgress(progress: RenderProgress, options: { completed?: boolean; locale?: UiLocale } = {}): string {
  const locale = options.locale ?? 'zh-CN';
  const t = (key: string, values?: Record<string, string | number>) => translateUi(locale, `render.${key}`, values);
  const parts = [t(options.completed ? 'completed' : progress.phase)];
  if (progress.phase !== 'preparing' && progress.totalFrames > 0) {
    parts.push(t('frames', { rendered: progress.renderedFrames.toLocaleString(locale), total: progress.totalFrames.toLocaleString(locale) }));
  }
  if (!options.completed && progress.phase === 'rendering' && progress.framesPerSecond !== undefined && Number.isFinite(progress.framesPerSecond) && progress.framesPerSecond > 0) {
    parts.push(t('speed', { speed: progress.framesPerSecond.toFixed(1) }));
  }
  const seconds = Math.max(0, Math.floor(progress.elapsedMs / 1000));
  const time = seconds >= 60 ? t('minutesSeconds', { minutes: Math.floor(seconds / 60), seconds: seconds % 60 }) : t('seconds', { seconds });
  parts.push(t(options.completed ? 'duration' : 'elapsed', { time }));
  return parts.join(' · ');
}
