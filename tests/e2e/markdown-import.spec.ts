import { test, expect, type Page } from '@playwright/test';
import { deflateRawSync } from 'node:zlib';
import { mkdir } from 'node:fs/promises';
import sharp from 'sharp';
import { defaultSettings, type Chapter, type Project } from '../../src/shared/schema';

// Produce ordinary UTF-8, deflated ZIP files without a CLI or extra dependency.
function zip(entries: Record<string, string | Buffer>) {
  const local: Buffer[] = []; const central: Buffer[] = []; let offset = 0;
  for (const [name, source] of Object.entries(entries)) {
    const filename = Buffer.from(name); const bytes = Buffer.isBuffer(source) ? source : Buffer.from(source);
    const compressed = deflateRawSync(bytes); let crc = 0xffffffff;
    for (const byte of bytes) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0); }
    crc = (crc ^ 0xffffffff) >>> 0;
    const header = Buffer.alloc(30); header.writeUInt32LE(0x04034b50); header.writeUInt16LE(20, 4); header.writeUInt16LE(0x800, 6); header.writeUInt16LE(8, 8);
    header.writeUInt32LE(crc, 14); header.writeUInt32LE(compressed.length, 18); header.writeUInt32LE(bytes.length, 22); header.writeUInt16LE(filename.length, 26);
    const directory = Buffer.alloc(46); directory.writeUInt32LE(0x02014b50); directory.writeUInt16LE(20, 4); directory.writeUInt16LE(20, 6); directory.writeUInt16LE(0x800, 8); directory.writeUInt16LE(8, 10);
    directory.writeUInt32LE(crc, 16); directory.writeUInt32LE(compressed.length, 20); directory.writeUInt32LE(bytes.length, 24); directory.writeUInt16LE(filename.length, 28); directory.writeUInt32LE(offset, 42);
    local.push(header, filename, compressed); central.push(directory, filename); offset += header.length + filename.length + compressed.length;
  }
  const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50); end.writeUInt16LE(Object.keys(entries).length, 8); end.writeUInt16LE(Object.keys(entries).length, 10);
  end.writeUInt32LE(central.reduce((size, value) => size + value.length, 0), 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, ...central, end]);
}

const originalChapters: Chapter[] = [
  { id: 'first', title: '保留第一章', markdown: '# 首章原文\n\n第一章不能被覆盖。', settings: { ...defaultSettings, theme: 'ink' } },
  { id: 'target', title: '指定第二章', markdown: '# 原有第二章\n\n这份草稿等待被替换。', settings: { ...defaultSettings, language: 'en-US', voice: 'en-US-AriaNeural', creationMode: 'creative', resolution: '1080p', stylePrompt: 'Keep this chapter setting.' } },
];
const fixtureId = 'cdcdcdcd-cdcd-4dcd-8dcd-cdcdcdcdcdcd';
const simpleImported = '# 包中的标题\n\n## 第一小节\n\n导入到指定章节。\n\n## 第二小节\n\n多个标题也必须保留在同一章。';
const file = (buffer: Buffer) => ({ name: 'chapter.zip', mimeType: 'application/zip', buffer });
const png = (width: number, height: number, color: string) => sharp({ create: { width, height, channels: 3, background: color } }).png().toBuffer();
const source = (page: Page) => page.locator('.chapter-markdown-editor');
const zipInput = (page: Page) => page.locator('input[type="file"][accept=".zip,application/zip"]');

async function chooseSecondChapter(page: Page) {
  await page.locator('.chapter-navigation-list > button').nth(1).click();
  await expect(source(page)).toHaveValue(originalChapters[1].markdown);
}

test('imports a real folder ZIP into only the selected chapter, resolves distinct images, and persists after reload', async ({ page, request }) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  const existing = await request.post('/api/assets', { multipart: { file: { name: 'same.png', mimeType: 'image/png', buffer: await png(4, 4, '#333333') } } });
  expect(existing.ok()).toBeTruthy(); const { asset } = await existing.json();
  const chapters = structuredClone(originalChapters);
  // Legacy name-based references must remain unambiguous when the imported
  // folder contains additional images with the same basename.
  chapters[0].markdown += '\n\n![首章原图](same.png)';
  const result = await request.post('/api/projects', { data: { title: `ZIP import E2E ${Date.now()}`, chapters, settings: { ...defaultSettings, theme: 'ocean' }, assets: [asset] } });
  expect(result.ok()).toBeTruthy(); const { project: before } = await result.json();
  const imported = '# 包中内容\n\n## 第一段\n\n![左侧同名图](./left/same.png "左图标题")\n\n![右侧同名图][right]\n\n![中文空格图](<./图 片/中文 图.png>)\n\n## 第二段\n\n标题不应创建更多章节。\n\n[right]: right/deeper/same.png "右图标题"\n';
  const archive = zip({ '讲义包/讲义.md': imported, '讲义包/left/same.png': await png(9, 7, '#dd2244'), '讲义包/right/deeper/same.png': await png(13, 11, '#2255dd'), '讲义包/图 片/中文 图.png': await png(17, 5, '#22bb77'), '__MACOSX/._讲义包': 'metadata', '讲义包/.DS_Store': 'metadata' });
  try {
    await page.goto(`/projects/${before.id}`);
    await page.locator('.chapter-navigation-list > button').nth(1).click();
    await expect(page.getByRole('button', { name: '导入章节 ZIP', exact: true })).toBeVisible();
    await zipInput(page).setInputFiles(file(archive));
    const dialog = page.getByRole('dialog');
    await expect(dialog).toContainText('指定第二章');
    await expect(dialog).toContainText('讲义.md');
    await expect(source(page)).toHaveValue(chapters[1].markdown);
    const staged = await (await request.get(`/api/projects/${before.id}`)).json();
    expect(staged.project.revision).toBe(before.revision);
    await dialog.getByRole('button', { name: '导入到此章节', exact: true }).click();
    await expect(source(page)).toHaveValue(/标题不应创建更多章节/);
    await expect(page.locator('.chapter-navigation-list > button')).toHaveCount(2);
    for (const [name, width, height] of [['左侧同名图', 9, 7], ['右侧同名图', 13, 11], ['中文空格图', 17, 5]] as const) {
      const image = page.getByRole('img', { name, exact: true });
      await expect(image).toBeVisible();
      await expect.poll(() => image.evaluate((node: HTMLImageElement) => [node.naturalWidth, node.naturalHeight])).toEqual([width, height]);
    }
    await expect.poll(async () => (await (await request.get(`/api/projects/${before.id}`)).json()).project.chapters[1].markdown).toContain('标题不应创建更多章节');
    const { project: saved } = await (await request.get(`/api/projects/${before.id}`)).json();
    expect(saved.chapters).toHaveLength(2); expect(saved.chapters[0]).toEqual(before.chapters[0]);
    expect(saved.chapters[1].id).toBe(before.chapters[1].id); expect(saved.chapters[1].title).toBe(before.chapters[1].title); expect(saved.chapters[1].settings).toEqual(before.chapters[1].settings);
    expect(saved.settings).toEqual(before.settings); expect(saved.assets).toHaveLength(4); expect(saved.assets).toContainEqual(asset);
    expect(saved.chapters[1].markdown.match(/asset:\/\//g)).toHaveLength(3);
    expect(saved.chapters[1].markdown).toContain('"左图标题"'); expect(saved.chapters[1].markdown).toContain('"右图标题"');
    await page.reload(); await page.locator('.chapter-navigation-list > button').nth(1).click();
    await expect(source(page)).toHaveValue(saved.chapters[1].markdown);
    await expect(page.getByRole('img', { name: '右侧同名图', exact: true })).toBeVisible();
    await page.locator('.chapter-navigation-list > button').nth(0).click();
    await expect(source(page)).toHaveValue(before.chapters[0].markdown);
    await expect.poll(() => page.getByRole('img', { name: '首章原图', exact: true }).evaluate((node: HTMLImageElement) => node.naturalWidth)).toBe(4);
    expect(errors).toEqual([]);
  } finally { await request.delete(`/api/projects/${before.id}`); }
});

test('rejects broken archives, missing referenced images, and multiple Markdown files without modifying the chapter', async ({ page, request }) => {
  const result = await request.post('/api/projects', { data: { title: `Invalid ZIP E2E ${Date.now()}`, chapters: originalChapters } });
  expect(result.ok()).toBeTruthy(); const { project } = await result.json();
  try {
    await page.goto(`/projects/${project.id}`); await chooseSecondChapter(page);
    for (const buffer of [Buffer.from('This is not a ZIP file.'), zip({ 'folder/readme.md': '# Missing\n\n![Missing](images/missing.png)' }), zip({ 'folder/one.md': '# First', 'folder/nested/two.markdown': '# Second' })]) {
      const response = page.waitForResponse(response => new URL(response.url()).pathname === '/api/markdown-import' && response.request().method() === 'POST');
      await zipInput(page).setInputFiles(file(buffer)); expect((await response).ok()).toBe(false);
      await expect(page.locator('.chapter-alert[role="alert"]')).toBeVisible(); await expect(page.getByRole('dialog')).toHaveCount(0);
      await expect(source(page)).toHaveValue(originalChapters[1].markdown);
      await page.getByRole('button', { name: '关闭错误提示', exact: true }).click();
    }
    const { project: after } = await (await request.get(`/api/projects/${project.id}`)).json();
    expect(after.revision).toBe(project.revision); expect(after.chapters).toEqual(project.chapters); expect(after.assets).toEqual([]);
  } finally { await request.delete(`/api/projects/${project.id}`); }
});

async function mockProject(page: Page, delayed = false) {
  let project: Project = { id: fixtureId, title: '导入保护验证', markdown: originalChapters.map(chapter => chapter.markdown).join('\n\n'), chapters: structuredClone(originalChapters), sourceMode: 'chapters', settings: { ...defaultSettings }, assets: [], revision: 1, lesson: null, renderPlan: null, previewRevision: null, latestJob: null, latestExport: null, chapterVideos: {}, chapterJobs: {}, createdAt: '2026-10-11T00:00:00Z', updatedAt: '2026-10-11T00:00:00Z' };
  const writes: Record<string, unknown>[] = []; let started = false; let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; }); if (!delayed) release();
  await page.route('**/api/**', async route => {
    const request = route.request(); const path = new URL(request.url()).pathname;
    if (path === '/api/markdown-import') { started = true; await gate; await route.fulfill({ json: { markdown: simpleImported, assets: [], markdownPath: '待导入文件夹/讲义.md', rootFolder: '待导入文件夹' } }); return; }
    if (path === `/api/projects/${fixtureId}` && request.method() === 'PATCH') {
      const input = request.postDataJSON(); writes.push(input); project = { ...project, ...input, revision: project.revision + 1 };
      await route.fulfill({ json: { project } }); return;
    }
    if (request.method() !== 'GET') { await route.fulfill({ status: 500, json: { error: 'Unexpected mutation in isolated ZIP import fixture' } }); return; }
    if (path === `/api/projects/${fixtureId}`) { await route.fulfill({ json: { project } }); return; }
    if (path === `/api/projects/${fixtureId}/videos`) { await route.fulfill({ json: { versions: [] } }); return; }
    if (path === '/api/health') { await route.fulfill({ json: { ready: true, checks: {} } }); return; }
    await route.fulfill({ status: 404, json: { error: `Unmocked endpoint: ${path}` } });
  });
  return { writes, project: () => project, started: () => started, release };
}

test('binds a delayed import to its original chapter even after navigating to another chapter', async ({ page }) => {
  const data = await mockProject(page, true); await page.goto(`/projects/${fixtureId}`); await chooseSecondChapter(page);
  await zipInput(page).setInputFiles(file(zip({ 'folder/notes.md': simpleImported })));
  await expect.poll(data.started).toBe(true);
  await page.locator('.chapter-navigation-list > button').nth(0).click();
  await expect(source(page)).toHaveValue(originalChapters[0].markdown);
  data.release();
  await expect(page.getByRole('dialog')).toContainText('指定第二章');
  await page.getByRole('button', { name: '导入到此章节', exact: true }).click();
  await expect.poll(() => data.project().chapters![1].markdown).toBe(simpleImported);
  expect(data.project().chapters![0]).toEqual(originalChapters[0]);
  expect(data.project().chapters![1].settings).toEqual(originalChapters[1].settings);
  expect(data.project().chapters).toHaveLength(2); expect(data.writes).toHaveLength(1);
});

test('keeps a newer draft when the chapter changes while a ZIP is being read', async ({ page }) => {
  const data = await mockProject(page, true); await page.goto(`/projects/${fixtureId}`); await chooseSecondChapter(page);
  await zipInput(page).setInputFiles(file(zip({ 'folder/notes.md': simpleImported })));
  await expect.poll(data.started).toBe(true);
  const latest = `${originalChapters[1].markdown}\n\n读取压缩包期间刚写下的新内容。`;
  await source(page).fill(latest); data.release();
  // The UI can reject immediately or at confirmation, but must never overwrite
  // edits made after the target snapshot was captured.
  await expect.poll(async () => (await page.getByRole('dialog').count()) + (await page.locator('.chapter-alert[role="alert"]').count())).toBeGreaterThan(0);
  const confirm = page.getByRole('button', { name: '导入到此章节', exact: true });
  if (await confirm.isVisible() && await confirm.isEnabled()) await confirm.click();
  await expect(source(page)).toHaveValue(latest);
  await expect(page.locator('.chapter-alert[role="alert"]')).toBeVisible();
  await expect.poll(() => data.project().chapters![1].markdown).toBe(latest);
  expect(data.writes.every(write => (write.chapters as Chapter[])[1].markdown === latest)).toBe(true);
});

test('keeps the target chapter from being deleted during upload and restores deletion after cancelling', async ({ page }) => {
  const data = await mockProject(page, true); await page.goto(`/projects/${fixtureId}`); await chooseSecondChapter(page);
  await zipInput(page).setInputFiles(file(zip({ 'folder/notes.md': simpleImported })));
  await expect.poll(data.started).toBe(true);
  await expect(page.getByRole('button', { name: '删除当前章节', exact: true })).toBeDisabled();
  await expect(source(page)).toHaveValue(originalChapters[1].markdown);
  data.release();
  await page.getByRole('dialog').getByRole('button', { name: '取消', exact: true }).click();
  await expect(page.getByRole('button', { name: '删除当前章节', exact: true })).toBeEnabled();
  expect(data.writes).toEqual([]);
  await page.getByRole('button', { name: '删除当前章节', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: '确认删除', exact: true }).click();
  await expect(source(page)).toHaveValue(originalChapters[0].markdown);
  await expect.poll(() => data.project().chapters).toEqual([originalChapters[0]]);
  expect(data.writes.every(write => JSON.stringify(write.chapters) === JSON.stringify([originalChapters[0]]))).toBe(true);
});

test('cancels an English ZIP confirmation without saving and keeps its actions within a 390px viewport', async ({ page }) => {
  const data = await mockProject(page);
  await page.context().addCookies([{ name: 'opentutor-ui-locale', value: 'en', url: String(test.info().project.use.baseURL) }]);
  await page.setViewportSize({ width: 390, height: 844 }); await page.goto(`/projects/${fixtureId}`); await chooseSecondChapter(page);
  const button = page.getByRole('button', { name: 'Import chapter ZIP', exact: true }); await expect(button).toBeVisible();
  const chooser = page.waitForEvent('filechooser'); await button.click(); await (await chooser).setFiles(file(zip({ 'folder/notes.md': simpleImported })));
  const dialog = page.getByRole('dialog'); await expect(dialog).toContainText('指定第二章');
  const confirm = dialog.getByRole('button', { name: 'Import into this chapter', exact: true }); await expect(confirm).toBeVisible();
  for (const control of [dialog, confirm, dialog.getByRole('button', { name: 'Cancel', exact: true })]) {
    const bounds = await control.boundingBox(); expect(bounds!.x).toBeGreaterThanOrEqual(0); expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(391);
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await mkdir('.data/verification/markdown-import', { recursive: true }); await page.screenshot({ path: '.data/verification/markdown-import/confirmation-en-390.png' });
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click(); await expect(dialog).toHaveCount(0);
  await expect(source(page)).toHaveValue(originalChapters[1].markdown);
  await page.waitForTimeout(1000); // Beyond the existing autosave debounce.
  expect(data.writes).toEqual([]); expect(data.project().chapters).toEqual(originalChapters);
});
