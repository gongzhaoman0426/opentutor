import { describe, expect, it } from 'vitest';
import { formatRenderProgress } from '../src/shared/render-progress';

describe('export progress presentation', () => {
  it('distinguishes completed browser frames from weighted export progress and video frame rate', () => {
    expect(formatRenderProgress({ phase: 'rendering', renderedFrames: 1000, totalFrames: 29000, elapsedMs: 154000, framesPerSecond: 6.49 }))
      .toBe('绘制视频画面 · 画面 1,000/29,000 帧 · 6.5 帧/秒 · 已用 2 分 34 秒');
  });
  it('does not present finished frame rendering as a finished export or estimate remaining mux time', () => {
    expect(formatRenderProgress({ phase: 'muxing', renderedFrames: 29000, totalFrames: 29000, elapsedMs: 600000, framesPerSecond: 50 }))
      .toBe('合成音视频 · 画面 29,000/29,000 帧 · 已用 10 分 0 秒');
    expect(formatRenderProgress({ phase: 'muxing', renderedFrames: 29000, totalFrames: 29000, elapsedMs: 600000 }, { completed: true }))
      .toBe('导出完成 · 画面 29,000/29,000 帧 · 用时 10 分 0 秒');
  });
});
