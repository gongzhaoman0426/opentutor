import { test as base, expect, type Page } from '@playwright/test';
import { defaultSettings, type JobRecord, type Project, type Scene } from '../../src/shared/schema';
import { getChapterSourceKey, isChapterVideoCurrent } from '../../src/shared/chapters';
import { mkdir } from 'node:fs/promises';
import { createServer } from 'node:http';

// Chromium downloads do not go through page.route; serve a tiny attachment
// directly so this case verifies the chosen chapter URL and filename.
const test = base.extend<{ downloadOrigin: string }>({
  downloadOrigin: async ({}, use) => {
    const server = createServer((request, response) => {
      response.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Disposition': `attachment; filename="${request.url?.includes('chapter-a') ? 'chapter-a' : 'chapter-b'}.mp4"` });
      response.end('download-fixture');
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    try { await use(`http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`); }
    finally { await new Promise<void>(resolve => server.close(() => resolve())); }
  },
});

const voiceCatalog = [
  { name: 'zh-CN-XiaoxiaoNeural', locale: 'zh-CN', gender: 'Female', displayName: '晓晓' },
  { name: 'zh-CN-YunxiNeural', locale: 'zh-CN', gender: 'Male', displayName: '云希' },
  { name: 'en-US-AriaNeural', locale: 'en-US', gender: 'Female', displayName: 'Aria' },
  { name: 'en-US-GuyNeural', locale: 'en-US', gender: 'Male', displayName: 'Guy' },
  { name: 'ja-JP-NanamiNeural', locale: 'ja-JP', gender: 'Female', displayName: 'Nanami' },
  { name: 'ja-JP-KeitaNeural', locale: 'ja-JP', gender: 'Male', displayName: 'Keita' },
  // Related languages with different locales must not leak into these choices.
  { name: 'en-GB-SoniaNeural', locale: 'en-GB', gender: 'Female', displayName: 'Sonia' },
  { name: 'zh-HK-HiuMaanNeural', locale: 'zh-HK', gender: 'Female', displayName: 'HiuMaan' },
];

async function fixture(page: Page, downloadOrigin = '') {
  const id = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
  let project: Project = {
    id, title: '独立章节视频验证', markdown: '# 第一章\n\n认识细胞膜。\n\n# 第二章\n\n认识细胞核。',
    chapters: [{ id: 'chapter-a', title: '细胞膜', markdown: '# 细胞膜\n\n认识细胞膜。' }, { id: 'chapter-b', title: '细胞核', markdown: '# 细胞核\n\n认识细胞核。' }],
    sourceMode: 'chapters', settings: { ...defaultSettings }, assets: [], revision: 3, lesson: null, renderPlan: null, previewRevision: null,
    latestJob: null, chapterJobs: {}, chapterVideos: {}, latestExport: null, createdAt: '2026-10-09T00:00:00Z', updatedAt: '2026-10-09T00:00:00Z',
  };
  for (const chapter of project.chapters!) {
    const scene: Scene = { id: `scene-${chapter.id}`, title: `${chapter.title}独立画面`, chapter: chapter.title, chapterId: chapter.id, layout: 'content', sourceBlockIds: ['source'], objects: [{ id: 'object', type: 'text', content: `${chapter.title}专属讲解内容`, language: '' }], narration: [{ id: 'utterance', text: chapter.title, showObjectIds: ['object'], focusObjectId: '' }] };
    const lesson = { schemaVersion: '0.1' as const, title: chapter.title, objectives: ['学习知识'], scenes: [scene] };
    project.chapterVideos![chapter.id] = { chapterId: chapter.id, sourceKey: getChapterSourceKey(project, chapter), settings: { ...defaultSettings }, lesson,
      renderPlan: { schemaVersion: '0.1', revision: 2, title: chapter.title, fps: 30, width: 1280, height: 720, theme: 'sage', voice: defaultSettings.voice, rate: defaultSettings.rate, totalFrames: 90, previewMode: 'aligned', scenes: [{ scene, startFrame: 0, durationFrames: 90, utterances: [{ utteranceId: 'utterance', startFrame: 0, durationFrames: 90, durationSeconds: 3, url: '', estimated: true, hash: 'fixture', cacheHit: false, boundaries: [] }] }] },
      previewAssets: [], previewRevision: 2, latestExport: { jobId: `export-${chapter.id}`, revision: 2, videoUrl: `${downloadOrigin}/api/artifacts/${chapter.id}-video` }, updatedAt: project.updatedAt, current: true };
  }
  const snapshot = (sourceKey: string) => ({ id: project.id, title: project.title, markdown: project.markdown, chapters: structuredClone(project.chapters!), sourceMode: project.sourceMode, settings: { ...project.settings }, assets: project.assets, revision: project.revision, lesson: null, chapterSourceKey: sourceKey });
  const originalChapter = project.chapters![0];
  const output = project.chapterVideos![originalChapter.id];
  const published: JobRecord = { id: 'published-task', projectId: id, chapterId: originalChapter.id, kind: 'preview', status: 'succeeded', stage: 'completed', completed: 1, total: 1, inputRevision: 1, outputRevision: 2, error: null, diagnostics: [], videoUrl: null, subtitleUrl: null, createdAt: project.createdAt, updatedAt: '2026-10-09T00:00:01Z', snapshot: snapshot(output.sourceKey), sceneId: null, instruction: null, preview: { lesson: output.lesson, renderPlan: { ...output.renderPlan!, revision: 1 }, updatedAt: project.updatedAt } };
  project.chapterJobs![originalChapter.id] = published; project.latestJob = published;
  const submitted: { kind: string; chapterId: string; expectedRevision: number }[] = [];
  const hydrate = () => ({ ...project, chapterVideos: Object.fromEntries(Object.entries(project.chapterVideos ?? {}).map(([chapterId, video]) => [chapterId, { ...video, current: isChapterVideoCurrent(project, chapterId) }])) });
  // This legacy fixture has only a published snapshot, no retained generation result.
  await page.route(`**/api/projects/${id}/videos?*`, route => route.fulfill({ json: { versions: [] } }));
  await page.route(`**/api/projects/${id}`, async route => {
    if (route.request().method() === 'PATCH') { const input = route.request().postDataJSON(); if (input.expectedRevision !== project.revision) { await route.fulfill({ status: 409, json: { error: '版本已更新' } }); return; } project = { ...project, ...input, revision: project.revision + 1 }; }
    await route.fulfill({ json: { project: hydrate() } });
  });
  await page.route(`**/api/projects/${id}/jobs`, async route => {
    const input = route.request().postDataJSON(); submitted.push(input);
    const chapter = project.chapters!.find(chapter => chapter.id === input.chapterId)!;
    const job: JobRecord = { id: chapter.id === 'chapter-a' ? 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee' : 'ffffffff-ffff-4fff-8fff-ffffffffffff', projectId: id, chapterId: chapter.id, kind: input.kind, status: 'queued', stage: 'queued', completed: 0, total: 1, inputRevision: project.revision, outputRevision: null, error: null, diagnostics: [], videoUrl: null, subtitleUrl: null, createdAt: project.createdAt, updatedAt: project.updatedAt, snapshot: snapshot(getChapterSourceKey(project, chapter)), sceneId: null, instruction: null };
    project = { ...project, latestJob: job, chapterJobs: { ...project.chapterJobs, [chapter.id]: job } };
    await route.fulfill({ json: { job } });
  });
  await page.route(/\/api\/jobs\/(?:eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee|ffffffff-ffff-4fff-8fff-ffffffffffff)\/events$/, route => route.fulfill({ status: 204 }));
  await page.route(/\/api\/jobs\/(?:eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee|ffffffff-ffff-4fff-8fff-ffffffffffff)$/, route => route.fulfill({ json: { job: Object.values(project.chapterJobs!).find(job => route.request().url().endsWith(job.id)) } }));
  await page.route('**/api/models', route => route.fulfill({ json: { models: [{ id: 'catalog-model-default', displayName: '当前默认模型', isDefault: true }, { id: 'catalog-model-creative', displayName: '可选创作模型', description: '浏览器测试中的实际接口返回项' }], cached: true } }));
  await page.route('**/api/voices', route => route.fulfill({ json: { voices: voiceCatalog } }));

  return { id, getProject: () => project, submitted, removeExports: () => { for (const video of Object.values(project.chapterVideos!)) video.latestExport = null; }, completePending: (chapterId?: string) => {
    for (const pending of Object.values(project.chapterJobs!)) if (pending.status === 'queued' && (!chapterId || pending.chapterId === chapterId)) {
      project.revision++; const video = project.chapterVideos![pending.chapterId!];
      const completed: JobRecord = { ...pending, status: 'succeeded', stage: 'completed', outputRevision: video.previewRevision, videoUrl: `${downloadOrigin}/api/artifacts/${pending.chapterId}-video`, updatedAt: '2026-10-09T00:00:03Z' };
      project.chapterJobs![pending.chapterId!] = completed; if (project.latestJob?.id === pending.id) project.latestJob = completed;
      video.latestExport = { jobId: pending.id, revision: video.previewRevision, videoUrl: completed.videoUrl! };
    }
  } };
}

test('switches chapter previews and downloads independently, keeping another chapter current after an edit', async ({ page, downloadOrigin }) => {
  const data = await fixture(page, downloadOrigin);
  await page.goto(`/projects/${data.id}`);
  await page.getByRole('tab', { name: '视频', exact: true }).click();
  await expect(page.getByText('细胞膜独立画面', { exact: true })).toBeVisible();
  await expect(page.locator('.creation-preview-toolbar')).not.toContainText('v2');
  const firstDownload = page.waitForEvent('download');
  await page.getByRole('button', { name: '下载视频', exact: true }).click();
  expect((await firstDownload).suggestedFilename()).toBe('chapter-a.mp4');
  await page.getByRole('navigation', { name: '项目章节' }).getByRole('button', { name: '02 细胞核' }).click();
  await expect(page.getByText('细胞核独立画面', { exact: true })).toBeVisible();
  await expect(page.getByText('细胞膜独立画面', { exact: true })).toHaveCount(0);
  const secondDownload = page.waitForEvent('download');
  await page.getByRole('button', { name: '下载视频', exact: true }).click();
  expect((await secondDownload).suggestedFilename()).toBe('chapter-b.mp4');
  await page.getByLabel('章节 Markdown').fill('# 细胞核\n\n这一章已更新，旧预览仍保留。');
  await expect(page.getByRole('button', { name: '下载视频', exact: true })).toBeEnabled();
  const retainedDownload = page.waitForEvent('download');
  await page.getByRole('button', { name: '下载视频', exact: true }).click();
  expect((await retainedDownload).suggestedFilename()).toBe('chapter-b.mp4');
  await expect(page.getByText('细胞核独立画面', { exact: true })).toBeVisible();
  await page.getByRole('navigation', { name: '项目章节' }).getByRole('button', { name: '01 细胞膜' }).click();
  await expect(page.getByText('细胞膜独立画面', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '下载视频', exact: true })).toBeEnabled();
  expect(data.submitted).toEqual([]);
});

test('persists per-chapter configuration, auditions the selected voice, and submits the chosen chapter', async ({ page }) => {
  const data = await fixture(page);
  let audition: unknown;
  await page.route('**/api/voices/preview', async route => { audition = route.request().postDataJSON(); await route.fulfill({ json: { speech: { url: '/api/artifacts/audition-fixture', durationSeconds: 1, boundaries: [], hash: 'fixture', cacheHit: false } } }); });
  await page.route('**/api/artifacts/audition-fixture', route => route.fulfill({ contentType: 'audio/wav', body: Buffer.alloc(44) }));
  await page.goto(`/projects/${data.id}`);
  await page.getByRole('button', { name: '更新视频', exact: true }).click();
  const modal = page.getByRole('dialog');
  await expect(modal.getByLabel('视频用途', { exact: true })).toHaveValue('auto');
  await modal.getByLabel('视频用途', { exact: true }).selectOption('product');
  await modal.getByLabel('创作要求', { exact: true }).fill('面向首次使用的新用户，先呈现问题，再展示操作，不添加原稿没有的功能。');
  await modal.getByLabel('目标观众', { exact: true }).fill('第一次使用产品的用户');
  await modal.getByLabel('视频分辨率').selectOption('1080p');
  await modal.getByLabel('视频语言', { exact: true }).selectOption('en-US');
  await modal.getByLabel('微软免费配音').selectOption('en-US-GuyNeural');
  await modal.getByRole('button', { name: '试听当前音色' }).click();
  await expect.poll(() => audition).toEqual({ voice: 'en-US-GuyNeural', rate: 0 });
  await modal.getByLabel('风格描述').fill('蓝白配色、留白充足，用橙色强调关键元素。');
  await modal.getByRole('button', { name: '理性蓝调', exact: false }).click();
  await modal.getByRole('button', { name: '创作模式', exact: false }).click();
  await modal.getByLabel('AI 模型').selectOption('catalog-model-creative');
  await mkdir('.data/verification', { recursive: true });
  await modal.getByLabel('视频用途', { exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: '.data/verification/generation-settings-fixture.png' });
  await modal.getByRole('button', { name: '保存设置', exact: true }).click();
  await expect(modal).toHaveCount(0);
  expect(data.getProject().chapters![0].settings).toMatchObject({ resolution: '1080p', language: 'en-US', voice: 'en-US-GuyNeural', theme: 'ocean', model: 'catalog-model-creative', creationMode: 'creative', stylePrompt: '蓝白配色、留白充足，用橙色强调关键元素。', videoIntent: 'product', creativeBrief: '面向首次使用的新用户，先呈现问题，再展示操作，不添加原稿没有的功能。', audience: '第一次使用产品的用户' });
  expect(data.getProject().settings).toEqual(data.getProject().chapters![0].settings);
  expect(data.getProject().chapters![1].settings).toEqual(defaultSettings);
  expect(isChapterVideoCurrent(data.getProject(), 'chapter-b')).toBe(true);
  await page.reload();
  await page.getByRole('button', { name: '更新视频', exact: true }).click();
  await expect(page.getByLabel('视频分辨率')).toHaveValue('1080p');
  await expect(page.getByLabel('视频语言', { exact: true })).toHaveValue('en-US');
  await expect(page.getByLabel('微软免费配音')).toHaveValue('en-US-GuyNeural');
  await expect(page.getByLabel('风格描述')).toHaveValue('蓝白配色、留白充足，用橙色强调关键元素。');
  await expect(page.getByLabel('视频用途', { exact: true })).toHaveValue('product');
  await expect(page.getByLabel('创作要求', { exact: true })).toHaveValue('面向首次使用的新用户，先呈现问题，再展示操作，不添加原稿没有的功能。');
  await expect(page.getByLabel('目标观众', { exact: true })).toHaveValue('第一次使用产品的用户');
  await page.getByRole('button', { name: '生成本章视频', exact: true }).click();
  await expect.poll(() => data.submitted.length).toBe(1);
  expect(data.submitted[0]).toMatchObject({ kind: 'preview', chapterId: 'chapter-a', expectedRevision: data.getProject().revision });
  await expect(page.getByRole('tab', { name: '视频', exact: true })).toHaveAttribute('aria-selected', 'true');
});

test('remembers saved settings for subsequent chapters and new chapters across reloads', async ({ page }) => {
  const data = await fixture(page);
  data.getProject().chapterVideos = {};
  data.getProject().chapterJobs = {};
  data.getProject().latestJob = null;
  data.getProject().chapters!.push({ id: 'chapter-custom', title: '独立参数', markdown: '# 已配置', settings: { ...defaultSettings, rate: 25 } });
  await page.goto(`/projects/${data.id}`);
  await page.getByRole('button', { name: '当前章节生成设置', exact: true }).click();
  const modal = page.getByRole('dialog');
  await expect(modal).toContainText('后续未配置的章节会自动沿用');
  await modal.getByLabel('视频分辨率').selectOption('1080p');
  await modal.getByLabel('视频语言', { exact: true }).selectOption('ja-JP');
  await modal.getByLabel('微软免费配音').selectOption('ja-JP-KeitaNeural');
  await modal.getByLabel('AI 模型').selectOption('catalog-model-creative');
  await modal.getByRole('button', { name: '创作模式', exact: false }).click();
  await modal.getByLabel('风格描述').fill('蓝白配色，统一视觉');
  await modal.getByRole('button', { name: '保存设置', exact: true }).click();
  await expect(modal).toHaveCount(0);
  expect(data.getProject().chapters![1].settings).toBeUndefined();
  expect(data.getProject().chapters![2].settings?.rate).toBe(25);
  await page.reload();
  await page.getByRole('navigation', { name: '项目章节' }).getByRole('button', { name: '02 细胞核' }).click();
  await page.getByRole('button', { name: '当前章节生成设置', exact: true }).click();
  await expect(modal.getByLabel('视频分辨率')).toHaveValue('1080p');
  await expect(modal.getByLabel('视频语言', { exact: true })).toHaveValue('ja-JP');
  await expect(modal.getByLabel('微软免费配音')).toHaveValue('ja-JP-KeitaNeural');
  await expect(modal.getByLabel('AI 模型')).toHaveValue('catalog-model-creative');
  await expect(modal.getByRole('button', { name: '创作模式', exact: false })).toHaveAttribute('aria-pressed', 'true');
  await expect(modal.getByLabel('风格描述')).toHaveValue('蓝白配色，统一视觉');
  await modal.getByLabel('风格描述').fill('蓝白配色，强调标题');
  await modal.getByRole('button', { name: '生成本章视频', exact: true }).click();
  await expect.poll(() => data.submitted.length).toBe(1);
  expect(data.submitted[0].chapterId).toBe('chapter-b');
  expect(data.getProject().settings.stylePrompt).toBe('蓝白配色，强调标题');
  expect(data.getProject().chapters![0].settings?.stylePrompt).toBe('蓝白配色，统一视觉');
  await page.getByRole('button', { name: '添加章节', exact: true }).click();
  await page.getByRole('button', { name: '当前章节生成设置', exact: true }).click();
  await expect(modal.getByLabel('视频分辨率')).toHaveValue('1080p');
  await expect(modal.getByLabel('视频语言', { exact: true })).toHaveValue('ja-JP');
  await expect(modal.getByLabel('微软免费配音')).toHaveValue('ja-JP-KeitaNeural');
  await expect(modal.getByLabel('风格描述')).toHaveValue('蓝白配色，强调标题');
  await modal.getByRole('button', { name: '关闭生成设置' }).click();
  await page.getByRole('navigation', { name: '项目章节' }).getByRole('button', { name: '03 独立参数' }).click();
  await page.getByRole('button', { name: '当前章节生成设置', exact: true }).click();
  await expect(modal.getByLabel('视频分辨率')).toHaveValue(defaultSettings.resolution);
  await expect(modal.getByLabel('视频语言', { exact: true })).toHaveValue(defaultSettings.language);
  await expect(modal.getByLabel('微软免费配音')).toHaveValue(defaultSettings.voice);
  await expect(modal.getByLabel('配音语速')).toHaveValue('25');
});

test('offers catalog languages and strictly filters Chinese, English, and Japanese voices by locale', async ({ page }) => {
  const data = await fixture(page);
  await page.goto(`/projects/${data.id}`);
  await page.getByRole('button', { name: '当前章节生成设置', exact: true }).click();
  const modal = page.getByRole('dialog');
  const language = modal.getByLabel('视频语言', { exact: true });
  const voice = modal.getByLabel('微软免费配音');
  await expect(language).toHaveValue('zh-CN');
  await expect.poll(() => language.locator('option').evaluateAll(options => options.map(option => (option as HTMLOptionElement).value)))
    .toEqual(expect.arrayContaining(['zh-CN', 'en-US', 'ja-JP', 'en-GB', 'zh-HK']));
  for (const locale of ['zh-CN', 'en-US', 'ja-JP']) {
    await language.selectOption(locale);
    const expected = voiceCatalog.filter(item => item.locale === locale).map(item => item.name).sort();
    await expect.poll(() => voice.locator('option').evaluateAll(options => options.map(option => (option as HTMLOptionElement).value).sort())).toEqual(expected);
    expect(expected).toContain(await voice.inputValue());
    // Choose a non-default voice before moving to the next language, so stale
    // cross-language selections cannot accidentally satisfy the next check.
    await voice.selectOption(expected[expected.length - 1]);
  }
  expect(data.submitted).toEqual([]);
});

test('allows language and voice selection while the model catalog is still loading', async ({ page }) => {
  const data = await fixture(page);
  let releaseModels!: () => void;
  const modelGate = new Promise<void>(resolve => { releaseModels = resolve; });
  let modelsRequested = false;
  let modelsCompleted = false;
  await page.route('**/api/models', async route => {
    modelsRequested = true;
    await modelGate;
    await route.fulfill({ json: { models: [{ id: 'catalog-model-default', displayName: '当前默认模型', isDefault: true }], cached: true } });
    modelsCompleted = true;
  });
  try {
    await page.goto(`/projects/${data.id}`);
    await page.getByRole('button', { name: '当前章节生成设置', exact: true }).click();
    const modal = page.getByRole('dialog');
    await expect.poll(() => modelsRequested).toBe(true);
    await modal.getByLabel('视频语言', { exact: true }).selectOption('ja-JP');
    await modal.getByLabel('微软免费配音').selectOption('ja-JP-KeitaNeural');
    await expect(modal.getByLabel('视频语言', { exact: true })).toHaveValue('ja-JP');
    await expect(modal.getByLabel('微软免费配音')).toHaveValue('ja-JP-KeitaNeural');
    expect(modelsCompleted).toBe(false);
  } finally {
    releaseModels();
    await expect.poll(() => modelsCompleted).toBe(true);
  }
});

test('requires a matching voice before generating from inconsistent historical language settings', async ({ page }) => {
  const data = await fixture(page);
  data.getProject().chapters![0].settings = { ...defaultSettings, language: 'ja-JP', voice: 'zh-CN-XiaoxiaoNeural' };
  await page.goto(`/projects/${data.id}`);
  await page.getByRole('button', { name: '当前章节生成设置', exact: true }).click();
  const modal = page.getByRole('dialog');
  await expect(modal.getByLabel('视频语言', { exact: true })).toHaveValue('ja-JP');
  await expect(modal.getByLabel('微软免费配音')).toHaveValue('');
  await expect(modal.getByRole('button', { name: '生成本章视频', exact: true })).toBeDisabled();
  await expect(modal.getByRole('button', { name: '保存设置', exact: true })).toBeEnabled();
  expect(data.getProject().chapters![0].settings?.voice).toBe('zh-CN-XiaoxiaoNeural');
  await modal.getByLabel('微软免费配音').selectOption('ja-JP-KeitaNeural');
  await expect(modal.getByRole('button', { name: '生成本章视频', exact: true })).toBeEnabled();
  await mkdir('.data/verification/video-languages', { recursive: true });
  await modal.getByLabel('视频语言', { exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: '.data/verification/video-languages/settings.png' });
  await modal.getByRole('button', { name: '生成本章视频', exact: true }).click();
  await expect.poll(() => data.submitted.length).toBe(1);
  expect(data.getProject().chapters![0].settings).toMatchObject({ language: 'ja-JP', voice: 'ja-JP-KeitaNeural' });
  expect(data.submitted[0]).toMatchObject({ kind: 'preview', chapterId: 'chapter-a' });
});

test('discards a late voice audition after changing language and removes the previous language audio', async ({ page }) => {
  const data = await fixture(page);
  // Simulate a response that has already escaped transport cancellation. The
  // component still needs to ignore its result after the selection changes.
  await page.addInitScript(() => {
    const originalFetch = window.fetch.bind(window);
    window.fetch = (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      return originalFetch(input, url.endsWith('/api/voices/preview') ? { ...init, signal: undefined } : init);
    };
  });
  let releaseOld!: () => void;
  const oldGate = new Promise<void>(resolve => { releaseOld = resolve; });
  const auditions: Array<{ voice: string; rate: number }> = [];
  const audioRequests: string[] = [];
  await page.route('**/api/voices/preview', async route => {
    const input = route.request().postDataJSON(); auditions.push(input);
    const old = input.voice === defaultSettings.voice;
    if (old) await oldGate;
    await route.fulfill({ json: { speech: { url: `/api/artifacts/audition-${old ? 'old' : 'current'}`, durationSeconds: 1, boundaries: [], hash: input.voice, cacheHit: false } } });
  });
  await page.route('**/api/artifacts/audition-*', route => {
    audioRequests.push(route.request().url());
    return route.fulfill({ contentType: 'audio/wav', body: Buffer.alloc(44) });
  });
  try {
    await page.goto(`/projects/${data.id}`);
    await page.getByRole('button', { name: '当前章节生成设置', exact: true }).click();
    const modal = page.getByRole('dialog');
    const audio = modal.locator('audio[aria-label="音色试听"]');
    const oldResponse = page.waitForResponse(response => response.url().endsWith('/api/voices/preview') && response.request().postDataJSON().voice === defaultSettings.voice);
    await modal.getByRole('button', { name: '试听当前音色' }).click();
    await expect.poll(() => auditions).toEqual([{ voice: defaultSettings.voice, rate: defaultSettings.rate }]);
    await modal.getByLabel('视频语言', { exact: true }).selectOption('en-US');
    await expect(modal.getByRole('button', { name: '试听当前音色' })).toBeEnabled();
    releaseOld();
    await (await oldResponse).finished();
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    await expect(audio).toHaveCount(0);
    await modal.getByLabel('微软免费配音').selectOption('en-US-GuyNeural');
    await modal.getByRole('button', { name: '试听当前音色' }).click();
    await expect.poll(() => auditions).toEqual([{ voice: defaultSettings.voice, rate: defaultSettings.rate }, { voice: 'en-US-GuyNeural', rate: defaultSettings.rate }]);
    await expect(audio).toHaveAttribute('src', '/api/artifacts/audition-current');
    expect(audioRequests.some(url => url.endsWith('/audition-old'))).toBe(false);
    await modal.getByLabel('视频语言', { exact: true }).selectOption('ja-JP');
    await expect(audio).toHaveCount(0);
    await expect(modal.getByLabel('微软免费配音')).toHaveValue(/^ja-JP-/);
  } finally { releaseOld(); }
});

for (const availability of ['failed', 'missing'] as const) {
  test(`preserves saved language and voice when the catalog is ${availability}`, async ({ page }) => {
    const data = await fixture(page);
    data.getProject().chapters![0].settings = { ...defaultSettings, language: 'fr-FR', voice: 'fr-FR-DeniseNeural' };
    if (availability === 'failed') await page.route('**/api/voices', route => route.fulfill({ status: 503, json: { error: '音色目录暂时不可用' } }));
    await page.goto(`/projects/${data.id}`);
    await page.getByRole('button', { name: '当前章节生成设置', exact: true }).click();
    const modal = page.getByRole('dialog');
    await expect(modal.getByLabel('视频语言', { exact: true })).toHaveValue('fr-FR');
    await expect(modal.getByLabel('微软免费配音')).toHaveValue('fr-FR-DeniseNeural');
    await expect(modal.getByLabel('微软免费配音').locator('option:checked')).toContainText('fr-FR-DeniseNeural');
    await modal.getByLabel('视频分辨率').selectOption('1080p');
    await modal.getByRole('button', { name: '保存设置', exact: true }).click();
    await expect(modal).toHaveCount(0);
    expect(data.getProject().chapters![0].settings).toMatchObject({ language: 'fr-FR', voice: 'fr-FR-DeniseNeural', resolution: '1080p' });
    expect(data.getProject().settings).toMatchObject({ language: 'fr-FR', voice: 'fr-FR-DeniseNeural' });
    await page.reload();
    await page.getByRole('button', { name: '当前章节生成设置', exact: true }).click();
    await expect(modal.getByLabel('视频语言', { exact: true })).toHaveValue('fr-FR');
    await expect(modal.getByLabel('微软免费配音')).toHaveValue('fr-FR-DeniseNeural');
  });
}

test('previews all preset components and actual animated JavaScript SVG components', async ({ page }) => {
  const data = await fixture(page);
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.setViewportSize({ width: 1366, height: 768 });
  await page.goto(`/projects/${data.id}`);
  await page.getByRole('button', { name: '查看组件库', exact: true }).click();
  const modal = page.getByRole('dialog');
  await expect(modal.getByRole('button', { name: /^预览组件：/ })).toHaveCount(12);
  await modal.getByRole('button', { name: '预览组件：图片与标注', exact: true }).click();
  await expect(modal.locator('.component-gallery-featured img')).toBeVisible();
  await modal.getByRole('button', { name: '预览组件：节点与关系图', exact: true }).click();
  const preset = modal.locator('.component-gallery-featured svg[role="img"]');
  await expect(preset).toBeVisible();
  await expect(preset.locator('[data-diagram-node]')).toHaveCount(3);
  await expect(preset.locator('[data-diagram-edge]')).toHaveCount(2);
  await modal.getByRole('button', { name: '预览组件：动态波形', exact: true }).click();
  const svg = modal.locator('.component-gallery-featured').getByRole('img', { name: 'AI 自定义图形组件' });
  await expect(svg).toBeVisible();
  const content = () => svg.evaluate(node => node.tagName === 'IMG' ? node.getAttribute('src') ?? '' : node.innerHTML);
  const first = await content();
  expect(first.startsWith('data:') ? decodeURIComponent(first) : first).toContain('<polyline');
  await modal.locator('.component-gallery-player').getByRole('button', { name: '播放预览' }).click();
  await expect.poll(content).not.toBe(first);
  await modal.locator('.component-gallery-intro').scrollIntoViewIfNeeded();
  await mkdir('.data/verification', { recursive: true });
  await page.screenshot({ path: '.data/verification/component-gallery-fixture.png' });
  await modal.getByRole('button', { name: '用创作模式生成', exact: true }).click();
  await expect(modal.getByRole('button', { name: '创作模式', exact: false })).toHaveAttribute('aria-pressed', 'true');
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(errors).toEqual([]);
});


test('shows real export frames and encoding phases while keeping the chapter editable', async ({ page }) => {
  const data = await fixture(page); data.removeExports();
  await page.goto(`/projects/${data.id}`);
  await page.getByRole('button', { name: '下载视频', exact: true }).click();
  await expect.poll(() => data.submitted.length).toBe(1);
  const job = data.getProject().chapterJobs!['chapter-a'];
  Object.assign(job, { status: 'running', stage: 'render', completed: 45, total: 100,
    renderProgress: { phase: 'rendering', renderedFrames: 45, totalFrames: 90, elapsedMs: 2000, framesPerSecond: 22.5 } });
  const footer = page.locator('.chapter-status-footer');
  await expect(footer).toContainText('画面 45/90 帧 · 22.5 帧/秒 · 已用 2 秒');
  await expect(page.getByRole('textbox', { name: '章节 Markdown', exact: true })).toBeEditable();
  Object.assign(job, { completed: 94, renderProgress: { phase: 'muxing', renderedFrames: 90, totalFrames: 90, elapsedMs: 6000 } });
  await expect(footer).toContainText('合成音视频 · 画面 90/90 帧');
  await expect(page.getByRole('button', { name: '正在导出…', exact: true }).last()).toBeDisabled();
  await page.getByRole('button', { name: '任务详情', exact: false }).click();
  await expect(page.locator('.chapter-job-details')).toContainText('最后合成配音');
  await mkdir('.data/verification', { recursive: true });
  await page.screenshot({ path: '.data/verification/export-progress-fixture.png' });
});

test('tracks two chapter exports and rebases local edits after a derived revision update', async ({ page, downloadOrigin }) => {
  const data = await fixture(page, downloadOrigin); data.removeExports();
  const downloads: string[] = []; page.on('download', download => downloads.push(download.suggestedFilename()));
  await page.goto(`/projects/${data.id}`);
  await page.getByRole('button', { name: '下载视频', exact: true }).click();
  await expect.poll(() => data.submitted.length).toBe(1);
  await page.getByRole('navigation', { name: '项目章节' }).getByRole('button', { name: '02 细胞核' }).click();
  await expect(page.getByRole('button', { name: '下载视频', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: '下载视频', exact: true }).click();
  await expect.poll(() => data.submitted.length).toBe(2);
  expect(data.submitted.map(job => job.chapterId)).toEqual(['chapter-a', 'chapter-b']);
  await page.getByLabel('章节 Markdown').fill('# 细胞核\n\n视频在后台导出，作者继续补充新的讲义。');
  data.completePending('chapter-a');
  await expect.poll(() => downloads).toContain('chapter-a.mp4');
  // The single worker finishes exports one at a time. Keep B pending while A
  // completes so the first automatic download cannot be overwritten by B.
  data.completePending('chapter-b');
  await expect.poll(() => [...downloads].sort(), { timeout: 10000 }).toEqual(['chapter-a.mp4', 'chapter-b.mp4']);
  await expect.poll(() => data.getProject().chapters![1].markdown).toContain('作者继续补充');
  await expect(page.getByText('保存冲突', { exact: true })).toHaveCount(0);
  await expect(page.getByText('已保存', { exact: true })).toBeVisible();
  expect(await page.evaluate(id => sessionStorage.getItem(`opentutor-download-${id}`), data.id)).toBeNull();
});
