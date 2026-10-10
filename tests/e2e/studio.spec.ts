import { test, expect } from '@playwright/test';

test('creates a real course, persists source edits, and protects stale API edits', async ({ page, request }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  const title = `浏览器验证 ${Date.now()}`;
  let projectId = '';
  try {
    await page.goto('/');
    await page.getByRole('button', { name: '创建项目', exact: true }).click();
    const modal = page.getByRole('dialog');
    await modal.getByLabel('项目名称', { exact: true }).fill(title);
    await modal.getByRole('button', { name: '开始编写', exact: true }).click();
    await expect(page).toHaveURL(/\/projects\/[0-9a-f-]+$/);
    projectId = page.url().split('/').at(-1)!;
    const source = page.getByLabel('章节 Markdown');
    await expect(source).toHaveValue('');
    const before = await (await request.get(`/api/projects/${projectId}`)).json();
    await source.fill('# 历史课\n\n一手材料需要结合时代背景阅读。\n\n比较不同作者的记述，可以发现立场与证据的区别。');
    await expect.poll(async () => (await (await request.get(`/api/projects/${projectId}`)).json()).project.markdown).toContain('立场与证据');
    await expect(page.getByText('已保存', { exact: true })).toBeVisible();
    await page.reload();
    await expect(page.getByLabel('章节 Markdown')).toHaveValue(/立场与证据/);
    const old = before.project;
    const stale = await request.patch(`/api/projects/${projectId}`, { data: { expectedRevision: old.revision, title: old.title, markdown: '不能覆盖新稿', settings: old.settings, assets: old.assets, lesson: old.lesson } });
    expect(stale.status()).toBe(409);
    expect(errors).toEqual([]);
  } finally { if (projectId) await request.delete(`/api/projects/${projectId}`); }
});

test('reports a missing asset before any model invocation and restores task state on reload', async ({ page, request }) => {
  const result = await request.post('/api/projects', { data: { title: `缺图检查 ${Date.now()}`, markdown: '# 生物课\n\n![结构图](missing.png)' } });
  expect(result.ok()).toBeTruthy();
  const { project } = await result.json();
  try {
    await page.goto(`/projects/${project.id}`);
    await page.getByRole('button', { name: '生成视频', exact: true }).click();
    await page.getByRole('button', { name: '生成本章视频', exact: true }).click();
    await expect(page.getByText(/图片未上传：missing.png/).first()).toBeVisible({ timeout: 20000 });
    await page.reload();
    await expect(page.getByText(/图片未上传：missing.png/).first()).toBeVisible();
    const current = await (await request.get(`/api/projects/${project.id}`)).json();
    expect(current.project.latestJob.status).toBe('failed');
    expect(current.project.latestJob.diagnostics.map((d: { code: string }) => d.code)).toContain('MISSING_SOURCE_IMAGE');
    expect(current.project.lesson).toBeNull();
  } finally { await request.delete(`/api/projects/${project.id}`); }
});

test('rejects unsupported uploaded content and cross-origin requests', async ({ request }) => {
  const upload = await request.post('/api/assets', { multipart: { file: { name: 'image.png', mimeType: 'image/png', buffer: Buffer.from('<script>alert(1)</script>') } } });
  expect(upload.status()).toBe(415);
  const crossed = await request.get('/api/projects', { headers: { Origin: 'https://example.com' } });
  expect(crossed.status()).toBe(403);
  const traversal = await request.get('/api/artifacts/not-a-registered-id');
  expect(traversal.status()).toBe(404);
});

test('keeps the workspace usable on a narrow screen', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await expect(page.getByRole('button', { name: '创建项目', exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
