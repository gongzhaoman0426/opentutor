import { test as base, expect, type Page } from '@playwright/test';
import { createServer } from 'node:http';
import { mkdir } from 'node:fs/promises';
import { defaultSettings, type GenerationSettings, type JobRecord, type Project, type VideoVersionDetail } from '../../src/shared/schema';
import { getChapterSourceKey, isChapterVideoCurrent } from '../../src/shared/chapters';

const projectId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const a1Id = '11111111-1111-4111-8111-111111111111';
const a2Id = '22222222-2222-4222-8222-222222222222';
const b1Id = '33333333-3333-4333-8333-333333333333';
const a3Id = '44444444-4444-4444-8444-444444444444';
const exportId = '55555555-5555-4555-8555-555555555555';

const test = base.extend<{ downloadOrigin: string }>({
  downloadOrigin: async ({}, use) => {
    const server = createServer((request, response) => {
      const version = request.url?.split('/').at(-1)?.split('?')[0] || 'unknown';
      response.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Disposition': `attachment; filename="${version}.mp4"` });
      response.end('isolated-history-download-fixture');
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    try { await use(`http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`); }
    finally { await new Promise<void>(resolve => server.close(() => resolve())); }
  },
});

function silentWave() {
  const rate = 16000; const bytes = rate * 10 * 2; const buffer = Buffer.alloc(44 + bytes);
  buffer.write('RIFF', 0); buffer.writeUInt32LE(buffer.length - 8, 4); buffer.write('WAVEfmt ', 8);
  buffer.writeUInt32LE(16, 16); buffer.writeUInt16LE(1, 20); buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(rate, 24); buffer.writeUInt32LE(rate * 2, 28); buffer.writeUInt16LE(2, 32); buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36); buffer.writeUInt32LE(bytes, 40); return buffer;
}

function version(id: string, chapterId: string, number: number, inputRevision: number, settings: GenerationSettings, content: string): VideoVersionDetail {
  const scene = { id: `scene-${id}`, chapterId, chapter: chapterId === 'a' ? '第一章' : '第二章', title: `画面 ${chapterId}${number}`, layout: 'content' as const,
    sourceBlockIds: ['source'], objects: [{ id: 'object', type: 'text' as const, content, language: '' }], narration: [{ id: 'utterance', text: `这是第 ${number} 版的独立配音。`, showObjectIds: ['object'], focusObjectId: '' }] };
  const lesson = { schemaVersion: '0.1' as const, title: scene.chapter, objectives: [], scenes: [scene] };
  const url = `/api/artifacts/history-audio-${id}`;
  return { id, version: number, chapterId, chapterTitle: scene.chapter, title: lesson.title, createdAt: `2026-10-10T0${number}:00:00Z`, inputRevision, outputRevision: inputRevision + 1,
    durationSeconds: 10, settings, current: false, videoUrl: null, subtitleUrl: null, exportJobId: null, lesson, assets: [],
    // Results retain the input revision. UI version labels must not reuse it.
    renderPlan: { schemaVersion: '0.1', revision: inputRevision, title: lesson.title, fps: 30, width: settings.resolution === '1080p' ? 1920 : 1280, height: settings.resolution === '1080p' ? 1080 : 720,
      theme: settings.theme, voice: settings.voice, rate: settings.rate, totalFrames: 300, previewMode: 'aligned', narrationAudio: { url, durationSeconds: 10 },
      scenes: [{ scene, startFrame: 0, durationFrames: 300, utterances: [{ utteranceId: 'utterance', startFrame: 0, durationFrames: 300, durationSeconds: 10, url, estimated: false, boundaries: [], hash: id, cacheHit: false }] }] } };
}

async function historyFixture(page: Page, origin: string, options: { exportedOld?: boolean; runningGeneration?: boolean; staleGeneration?: boolean; reusedExport?: 'legacy' | 'other-version' } = {}) {
  const a1 = version(a1Id, 'a', 1, 8, { ...defaultSettings, resolution: '1080p', language: 'en-US', voice: 'en-US-GuyNeural', theme: 'ocean' }, 'A-v1：最初的蓝色画面');
  const a2 = version(a2Id, 'a', 2, 10, { ...defaultSettings, theme: 'sage' }, 'A-v2：当前绿色画面'); a2.current = true;
  const b1 = version(b1Id, 'b', 1, 6, { ...defaultSettings, theme: 'sunset', language: 'ja-JP', voice: 'ja-JP-KeitaNeural' }, 'B-v1：第二章专属画面'); b1.current = true;
  if (options.exportedOld) { a1.videoUrl = `${origin}/history/a-v1`; a1.exportJobId = exportId; }
  if (options.staleGeneration) { a1.current = true; a2.current = false; }
  const versions = options.staleGeneration ? [a1, b1] : [a2, a1, b1];
  let project: Project = { id: projectId, title: '章节视频历史验证', markdown: '# 第一章\n\n当前文稿A\n\n# 第二章\n\n当前文稿B',
    chapters: [{ id: 'a', title: '第一章', markdown: '# 第一章\n\n当前文稿A' }, { id: 'b', title: '第二章', markdown: '# 第二章\n\n当前文稿B', settings: b1.settings }], sourceMode: 'chapters', settings: { ...defaultSettings },
    assets: [], revision: 11, lesson: null, renderPlan: null, previewRevision: null, latestJob: null, latestExport: null, chapterVideos: {}, chapterJobs: {}, createdAt: '2026-10-10T00:00:00Z', updatedAt: '2026-10-10T03:00:00Z' };
  const publish = (value: VideoVersionDetail) => {
    const chapter = project.chapters!.find(item => item.id === value.chapterId)!;
    project.chapterVideos![chapter.id] = { chapterId: chapter.id, sourceKey: getChapterSourceKey(project, chapter), settings: value.settings, lesson: value.lesson,
      renderPlan: { ...value.renderPlan, revision: value.outputRevision! }, previewAssets: value.assets, previewRevision: value.outputRevision!, latestExport: null, updatedAt: value.createdAt, current: true };
  };
  publish(options.staleGeneration ? a1 : a2); publish(b1);
  const makeJob = (value: VideoVersionDetail, kind: 'preview' | 'export', id: string): JobRecord => ({ id, projectId, chapterId: value.chapterId, ...(kind === 'export' ? { videoVersionId: value.id } : {}),
    kind, status: 'running', stage: kind === 'export' ? 'render' : 'speech', completed: 1, total: 2, inputRevision: project.revision, outputRevision: null, error: null, diagnostics: [], videoUrl: null, subtitleUrl: null,
    createdAt: '2026-10-10T04:00:00Z', updatedAt: '2026-10-10T04:00:00Z', sceneId: null, instruction: null,
    snapshot: { id: projectId, title: value.title, markdown: '任务快照里的旧文稿', chapters: [project.chapters!.find(chapter => chapter.id === value.chapterId)!], sourceMode: 'chapters', settings: value.settings,
      assets: value.assets, revision: value.outputRevision!, lesson: value.lesson, renderPlan: value.renderPlan, previewRevision: value.outputRevision!, previewAssets: value.assets },
  });
  const jobs = new Map<string, JobRecord>();
  const exportOrigins = new Map<string, string>();
  if (options.exportedOld) {
    const completed = makeJob(a1, 'export', exportId);
    delete completed.videoVersionId;
    Object.assign(completed, { status: 'succeeded', stage: 'completed', videoUrl: a1.videoUrl, outputRevision: a1.outputRevision, completed: 2 });
    jobs.set(completed.id, completed);
  }
  const a3 = version(a3Id, 'a', 3, 11, { ...defaultSettings }, 'A-v3：后台新生成画面');
  if (options.runningGeneration || options.staleGeneration) {
    const pending = options.staleGeneration ? a2 : a3;
    const job = makeJob(pending, 'preview', pending.id); job.preview = { lesson: pending.lesson, renderPlan: { ...pending.renderPlan, previewMode: 'partial' }, updatedAt: job.updatedAt };
    jobs.set(job.id, job); project.latestJob = job; project.chapterJobs!.a = job;
  }
  const patches: unknown[] = []; const exports: string[] = []; const ordinaryJobs: unknown[] = []; const polledJobIds: string[] = []; let polls = 0;
  await page.route(`**/api/projects/${projectId}`, async route => {
    if (route.request().method() === 'PATCH') { const input = route.request().postDataJSON(); patches.push(input); project = { ...project, ...input, revision: project.revision + 1 }; }
    const chapterVideos = Object.fromEntries(Object.entries(project.chapterVideos!).map(([id, video]) => [id, { ...video, current: isChapterVideoCurrent(project, id) }]));
    await route.fulfill({ json: { project: { ...project, chapterVideos } } });
  });
  await page.route(`**/api/projects/${projectId}/videos?*`, route => {
    const chapterId = new URL(route.request().url()).searchParams.get('chapterId');
    return route.fulfill({ json: { versions: versions.filter(value => value.chapterId === chapterId).map(({ lesson: _lesson, renderPlan: _plan, assets: _assets, ...summary }) => summary) } });
  });
  await page.route(`**/api/projects/${projectId}/videos/*`, route => {
    const id = new URL(route.request().url()).pathname.split('/').at(-1);
    return route.fulfill({ json: { version: versions.find(value => value.id === id) } });
  });
  await page.route(`**/api/projects/${projectId}/videos/*/export`, route => {
    const id = new URL(route.request().url()).pathname.split('/').at(-2)!; exports.push(id);
    const value = versions.find(version => version.id === id)!; const job = makeJob(value, 'export', exportId);
    // The server may find an existing export for identical render data, even
    // when the task predates version IDs or belongs to an equivalent origin.
    if (options.reusedExport === 'legacy') delete job.videoVersionId;
    if (options.reusedExport === 'other-version') job.videoVersionId = '66666666-6666-4666-8666-666666666666';
    exportOrigins.set(job.id, id);
    jobs.set(job.id, job);
    return route.fulfill({ json: { job } });
  });
  await page.route(`**/api/projects/${projectId}/jobs`, route => { ordinaryJobs.push(route.request().postDataJSON()); return route.fulfill({ status: 500, json: { error: 'History must use the immutable version export endpoint' } }); });
  await page.route('**/api/jobs/*/events', route => route.fulfill({ status: 204 }));
  await page.route('**/api/jobs/*', route => { polls++; const id = new URL(route.request().url()).pathname.split('/').at(-1)!; polledJobIds.push(id); return route.fulfill({ json: { job: jobs.get(id) } }); });
  await page.route('**/api/artifacts/history-audio-*', route => route.fulfill({ contentType: 'audio/wav', body: silentWave() }));
  return { a1, a2, b1, versions, patches, exports, ordinaryJobs, polledJobIds, getProject: () => project, polls: () => polls,
    finishExport: () => {
      const job = jobs.get(exportId)!; const value = versions.find(value => value.id === exportOrigins.get(job.id))!;
      Object.assign(job, { status: 'succeeded', stage: 'completed', outputRevision: value.outputRevision, videoUrl: `${origin}/history/a-v${value.version}`, completed: 2, updatedAt: '2026-10-10T04:00:01Z' });
      value.videoUrl = job.videoUrl; value.exportJobId = job.id;
    },
    finishGeneration: () => {
      const job = jobs.get(a3Id)!; Object.assign(job, { status: 'succeeded', stage: 'completed', outputRevision: 12, completed: 2, updatedAt: '2026-10-10T04:00:01Z' });
      a2.current = false; a3.current = true; versions.unshift(a3); project.revision = 12; publish(a3);
    },
    finishUnpublishedGeneration: () => {
      const job = jobs.get(a2Id)!;
      Object.assign(job, { status: 'succeeded', stage: 'completed', outputRevision: null, completed: 2, updatedAt: '2026-10-10T04:00:01Z',
        preview: { lesson: a2.lesson, renderPlan: a2.renderPlan, updatedAt: '2026-10-10T04:00:01Z' } });
      a2.outputRevision = null; a2.current = false; a1.current = true; versions.unshift(a2);
    },
  };
}

async function openVideo(page: Page) {
  await page.goto(`/projects/${projectId}`);
  await page.getByRole('tab', { name: '视频', exact: true }).click();
  await expect(page.getByLabel('视频版本', { exact: true })).toBeVisible();
}

test('numbers two videos v1/v2 despite document revision 11 and switches their own picture, voice, settings, and download', async ({ page, downloadOrigin }) => {
  const data = await historyFixture(page, downloadOrigin, { exportedOld: true });
  await openVideo(page);
  const select = page.getByLabel('视频版本', { exact: true });
  await expect(select.locator(`option[value="${a1Id}"]`)).toContainText('v1');
  await expect(select.locator(`option[value="${a2Id}"]`)).toContainText('v2');
  await expect(select).not.toContainText('v11');
  await expect(page.getByText('A-v2：当前绿色画面', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '播放预览', exact: true }).click();
  await expect(page.getByRole('button', { name: '暂停预览', exact: true })).toBeVisible();
  await select.selectOption(a1Id);
  await expect(page.getByText('A-v1：最初的蓝色画面', { exact: true })).toBeVisible();
  await expect(page.getByText('A-v2：当前绿色画面', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '播放预览', exact: true })).toBeVisible();
  await expect(page.getByLabel('所选版本设置', { exact: true })).toContainText('1080p');
  await expect(page.getByLabel('所选版本设置', { exact: true })).toContainText('Guy');
  await page.getByRole('button', { name: '播放预览', exact: true }).click();
  await expect.poll(() => page.locator('audio').evaluateAll(nodes => nodes.map(node => node as HTMLAudioElement).filter(node => !node.paused).map(node => node.currentSrc || node.src))).toContain(new URL(`/api/artifacts/history-audio-${a1Id}`, page.url()).href);
  const downloaded = page.waitForEvent('download');
  await page.getByRole('button', { name: '下载视频', exact: true }).click();
  expect((await downloaded).suggestedFilename()).toBe('a-v1.mp4');
  expect(data.patches).toEqual([]); expect(data.exports).toEqual([]); expect(data.ordinaryJobs).toEqual([]);
  expect(data.getProject().revision).toBe(11);
});

test('exports the chosen historical video without saving its old source over the edited chapter or adding a video version', async ({ page, downloadOrigin }) => {
  const data = await historyFixture(page, downloadOrigin);
  await openVideo(page);
  await page.getByLabel('章节 Markdown').fill('# 当前文稿\n\n继续编辑，保留这段新内容。');
  await expect.poll(() => data.patches.length).toBe(1);
  await page.getByLabel('视频版本', { exact: true }).selectOption(a1Id);
  await expect(page.getByText('A-v1：最初的蓝色画面', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '下载视频', exact: true }).click();
  await expect.poll(() => data.exports).toEqual([a1Id]);
  const downloaded = page.waitForEvent('download'); data.finishExport();
  expect((await downloaded).suggestedFilename()).toBe('a-v1.mp4');
  await expect(page.getByLabel('章节 Markdown')).toHaveValue('# 当前文稿\n\n继续编辑，保留这段新内容。');
  await expect(page.getByLabel('视频版本', { exact: true })).toHaveValue(a1Id);
  await expect(page.getByLabel('视频版本', { exact: true }).locator('option')).toHaveCount(3);
  expect(data.patches).toHaveLength(1); expect(data.ordinaryJobs).toEqual([]);
  expect(data.getProject().revision).toBe(12);
  expect(data.getProject().chapterVideos!.a.previewRevision).toBe(11);
  expect(data.getProject().chapterVideos!.a.settings.voice).toBe(defaultSettings.voice);
  expect(data.getProject().chapterVideos!.a.latestExport).toBeNull();
});

for (const reusedExport of ['legacy', 'other-version'] as const) {
  test(`downloads a matching reused ${reusedExport} export by returned job ID`, async ({ page, downloadOrigin }) => {
    const data = await historyFixture(page, downloadOrigin, { reusedExport });
    await openVideo(page);
    await page.getByLabel('视频版本', { exact: true }).selectOption(a1Id);
    await expect(page.getByText('A-v1：最初的蓝色画面', { exact: true })).toBeVisible();
    if (reusedExport === 'legacy') {
      await mkdir('.data/verification/video-history', { recursive: true });
      await page.screenshot({ path: '.data/verification/video-history/selected-v1.png' });
    }
    await page.getByRole('button', { name: '下载视频', exact: true }).click();
    await expect.poll(() => data.exports).toEqual([a1Id]);
    await expect(page.locator('.chapter-alert[role="alert"]')).toHaveCount(0);
    const downloaded = page.waitForEvent('download'); data.finishExport();
    expect((await downloaded).suggestedFilename()).toBe('a-v1.mp4');
    expect(data.polledJobIds).toContain(exportId);
    await expect(page.getByLabel('视频版本', { exact: true })).toHaveValue(a1Id);
    await expect(page.getByText('A-v1：最初的蓝色画面', { exact: true })).toBeVisible();
    expect(data.patches).toEqual([]); expect(data.ordinaryJobs).toEqual([]);
    expect(data.getProject().chapterJobs).toEqual({});
  });
}

test('directly downloads an existing historical MP4 without polling its completed export or replacing the current generation', async ({ page, downloadOrigin }) => {
  const data = await historyFixture(page, downloadOrigin, { exportedOld: true, runningGeneration: true });
  await openVideo(page);
  await page.getByLabel('视频版本', { exact: true }).selectOption(a1Id);
  await expect(page.getByText('A-v1：最初的蓝色画面', { exact: true })).toBeVisible();
  // Let the live generation poll at least once; the already finished export
  // must never join that polling set just because it appears in the summary.
  await expect.poll(() => data.polledJobIds).toContain(a3Id);
  expect(data.polledJobIds).not.toContain(exportId);
  await expect(page.locator('.chapter-status-footer')).toContainText('生成微软配音');
  const downloaded = page.waitForEvent('download');
  await page.getByRole('button', { name: '下载视频', exact: true }).click();
  expect((await downloaded).suggestedFilename()).toBe('a-v1.mp4');
  await expect(page.getByLabel('视频版本', { exact: true })).toHaveValue(a1Id);
  await expect(page.getByText('A-v1：最初的蓝色画面', { exact: true })).toBeVisible();
  await expect(page.locator('.chapter-status-footer')).toContainText('生成微软配音');
  expect(data.polledJobIds).not.toContain(exportId);
  expect(data.exports).toEqual([]); expect(data.patches).toEqual([]);
});

test('keeps an explicitly selected historical version when a newer generation finishes and polling refreshes the project', async ({ page, downloadOrigin }) => {
  const data = await historyFixture(page, downloadOrigin, { runningGeneration: true });
  await openVideo(page);
  await page.getByLabel('视频版本', { exact: true }).selectOption(a1Id);
  await expect(page.getByText('A-v1：最初的蓝色画面', { exact: true })).toBeVisible();
  const priorPolls = data.polls(); data.finishGeneration();
  await expect.poll(data.polls).toBeGreaterThan(priorPolls);
  await expect(page.getByLabel('视频版本', { exact: true }).locator(`option[value="${a3Id}"]`)).toContainText('v3');
  await expect(page.getByLabel('视频版本', { exact: true })).toHaveValue(a1Id);
  await expect(page.getByText('A-v1：最初的蓝色画面', { exact: true })).toBeVisible();
  await expect(page.getByText('A-v3：后台新生成画面', { exact: true })).toHaveCount(0);
  await page.getByLabel('视频版本', { exact: true }).selectOption('latest');
  await expect(page.getByText('A-v3：后台新生成画面', { exact: true })).toBeVisible();
  expect(data.patches).toEqual([]);
});

test('keeps published v1 downloadable when an edited chapter leaves completed v2 unpublished, while v2 remains selectable', async ({ page, downloadOrigin }) => {
  const data = await historyFixture(page, downloadOrigin, { staleGeneration: true, exportedOld: true });
  await openVideo(page);
  await expect(page.getByText('A-v2：当前绿色画面', { exact: true })).toBeVisible();
  await page.getByLabel('章节 Markdown').fill('# 生成中编辑\n\n这段新内容不能被未发布的结果覆盖。');
  await expect.poll(() => data.patches.length).toBe(1);
  const previousPolls = data.polls(); data.finishUnpublishedGeneration();
  await expect.poll(data.polls).toBeGreaterThan(previousPolls);
  const select = page.getByLabel('视频版本', { exact: true });
  await expect(select.locator(`option[value="${a2Id}"]`)).toContainText('v2');
  await expect(select).toHaveValue('latest');
  await expect(select.locator('option[value="latest"]')).toContainText('v1');
  await expect(page.getByText('A-v1：最初的蓝色画面', { exact: true })).toBeVisible();
  await expect(page.getByText('A-v2：当前绿色画面', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '下载视频', exact: true })).toBeEnabled();
  const firstDownload = page.waitForEvent('download');
  await page.getByRole('button', { name: '下载视频', exact: true }).click();
  expect((await firstDownload).suggestedFilename()).toBe('a-v1.mp4');
  await select.selectOption(a2Id);
  await expect(page.getByText('A-v2：当前绿色画面', { exact: true })).toBeVisible();
  await expect(page.locator('.creation-preview-toolbar')).toContainText('视频预览');
  await expect(page.getByRole('button', { name: '下载视频', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: '下载视频', exact: true }).click();
  await expect.poll(() => data.exports).toEqual([a2Id]);
  const secondDownload = page.waitForEvent('download'); data.finishExport();
  expect((await secondDownload).suggestedFilename()).toBe('a-v2.mp4');
  await expect(page.getByLabel('章节 Markdown')).toHaveValue('# 生成中编辑\n\n这段新内容不能被未发布的结果覆盖。');
  expect(data.getProject().chapterVideos!.a.previewRevision).toBe(9);
  expect(data.versions.filter(value => value.chapterId === 'a')).toHaveLength(2);
  expect(data.patches).toHaveLength(1);
});

test('ignores an old chapter detail response that arrives after selecting a different chapter', async ({ page, downloadOrigin }) => {
  await historyFixture(page, downloadOrigin);
  await page.addInitScript(() => {
    const original = window.fetch.bind(window);
    window.fetch = (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      return original(input, url.includes('/videos/') ? { ...init, signal: undefined } : init);
    };
  });
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; }); let requested = false;
  const stale = version(a1Id, 'a', 1, 8, { ...defaultSettings }, 'A-v1：不应串入第二章的迟到画面');
  await page.route(`**/api/projects/${projectId}/videos/${a1Id}`, async route => { requested = true; await gate; await route.fulfill({ json: { version: stale } }); });
  try {
    await openVideo(page);
    await page.getByLabel('视频版本', { exact: true }).selectOption(a1Id);
    await expect.poll(() => requested).toBe(true);
    await expect(page.getByText('A-v2：当前绿色画面', { exact: true })).toHaveCount(0);
    await page.getByRole('navigation', { name: '项目章节' }).getByRole('button', { name: '02 第二章' }).click();
    await expect(page.getByText('B-v1：第二章专属画面', { exact: true })).toBeVisible();
    const lateResponse = page.waitForResponse(response => response.url().endsWith(`/videos/${a1Id}`)); release(); await (await lateResponse).finished();
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    await expect(page.getByText('B-v1：第二章专属画面', { exact: true })).toBeVisible();
    await expect(page.getByText('A-v1：不应串入第二章的迟到画面', { exact: true })).toHaveCount(0);
    await expect(page.getByLabel('视频版本', { exact: true }).locator(`option[value="${a1Id}"]`)).toHaveCount(0);
    await expect(page.getByLabel('所选版本设置', { exact: true })).toContainText('Keita');
  } finally { release(); }
});
