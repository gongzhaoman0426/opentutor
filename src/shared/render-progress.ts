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

export function formatRenderProgress(progress: RenderProgress, options: { completed?: boolean } = {}): string {
  const parts = [options.completed ? '导出完成' : renderPhaseLabels[progress.phase]];
  if (progress.phase !== 'preparing' && progress.totalFrames > 0) {
    parts.push(`画面 ${progress.renderedFrames.toLocaleString('zh-CN')}/${progress.totalFrames.toLocaleString('zh-CN')} 帧`);
  }
  if (!options.completed && progress.phase === 'rendering' && progress.framesPerSecond !== undefined && Number.isFinite(progress.framesPerSecond) && progress.framesPerSecond > 0) {
    parts.push(`${progress.framesPerSecond.toFixed(1)} 帧/秒`);
  }
  const seconds = Math.max(0, Math.floor(progress.elapsedMs / 1000));
  parts.push(`${options.completed ? '用时' : '已用'} ${seconds >= 60 ? `${Math.floor(seconds / 60)} 分 ` : ''}${seconds % 60} 秒`);
  return parts.join(' · ');
}
