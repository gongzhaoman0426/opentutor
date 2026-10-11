import { test, expect, type Page } from '@playwright/test';
import { defaultSettings, type Project, type Scene } from '../../src/shared/schema';
import { getChapterSourceKey } from '../../src/shared/chapters';

// These are synthetic timing fixtures, never presented as real TTS output.
// They run the application's Player -> LessonVideo -> QuickJS rendering path.
function silenceWav(seconds: number) {
  const rate = 8000, bytes = Math.ceil(seconds * rate) * 2;
  const output = Buffer.alloc(44 + bytes);
  output.write('RIFF', 0); output.writeUInt32LE(36 + bytes, 4); output.write('WAVEfmt ', 8);
  output.writeUInt32LE(16, 16); output.writeUInt16LE(1, 20); output.writeUInt16LE(1, 22);
  output.writeUInt32LE(rate, 24); output.writeUInt32LE(rate * 2, 28); output.writeUInt16LE(2, 32);
  output.writeUInt16LE(16, 34); output.write('data', 36); output.writeUInt32LE(bytes, 40);
  return output;
}

async function seek(page: Page, frame: number) {
  const slider = page.getByRole('slider', { name: '预览播放位置' });
  await slider.evaluate((element, nextFrame) => {
    const input = element as HTMLInputElement;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, String(nextFrame));
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }, frame);
  await expect(slider).toHaveValue(String(frame));
}

async function fixture(page: Page, introFrames: number, rate: number, boundarySeconds = 0) {
  const id = 'afeed000-0000-4000-8000-000000000001';
  const fps = 30, resultFrames = 120, totalFrames = introFrames + resultFrames;
  const settings = { ...defaultSettings, creationMode: 'creative' as const, rate };
  const chapter = { id: 'motion-chapter', title: '旁白控制动效', markdown: '# 先讲背景，再揭示结果\n\n前面的句子长度会变化。最后才揭示四这个结果。', settings };
  const object = {
    id: 'result-graphic', type: 'custom' as const, language: 'javascript',
    motion: { version: 'narration-v1' as const, cues: [{ id: 'result', utteranceId: 'result-speech' }] },
    content: 'const c=cues.result; return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1104 286"><text x="40" y="70" font-size="32" fill="${theme.text}">等待对应旁白</text>${c.started?`<text x="40" y="140" font-size="36" fill="${theme.accent}">计算结果：4</text>`:""}<text x="40" y="210" font-size="24" fill="${theme.text}">cue:${c.started}:${c.frame}:${c.progress.toFixed(3)}</text></svg>`;',
  };
  const scene: Scene = {
    id: 'timed-scene', chapterId: chapter.id, chapter: chapter.title, title: '旁白触发后的结果', layout: 'content', sourceBlockIds: ['source'], objects: [object],
    narration: [
      { id: 'intro-speech', text: '先讲背景，此时不应出现计算结果。', showObjectIds: [object.id], focusObjectId: object.id },
      { id: 'result-speech', text: '现在揭示计算结果：四。', showObjectIds: [object.id], focusObjectId: object.id },
    ],
  };
  const lesson = { schemaVersion: '0.1' as const, title: chapter.title, objectives: ['检查实际旁白起点驱动图形状态'], scenes: [scene] };
  const utterances = scene.narration.map((utterance, index) => ({ utteranceId: utterance.id, startFrame: index ? introFrames : 0, durationFrames: index ? resultFrames : introFrames,
    durationSeconds: (index ? resultFrames : introFrames) / fps, url: '/api/artifacts/motion-timing-fixture.wav', hash: `synthetic-${index}`, cacheHit: false,
    boundaries: [{ kind: 'sentence' as const, text: utterance.text, startSeconds: index ? boundarySeconds : 0, endSeconds: (index ? resultFrames : introFrames) / fps }],
  }));
  const project: Project = { id, title: '独立动效时间验收', markdown: chapter.markdown, chapters: [chapter], sourceMode: 'chapters', settings, assets: [], revision: 1,
    lesson: null, renderPlan: null, previewRevision: null, latestJob: null, chapterJobs: {}, chapterVideos: {}, latestExport: null, createdAt: '2026-10-11T00:00:00Z', updatedAt: '2026-10-11T00:00:00Z' };
  project.chapterVideos![chapter.id] = { chapterId: chapter.id, sourceKey: getChapterSourceKey(project, chapter), settings, lesson,
    renderPlan: { schemaVersion: '0.1', revision: 1, title: chapter.title, fps, width: 1280, height: 720, theme: settings.theme, voice: settings.voice, rate, totalFrames,
      previewMode: 'aligned', narrationAudio: { url: '/api/artifacts/motion-timing-fixture.wav', durationSeconds: totalFrames / fps }, scenes: [{ scene, startFrame: 0, durationFrames: totalFrames, utterances }] },
    previewAssets: [], previewRevision: 1, latestExport: null, updatedAt: project.updatedAt, current: true };
  await page.route(`**/api/projects/${id}`, route => route.request().method() === 'GET' ? route.fulfill({ json: { project } }) : route.abort('blockedbyclient'));
  await page.route('**/api/artifacts/motion-timing-fixture.wav', route => route.fulfill({ contentType: 'audio/wav', body: silenceWav(totalFrames / fps) }));
  await page.goto(`/projects/${id}`);
  await page.getByRole('tab', { name: '视频', exact: true }).click();
  return page.locator('.creation-player-area').getByRole('img', { name: 'AI 自定义图形组件' });
}

for (const variant of [{ name: '短前句／快语速', introFrames: 45, rate: 50, boundarySeconds: 0 }, { name: '通常语速', introFrames: 180, rate: 0, boundarySeconds: 0 }, { name: '长前句／慢语速', introFrames: 510, rate: -50, boundarySeconds: 0 }, { name: '等到句首留白结束', introFrames: 90, rate: 0, boundarySeconds: 0.08 }]) {
  test(`motion cue follows the actual utterance frame: ${variant.name}`, async ({ page }) => {
    const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
    const graphic = await fixture(page, variant.introFrames, variant.rate, variant.boundarySeconds);
    const triggerFrame = variant.introFrames + Math.ceil(variant.boundarySeconds * 30);
    await expect(graphic).toBeVisible();
    for (const frame of [0, Math.floor(triggerFrame * .55), triggerFrame - 1]) {
      await seek(page, frame);
      await expect(graphic).not.toContainText('计算结果：4');
      await expect(graphic).toContainText('cue:false:0:0.000');
    }
    await seek(page, triggerFrame);
    await expect(graphic).toContainText('计算结果：4');
    await expect(graphic).toContainText('cue:true:0:0.000');
    await seek(page, triggerFrame + 30);
    await expect(graphic).toContainText('cue:true:30:');
    // A future cue cannot latch on after seeking backwards from a later frame.
    await seek(page, triggerFrame - 1);
    await expect(graphic).not.toContainText('计算结果：4');
    await expect(graphic).toContainText('cue:false:0:0.000');
    expect(errors).toEqual([]);
  });
}
