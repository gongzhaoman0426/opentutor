import { test, expect } from '@playwright/test';
import sharp from 'sharp';
import { mkdir } from 'node:fs/promises';

test('edits chapters, inserts an uploaded image, and preserves chapter order on reload', async ({ page, request }) => {
  const response = await request.post('/api/projects', { data: { title: `章节编辑验证 ${Date.now()}` } });
  const { project } = await response.json();
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  try {
    await page.setViewportSize({ width: 1366, height: 768 });
    await page.goto(`/projects/${project.id}`);
    const editor = page.getByLabel('章节 Markdown');
    await expect(editor).toHaveValue('');
    await expect(page.getByRole('tabpanel')).toContainText('在左侧开始编写');
    await page.getByRole('tab', { name: '视频', exact: true }).click();
    await expect(page.getByText('这一章，还没有视频。', { exact: true })).toBeVisible();
    await page.getByRole('tab', { name: 'Markdown', exact: true }).click();
    await editor.fill('# 第一章\n\n细胞膜分隔细胞与外部环境。');
    await page.getByRole('button', { name: '添加章节', exact: true }).click();
    await page.getByLabel('章节名称').fill('细胞的结构');
    await editor.fill('细胞核保存遗传信息。');
    const bytes = await sharp({ create: { width: 60, height: 36, channels: 3, background: { r: 140, g: 180, b: 120 } } }).png().toBuffer();
    await page.getByRole('button', { name: '插入图片', exact: true }).click();
    await page.getByRole('button', { name: '上传图片', exact: true }).click();
    await page.locator('input[type="file"][accept="image/png,image/jpeg,image/webp"]').setInputFiles({ name: '细胞图.png', mimeType: 'image/png', buffer: bytes });
    await expect(editor).toHaveValue(/asset:\/\/[a-f0-9-]{36}/);
    await expect(page.getByRole('img', { name: '细胞图', exact: true })).toBeVisible();
    await expect.poll(async () => {
      const result = await (await request.get(`/api/projects/${project.id}`)).json();
      return result.project.chapters?.find((chapter: { title: string }) => chapter.title === '细胞的结构')?.id;
    }).toBeTruthy();
    await page.getByRole('button', { name: '章节上移', exact: true }).click();
    await expect.poll(async () => (await (await request.get(`/api/projects/${project.id}`)).json()).project.chapters[0].title).toBe('细胞的结构');
    await page.reload();
    await expect(page.getByLabel('章节名称')).toHaveValue('细胞的结构');
    await expect(editor).toHaveValue(/asset:\/\/[a-f0-9-]{36}/);
    expect(await page.evaluate(() => document.documentElement.scrollHeight <= innerHeight && document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect(errors).toEqual([]);
    await mkdir('.data/verification', { recursive: true });
    await page.screenshot({ path: '.data/verification/chapter-editor-desktop.png' });
  } finally { await request.delete(`/api/projects/${project.id}`); }
});

test('resolves reference-style images across chapters and keeps the mobile editor on one screen', async ({ page, request }) => {
  const bytes = await sharp({ create: { width: 48, height: 32, channels: 3, background: { r: 100, g: 155, b: 110 } } }).png().toBuffer();
  const uploaded = await request.post('/api/assets', { multipart: { file: { name: '共享图片.png', mimeType: 'image/png', buffer: bytes } } });
  const { asset } = await uploaded.json();
  const response = await request.post('/api/projects', { data: { title: `跨章图片 ${Date.now()}`, assets: [asset], chapters: [
    { id: 'chapter-picture', title: '认识细胞', markdown: '# 认识细胞\n\n![跨章图片][shared]' },
    { id: 'chapter-reference', title: '素材定义', markdown: `[shared]: asset://${asset.id}` },
  ] } });
  const { project } = await response.json();
  try {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`/projects/${project.id}`);
    await expect(page.getByRole('img', { name: '跨章图片', exact: true })).toBeVisible();
    await expect(page.getByLabel('章节 Markdown')).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollHeight <= innerHeight && document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.getByRole('button', { name: '收起章节列表', exact: true }).click();
    await expect(page.getByRole('navigation', { name: '项目章节' })).toBeHidden();
    await page.getByRole('button', { name: '展开章节列表', exact: true }).click();
    await expect(page.getByRole('navigation', { name: '项目章节' })).toBeVisible();
    await page.getByRole('tab', { name: '视频', exact: true }).click();
    await expect(page.getByText('这一章，还没有视频。', { exact: true })).toBeVisible();
  } finally { await request.delete(`/api/projects/${project.id}`); }
});

test('does not mistake a background refresh for a conflict when an in-flight save has already committed', async ({ page }) => {
  const { defaultSettings } = await import('../../src/shared/schema');
  const id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const jobId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  const snapshot = { id, title: '自动保存时序验证', markdown: '', chapters: [{ id: 'race-chapter', title: '第一章', markdown: '' }], sourceMode: 'chapters', settings: defaultSettings, assets: [], revision: 1, lesson: null };
  const running = { id: jobId, projectId: id, kind: 'preview', status: 'running', stage: 'parse', completed: 0, total: 1, inputRevision: 1, outputRevision: null, error: null, diagnostics: [], videoUrl: null, subtitleUrl: null, createdAt: '2026-10-09T00:00:00Z', updatedAt: '2026-10-09T00:00:00Z', snapshot, sceneId: null, instruction: null };
  let project = { ...snapshot, renderPlan: null, previewRevision: null, latestJob: running, latestExport: null, createdAt: running.createdAt, updatedAt: running.updatedAt };
  const failed = { ...running, status: 'failed', error: '测试任务已停止' };
  let getCount = 0; let patchCount = 0;
  let refreshArrived!: () => void; const refresh = new Promise<void>(resolve => { refreshArrived = resolve; });
  let patchCommitted!: () => void; const committed = new Promise<void>(resolve => { patchCommitted = resolve; });
  let getReturned!: () => void; const returned = new Promise<void>(resolve => { getReturned = resolve; });
  let releasePatch!: () => void; const acknowledgement = new Promise<void>(resolve => { releasePatch = resolve; });
  await page.route(`**/api/jobs/${jobId}/events`, route => route.fulfill({ status: 204 }));
  await page.route(`**/api/jobs/${jobId}`, route => route.fulfill({ json: { job: failed } }));
  await page.route(`**/api/projects/${id}`, async route => {
    if (route.request().method() === 'PATCH') {
      const input = route.request().postDataJSON();
      patchCount++; project = { ...project, ...input, revision: project.revision + 1, markdown: input.chapters[0].markdown, latestJob: failed };
      if (patchCount === 1) { patchCommitted(); await acknowledgement; }
      await route.fulfill({ json: { project } }); return;
    }
    getCount++;
    if (getCount === 2) { refreshArrived(); await committed; await route.fulfill({ json: { project } }); getReturned(); }
    else await route.fulfill({ json: { project } });
  });
  await page.goto(`/projects/${id}`);
  await refresh;
  await page.getByLabel('章节 Markdown').fill('刷新已开始以后，用户继续写下新的讲义。');
  await committed;
  await returned;
  // Keep the PATCH acknowledgement delayed while the browser processes the GET.
  await page.waitForTimeout(100);
  releasePatch();
  await expect(page.getByText('已保存', { exact: true })).toBeVisible();
  await expect(page.getByLabel('章节 Markdown')).toHaveValue('刷新已开始以后，用户继续写下新的讲义。');
  await expect(page.getByText('保存冲突', { exact: true })).toHaveCount(0);
  await page.getByLabel('章节 Markdown').fill('刷新与保存没有冲突，继续写下下一个知识点。');
  await expect.poll(() => project.markdown).toBe('刷新与保存没有冲突，继续写下下一个知识点。');
  await expect(page.getByText('保存冲突', { exact: true })).toHaveCount(0);
});
