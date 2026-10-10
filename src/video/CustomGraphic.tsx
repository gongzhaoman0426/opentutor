import React from 'react';
import { cancelRender, continueRender, delayRender, getRemotionEnvironment } from 'remotion';
import type { Palette } from '../shared/schema';
import { loadCustomRuntime, renderCustomFrame } from './custom-runtime';

export function CustomGraphic({ code, frame, fps, durationFrames, width, scale, palette }: { code: string; frame: number; fps: number; durationFrames: number; width: number; scale: number; palette: Palette }) {
  const instanceId = React.useId();
  const idPrefix = `custom-${instanceId.replace(/[^\w-]/g, '_')}-`;
  const [runtime, setRuntime] = React.useState<Awaited<ReturnType<typeof loadCustomRuntime>> | null>(null);
  const [error, setError] = React.useState('');
  const [handle] = React.useState(() => delayRender('初始化动态组件'));
  React.useEffect(() => {
    let active = true;
    loadCustomRuntime().then(value => { if (active) setRuntime(value); }).catch(() => { if (active) setError('动态组件引擎加载失败'); }).finally(() => continueRender(handle));
    return () => { active = false; continueRender(handle); };
  }, [handle]);
  const output = React.useMemo(() => {
    if (!runtime) return { svg: '', error };
    try { return { svg: renderCustomFrame(runtime, code, { frame: Math.max(0, frame), fps, width, height: 286, progress: Math.min(1, Math.max(0, frame / Math.max(1, durationFrames - 1))), theme: palette }, idPrefix), error: '' }; }
    catch (reason) { return { svg: '', error: reason instanceof Error ? reason.message : '组件执行失败' }; }
  }, [runtime, code, frame, fps, width, durationFrames, palette, error, idPrefix]);
  React.useEffect(() => { if (output.error && getRemotionEnvironment().isRendering) cancelRender(new Error(output.error)); }, [output.error]);
  if (output.error) return <div role="alert" style={{ height: 286 * scale, color: palette.text, padding: 20 * scale, fontSize: 20 * scale }}>动态组件无法显示：{output.error}</div>;
  // SVG was parsed and allowlisted by renderCustomFrame. Inline geometry updates
  // synchronously, avoiding an image decode race on every animation frame.
  return output.svg ? <div role="img" aria-label="AI 自定义图形组件" style={{ width: width * scale, height: 286 * scale, pointerEvents: 'none' }} dangerouslySetInnerHTML={{ __html: output.svg }} /> : <div style={{ height: 286 * scale }} />;
}
