import { test, expect } from '@playwright/test';
import { defaultSettings, type Project, type Scene } from '../../src/shared/schema';

import { getChapterSourceKey } from '../../src/shared/chapters';

// A real PCM file exercises browser audio clocks without model calls, external
// speech services, or changes to a user's courses.
function wave(seconds: number): Buffer {
  const sampleRate = 16000;
  const samples = sampleRate * seconds;
  const buffer = Buffer.alloc(44 + samples * 2);
  buffer.write('RIFF', 0); buffer.writeUInt32LE(buffer.length - 8, 4); buffer.write('WAVEfmt ', 8);
  buffer.writeUInt32LE(16, 16); buffer.writeUInt16LE(1, 20); buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(sampleRate, 24); buffer.writeUInt32LE(sampleRate * 2, 28);
  buffer.writeUInt16LE(2, 32); buffer.writeUInt16LE(16, 34); buffer.write('data', 36); buffer.writeUInt32LE(samples * 2, 40);
  for (let index = 0; index < samples; index++) buffer.writeInt16LE(Math.round(Math.sin(index / sampleRate * Math.PI * 2 * 220) * 1200), 44 + index * 2);
  return buffer;
}

test('advances the preview clock in real time without automatically rewinding the narration', async ({ page }) => {
  const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const scenes: Scene[] = [0, 1].map(index => ({ id: `scene-${index}`, title: `连续讲解 ${index + 1}`, chapter: '音频回归', layout: 'content', sourceBlockIds: ['source'], objects: [{ id: `object-${index}`, type: 'text', content: '播放中的讲稿应连续前进，不能反复回跳到同一句话。', language: '' }], narration: [{ id: `utterance-${index}`, text: '这一段讲解持续十秒，播放时间应与真实时间一致。', showObjectIds: [`object-${index}`], focusObjectId: '' }] }));
  const project: Project = {
    id, title: '音频时钟回归', markdown: '# 音频时钟回归\n\n播放讲稿。', settings: { ...defaultSettings }, assets: [], revision: 1,
    lesson: { schemaVersion: '0.1', title: '音频时钟回归', objectives: ['连续播放'], scenes },
    previewRevision: 1, latestJob: null, createdAt: '2026-10-09T00:00:00Z', updatedAt: '2026-10-09T00:00:00Z',
    renderPlan: { schemaVersion: '0.1', revision: 1, title: '音频时钟回归', fps: 30, width: 1280, height: 720, theme: 'sage', totalFrames: 600, previewMode: 'aligned', voice: defaultSettings.voice, rate: 0,
      scenes: scenes.map((scene, index) => ({ scene, startFrame: index * 300, durationFrames: 300, utterances: [{ utteranceId: `utterance-${index}`, startFrame: 0, durationFrames: 300, durationSeconds: 10, url: `/api/artifacts/playback-${index}`, hash: `clip-${index}`, cacheHit: false, boundaries: [{ kind: 'utterance', text: scene.narration[0].text, startSeconds: 0, endSeconds: 10 }] }] })),
    },
  };
  project.chapters = [{ id: 'clock-chapter', title: '音频回归', markdown: project.markdown }];
  project.sourceMode = 'chapters';
  project.chapterVideos = { 'clock-chapter': { chapterId: 'clock-chapter', sourceKey: getChapterSourceKey(project, project.chapters[0]), settings: project.settings, lesson: project.lesson!, renderPlan: project.renderPlan, previewAssets: [], previewRevision: 1, latestExport: null, updatedAt: project.updatedAt, current: true } };
  await page.route(`**/api/projects/${id}`, route => route.fulfill({ json: { project } }));
  const audio = wave(10);
  await page.route('**/api/artifacts/playback-*', route => route.fulfill({ contentType: 'audio/wav', body: audio }));
  await page.addInitScript(() => {
    type Seek = { before: number; after: number; src: string };
    const state = window as unknown as { playbackSeeks: Seek[] };
    state.playbackSeeks = [];
    const descriptor = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'currentTime')!;
    Object.defineProperty(HTMLMediaElement.prototype, 'currentTime', { configurable: true, get: descriptor.get,
      set(this: HTMLMediaElement, value: number) {
        if (this.src.includes('/api/artifacts/playback-')) state.playbackSeeks.push({ before: descriptor.get!.call(this), after: value, src: this.src });
        descriptor.set!.call(this, value);
      },
    });
  });
  await page.goto(`/projects/${id}`);
  await page.getByRole('button', { name: '任务详情', exact: false }).click();
  await page.getByRole('button', { name: '预览历史完整视频', exact: true }).click();
  await expect(page.getByRole('dialog', { name: '历史完整预览' })).toBeVisible();
  await page.getByRole('button', { name: '关闭历史完整预览', exact: true }).click();
  await page.getByRole('button', { name: '关闭任务详情', exact: true }).click();
  await page.getByRole('tab', { name: '视频', exact: true }).click();
  const play = page.getByRole('button', { name: '播放预览', exact: true });
  await expect(play).toBeVisible();
  const playhead = page.locator('.creation-playhead input');
  const start = Number(await playhead.inputValue());
  await play.click();
  await page.waitForTimeout(15000);
  expect((Number(await playhead.inputValue()) - start) / 30).toBeGreaterThanOrEqual(14);
  const backwards = await page.evaluate(() => (window as unknown as { playbackSeeks: { before: number; after: number }[] }).playbackSeeks.filter(seek => seek.before - seek.after > 0.25));
  expect(backwards).toEqual([]);
});
