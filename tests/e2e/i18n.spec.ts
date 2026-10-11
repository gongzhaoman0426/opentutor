import { test, expect, type Locator, type Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { defaultSettings, type Project, type VideoVersionDetail } from '../../src/shared/schema';
import { getChapterSourceKey, isChapterVideoCurrent } from '../../src/shared/chapters';

const projectId = 'abababab-abab-4bab-8bab-abababababab';
const oldId = '12121212-1212-4212-8212-121212121212';
const newId = '34343434-3434-4434-8434-343434343434';
const title = '我的城市故事';
const originalMarkdown = '# 夜色中的街道\n\n这份中文原稿不随界面语言改变。';
const output = '.data/verification/i18n';
const voices = [
  { name: 'zh-CN-XiaoxiaoNeural', locale: 'zh-CN', gender: 'Female', displayName: '晓晓' },
  { name: 'zh-CN-YunxiNeural', locale: 'zh-CN', gender: 'Male', displayName: '云希' },
  { name: 'en-US-AriaNeural', locale: 'en-US', gender: 'Female', displayName: 'Aria' },
  { name: 'en-US-GuyNeural', locale: 'en-US', gender: 'Male', displayName: 'Guy' },
  { name: 'ja-JP-NanamiNeural', locale: 'ja-JP', gender: 'Female', displayName: 'Nanami' },
  { name: 'ja-JP-KeitaNeural', locale: 'ja-JP', gender: 'Male', displayName: 'Keita' },
];

// Real continuous PCM exercises the browser audio clock without TTS or model
// calls. The application still uses its normal Remotion preview component.
function wave(seconds = 30) {
  const rate = 16000; const samples = rate * seconds; const data = Buffer.alloc(44 + samples * 2);
  data.write('RIFF', 0); data.writeUInt32LE(data.length - 8, 4); data.write('WAVEfmt ', 8);
  data.writeUInt32LE(16, 16); data.writeUInt16LE(1, 20); data.writeUInt16LE(1, 22);
  data.writeUInt32LE(rate, 24); data.writeUInt32LE(rate * 2, 28); data.writeUInt16LE(2, 32); data.writeUInt16LE(16, 34);
  data.write('data', 36); data.writeUInt32LE(samples * 2, 40);
  for (let index = 0; index < samples; index++) data.writeInt16LE(Math.round(Math.sin(index / rate * Math.PI * 440) * 600), 44 + index * 2);
  return data;
}

function video(id: string, version: number): VideoVersionDetail {
  const settings = { ...defaultSettings, language: 'ja-JP', voice: 'ja-JP-KeitaNeural', theme: 'ocean' as const };
  const scene = { id: `scene-${version}`, chapterId: 'chapter', chapter: '夜色中的街道', title: `原始画面 ${version}`, layout: 'content' as const,
    sourceBlockIds: ['source'], objects: [{ id: 'object', type: 'text' as const, content: `第 ${version} 版：这段画面内容保持原文。`, language: '' }],
    narration: [{ id: 'utterance', text: '这是已生成视频的原始旁白。', showObjectIds: ['object'], focusObjectId: '' }] };
  const lesson = { schemaVersion: '0.1' as const, title, objectives: [], scenes: [scene] };
  const url = `/api/artifacts/i18n-audio-${id}`;
  return { id, version, chapterId: 'chapter', chapterTitle: scene.chapter, title, createdAt: `2026-10-10T0${version}:00:00Z`, inputRevision: version === 1 ? 8 : 10, outputRevision: version === 1 ? 9 : 11,
    durationSeconds: 30, settings, current: version === 2, videoUrl: null, subtitleUrl: null, exportJobId: null, lesson, assets: [],
    renderPlan: { schemaVersion: '0.1', revision: version === 1 ? 8 : 10, title, fps: 30, width: 1280, height: 720, theme: settings.theme, voice: settings.voice, rate: 0,
      totalFrames: 900, previewMode: 'aligned', narrationAudio: { url, durationSeconds: 30 },
      scenes: [{ scene, startFrame: 0, durationFrames: 900, utterances: [{ utteranceId: 'utterance', startFrame: 0, durationFrames: 900, durationSeconds: 30, url, estimated: false, boundaries: [], hash: id, cacheHit: false }] }] } };
}

async function fixture(page: Page) {
  const versions = [video(newId, 2), video(oldId, 1)];
  const current = versions[0];
  let project: Project = { id: projectId, title, markdown: originalMarkdown, chapters: [{ id: 'chapter', title: '夜色中的街道', markdown: originalMarkdown }], sourceMode: 'chapters',
    settings: { ...current.settings }, assets: [], revision: 11, lesson: null, renderPlan: null, previewRevision: null, latestJob: null, chapterJobs: {}, chapterVideos: {}, latestExport: null,
    createdAt: '2026-10-10T00:00:00Z', updatedAt: '2026-10-10T03:00:00Z' };
  project.chapterVideos!.chapter = { chapterId: 'chapter', sourceKey: getChapterSourceKey(project, project.chapters![0]), settings: current.settings, lesson: current.lesson,
    renderPlan: { ...current.renderPlan, revision: 11 }, previewAssets: [], previewRevision: 11, latestExport: null, updatedAt: current.createdAt, current: true };
  const writes: { method: string; url: string; input: Record<string, unknown> }[] = [];
  const reads: string[] = [];
  let nextSaveGate: Promise<void> | undefined;
  // Catch every API request so an omitted fixture cannot touch a real project
  // or invoke generation, speech, or exports.
  await page.route('**/api/**', async route => {
    const request = route.request(); const path = new URL(request.url()).pathname;
    if (request.method() !== 'GET') {
      writes.push({ method: request.method(), url: path, input: request.postDataJSON() });
      if (path !== `/api/projects/${projectId}` || request.method() !== 'PATCH') { await route.fulfill({ status: 500, json: { error: 'Unexpected mutation in isolated i18n fixture' } }); return; }
      const gate = nextSaveGate; nextSaveGate = undefined;
      if (gate) await gate;
      const input = request.postDataJSON(); project = { ...project, ...input, revision: project.revision + 1 };
    } else reads.push(path);
    if (path === '/api/health') { await route.fulfill({ json: { ready: true, checks: {} } }); return; }
    if (path === '/api/projects') { await route.fulfill({ json: { projects: [project] } }); return; }
    if (path === `/api/projects/${projectId}`) {
      await route.fulfill({ json: { project: { ...project, chapterVideos: { chapter: { ...project.chapterVideos!.chapter, current: isChapterVideoCurrent(project, 'chapter') } } } } }); return;
    }
    if (path === `/api/projects/${projectId}/videos`) { await route.fulfill({ json: { versions: versions.map(({ lesson: _l, renderPlan: _r, assets: _a, ...summary }) => summary) } }); return; }
    if (path.startsWith(`/api/projects/${projectId}/videos/`)) { await route.fulfill({ json: { version: versions.find(value => path.endsWith(value.id)) } }); return; }
    if (path === '/api/voices') { await route.fulfill({ json: { voices } }); return; }
    if (path === '/api/models') { await route.fulfill({ json: { models: [{ id: 'fixture-model', displayName: 'Fixture model', isDefault: true }] } }); return; }
    if (path.startsWith('/api/artifacts/i18n-audio-')) { await route.fulfill({ contentType: 'audio/wav', body: wave() }); return; }
    await route.fulfill({ status: 404, json: { error: `Unmocked endpoint: ${path}` } });
  });
  return { writes, reads, project: () => project, holdNextSave: () => {
    let release!: () => void;
    nextSaveGate = new Promise<void>(resolve => { release = resolve; });
    return release;
  } };
}

async function useEnglish(page: Page) {
  const baseURL = String(test.info().project.use.baseURL);
  await page.context().addCookies([{ name: 'opentutor-ui-locale', value: 'en', url: baseURL }]);
}

async function screenshot(page: Page, name: string) {
  await mkdir(output, { recursive: true });
  await page.screenshot({ path: `${output}/${name}.png` });
}

test('switches language inside the authentication dialog without submitting or clearing the access token', async ({ page }) => {
  const writes: { method: string; path: string }[] = [];
  await page.route('**/api/**', async route => {
    const request = route.request(); const path = new URL(request.url()).pathname;
    if (request.method() !== 'GET') {
      writes.push({ method: request.method(), path });
      await route.fulfill({ status: 500, json: { error: 'Switching interface language must not submit authentication' } }); return;
    }
    if (path === '/api/projects') { await route.fulfill({ status: 401, json: { error: 'Unauthorized' } }); return; }
    if (path === '/api/health') { await route.fulfill({ json: { ready: true, checks: {} } }); return; }
    await route.fulfill({ status: 404, json: { error: 'Unmocked authentication fixture endpoint' } });
  });
  await page.goto('/');
  const dialog = page.getByRole('dialog');
  await expect(dialog).toHaveAccessibleName('连接你的工作室');
  await dialog.getByLabel('访问令牌', { exact: true }).fill('isolated-test-token-not-a-credential');
  const language = dialog.getByLabel('界面语言', { exact: true });
  await expect(language).toBeVisible();
  await language.selectOption('en');
  await expect(dialog).toHaveAccessibleName('Connect to your studio');
  await expect(dialog.getByLabel('Access token', { exact: true })).toHaveValue('isolated-test-token-not-a-credential');
  await expect(dialog.getByLabel('Interface language', { exact: true })).toHaveValue('en');
  await expect(dialog.getByRole('button', { name: 'Enter studio', exact: true })).toBeEnabled();
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  // Keyboard navigation can reach the new control while staying inside the
  // authentication focus trap; the background switcher is not required.
  await dialog.getByRole('button', { name: 'Enter studio', exact: true }).focus();
  await page.keyboard.press('Tab');
  await expect(dialog.getByLabel('Interface language', { exact: true })).toBeFocused();
  expect(writes).toEqual([]);
  await screenshot(page, 'session-en');
});

test('persists interface language through reload and navigation without changing project content', async ({ page }) => {
  const data = await fixture(page);
  await page.goto('/');
  await expect(page.getByRole('heading', { name: '我的项目', exact: true })).toBeVisible();
  await expect(page.locator('.revision-label')).toHaveText('文稿修订 11');
  await page.getByLabel('界面语言', { exact: true }).selectOption('en');
  await expect(page.getByRole('heading', { name: 'My projects', exact: true })).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await expect(page).toHaveTitle('OpenTutor · Video Studio');
  await expect(page.locator('.revision-label')).toHaveText('Draft revision 11');
  expect((await page.context().cookies()).find(cookie => cookie.name === 'opentutor-ui-locale')?.value).toBe('en');
  await page.reload();
  await expect(page.getByLabel('Interface language', { exact: true })).toHaveValue('en');
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await expect(page).toHaveTitle('OpenTutor · Video Studio');
  await screenshot(page, 'home-en');
  await page.locator('.course-name').click();
  await expect(page.getByLabel('Chapter Markdown')).toHaveValue(originalMarkdown);
  await expect(page.getByLabel('Project name', { exact: true })).toHaveValue(title);
  await expect(page.getByRole('button', { name: 'Chapter generation settings', exact: true })).toBeVisible();
  await page.getByRole('link', { name: 'Back to my projects', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'My projects', exact: true })).toBeVisible();
  expect(data.writes).toEqual([]);
});

test('keeps draft, selected historical video, and continuous playback when switching interface language', async ({ page }) => {
  const data = await fixture(page);
  await page.addInitScript(() => {
    const state = window as unknown as { documentMarker: string; audioSeeks: { before: number; after: number }[]; selectedAudio?: HTMLAudioElement };
    state.documentMarker = crypto.randomUUID(); state.audioSeeks = [];
    const descriptor = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'currentTime')!;
    Object.defineProperty(HTMLMediaElement.prototype, 'currentTime', { configurable: true, get: descriptor.get,
      set(this: HTMLMediaElement, value: number) {
        if (this.src.includes('/api/artifacts/i18n-audio-')) state.audioSeeks.push({ before: descriptor.get!.call(this), after: value });
        descriptor.set!.call(this, value);
      },
    });
  });
  await page.goto(`/projects/${projectId}`);
  const edited = `${originalMarkdown}\n\n我刚写下的草稿也必须保留。`;
  await page.getByLabel('章节 Markdown').fill(edited);
  await expect.poll(() => data.writes.length).toBe(1);
  await page.getByRole('tab', { name: '视频', exact: true }).click();
  await page.getByLabel('视频版本', { exact: true }).selectOption(oldId);
  await expect(page.getByText('第 1 版：这段画面内容保持原文。', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '播放预览', exact: true }).click();
  await expect.poll(() => page.locator('.creation-playhead input').inputValue().then(Number)).toBeGreaterThan(45);
  const before = await page.evaluate(() => {
    const state = window as unknown as { documentMarker: string; audioSeeks: unknown[]; selectedAudio?: HTMLAudioElement };
    state.selectedAudio = [...document.querySelectorAll('audio')].find(audio => !audio.paused);
    state.audioSeeks = [];
    return { marker: state.documentMarker, time: state.selectedAudio?.currentTime ?? -1 };
  });
  expect(before.time).toBeGreaterThan(0);
  const pendingDraft = `${edited}\n\n这句仍在等待服务器保存。`;
  const releaseSave = data.holdNextSave();
  await page.getByLabel('章节 Markdown').fill(pendingDraft);
  await expect.poll(() => data.writes.length).toBe(2);
  expect(data.project().chapters![0].markdown).toBe(edited);
  const readsBefore = data.reads.length;
  await page.getByLabel('界面语言', { exact: true }).selectOption('en');
  await expect(page.getByLabel('Video version', { exact: true })).toHaveValue(oldId);
  await expect(page.getByRole('button', { name: 'Pause preview', exact: true })).toBeVisible();
  await expect(page.getByLabel('Chapter Markdown')).toHaveValue(pendingDraft);
  await expect(page.getByText('第 1 版：这段画面内容保持原文。', { exact: true })).toBeVisible();
  // Wait beyond the autosave debounce while the normal audio clock advances.
  await expect.poll(() => page.evaluate(() => (window as unknown as { selectedAudio?: HTMLAudioElement }).selectedAudio?.currentTime ?? -1)).toBeGreaterThan(before.time + 1.3);
  const after = await page.evaluate(() => {
    const state = window as unknown as { documentMarker: string; audioSeeks: { before: number; after: number }[]; selectedAudio?: HTMLAudioElement };
    return { marker: state.documentMarker, connected: state.selectedAudio?.isConnected, paused: state.selectedAudio?.paused,
      backwards: state.audioSeeks.filter(seek => seek.before - seek.after > 0.25) };
  });
  expect(after).toEqual({ marker: before.marker, connected: true, paused: false, backwards: [] });
  expect(data.reads.length).toBe(readsBefore);
  expect(data.writes).toHaveLength(2);
  expect((data.writes[1].input.chapters as { markdown: string }[])[0].markdown).toBe(pendingDraft);
  releaseSave();
  await expect.poll(() => data.project().chapters![0].markdown).toBe(pendingDraft);
  await expect(page.getByLabel('Chapter Markdown')).toHaveValue(pendingDraft);
  expect(data.writes).toHaveLength(2);
  expect(data.project().settings.language).toBe('ja-JP');
  expect(data.project().settings.voice).toBe('ja-JP-KeitaNeural');
  await screenshot(page, 'editor-en');
});

test('localizes settings and component library while keeping video language and voice independent', async ({ page }) => {
  const data = await fixture(page);
  await page.goto(`/projects/${projectId}`);
  await page.getByRole('button', { name: '当前章节生成设置', exact: true }).click();
  await expect(page.locator('#chapter-language')).toHaveValue('ja-JP');
  await expect(page.locator('#chapter-language option:checked')).toContainText('日语');
  await expect(page.locator('#chapter-voice option:checked')).toHaveText('Keita · 男声');
  await page.getByRole('button', { name: '关闭生成设置', exact: true }).click();
  await page.getByLabel('界面语言', { exact: true }).selectOption('en');
  await page.getByRole('button', { name: 'Chapter generation settings', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'How should this chapter look?' })).toBeVisible();
  await expect(page.getByLabel('Video language', { exact: true })).toHaveValue('ja-JP');
  await expect(page.locator('#chapter-language option:checked')).toContainText('Japanese');
  await expect(page.locator('#chapter-voice')).toHaveValue('ja-JP-KeitaNeural');
  await expect(page.locator('#chapter-voice option:checked')).toHaveText('Keita · Male');
  await expect(page.locator('#chapter-voice option')).toHaveText(['Nanami · Female', 'Keita · Male']);
  await expect(page.locator('#chapter-language option[value="zh-CN"]')).toHaveText('Chinese (Mandarin)');
  await expect(page.getByRole('button', { name: 'Save settings', exact: true })).toBeVisible();
  await screenshot(page, 'settings-en');
  await page.getByRole('tab', { name: 'Component library', exact: true }).click();
  await expect(page.getByText('Find the right visuals for your content.', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: /^Preview component:/ })).toHaveCount(12);
  await page.getByRole('button', { name: 'Preview component: Nodes and relationships', exact: true }).click();
  await expect(page.locator('.component-gallery-caption')).toContainText('Use nodes and arrows to show workflows, conceptual relationships, and name bindings');
  await expect(page.getByRole('button', { name: 'Play preview', exact: true })).toBeVisible();
  await screenshot(page, 'components-en');
  await page.getByRole('button', { name: 'Close generation settings', exact: true }).click();
  await expect(page.getByLabel('Chapter Markdown')).toHaveValue(originalMarkdown);
  expect(data.project().settings.language).toBe('ja-JP');
  expect(data.project().settings.voice).toBe('ja-JP-KeitaNeural');
  expect(data.writes).toEqual([]);
});

async function insideViewport(page: Page, locator: Locator) {
  await expect(locator).toBeVisible();
  const bounds = await locator.boundingBox();
  const viewport = page.viewportSize()!;
  expect(bounds!.x).toBeGreaterThanOrEqual(-1);
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(viewport.width + 1);
}

async function noHorizontalOverflow(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(page.viewportSize()!.width);
}

for (const width of [390, 804, 1440]) {
  test(`keeps English home, editor, and settings within a ${width}px viewport`, async ({ page }) => {
    await page.setViewportSize({ width, height: 1000 });
    const data = await fixture(page); await useEnglish(page);
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'My projects', exact: true })).toBeVisible();
    await noHorizontalOverflow(page);
    await insideViewport(page, page.getByLabel('Interface language', { exact: true }));
    await insideViewport(page, page.getByRole('button', { name: 'Create project', exact: true }));
    await page.locator('.course-name').click();
    await expect(page.getByLabel('Chapter Markdown')).toHaveValue(originalMarkdown);
    await noHorizontalOverflow(page);
    await insideViewport(page, page.getByLabel('Interface language', { exact: true }));
    await insideViewport(page, page.getByRole('button', { name: 'Chapter generation settings', exact: true }));
    await page.getByRole('button', { name: 'Chapter generation settings', exact: true }).click();
    await insideViewport(page, page.getByRole('dialog'));
    await noHorizontalOverflow(page);
    await insideViewport(page, page.getByRole('button', { name: 'Save settings', exact: true }));
    await insideViewport(page, page.getByRole('button', { name: 'Generate chapter video', exact: true }));
    await page.getByLabel('Video language', { exact: true }).scrollIntoViewIfNeeded();
    await insideViewport(page, page.getByLabel('Video language', { exact: true }));
    await screenshot(page, `settings-en-${width}`);
    expect(data.writes).toEqual([]);
  });
}
