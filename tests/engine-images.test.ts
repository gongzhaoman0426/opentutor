import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { analyzeSourceImages, normalizeImagePresentations, type ImageAnalysis } from '../src/engine/images';
import { codexJsonRunner, compileLesson, type JsonRunner } from '../src/engine/codex';
import { defaultSettings, type Asset, type Lesson } from '../src/shared/schema';
import { parseSource } from '../src/shared/source';

const harness = vi.hoisted(() => ({ input: undefined as unknown, threadOptions: undefined as unknown, inspectInput: undefined as ((input: unknown) => Promise<void>) | undefined }));
vi.mock('@openai/codex-sdk', () => ({ Codex: class { startThread(options: unknown) { harness.threadOptions = options; return { runStreamed: async (input: unknown) => { harness.input = input; await harness.inspectInput?.(input); return { events: (async function* () { yield { type: 'item.completed', item: { type: 'agent_message', text: '{"ok":true}' } }; yield { type: 'turn.completed' }; })() }; } }; } } }));
let temporary: string;
let asset: Asset;
let bytes: Buffer;
const course = '00000000-0000-4000-8000-000000000001';
const id = '00000000-0000-4000-8000-000000000002';
beforeEach(async () => {
  temporary = await mkdtemp(path.join(os.tmpdir(), 'opentutor-vision-test-'));
  bytes = await sharp({ create: { width: 160, height: 90, channels: 3, background: '#0000ff' } }).png().toBuffer();
  await writeFile(path.join(temporary, 'uploaded'), bytes);
  asset = { id, name: 'figure.png', mime: 'image/png', url: `/api/artifacts/${id}`, hash: createHash('sha256').update(bytes).digest('hex') };
  harness.inspectInput = undefined;
});
afterEach(async () => { await rm(temporary, { recursive: true, force: true }); });
const observation = { summary: '蓝色示意图', kind: 'illustration', visibleText: [], uncertainties: [], regions: [{ id: 'whole', label: '整图', box: { x: 0, y: 0, width: 1, height: 1 } }] };
function dependencies() {
  return { artifactRecord: async () => ({ id, url: asset.url, path: path.join(temporary, 'uploaded'), name: asset.name, mime: asset.mime, projectId: null }), cacheDirectory: (name = 'cache') => { const directory = path.join(temporary, name); mkdirSync(directory, { recursive: true }); return directory; } };
}
function source() { return parseSource('', [asset], [{ id: 'chapter-a', title: '观察示意图', markdown: `## 观察\n\n![教学图](asset://${id})\n\n根据图片观察颜色。` }]); }

describe('real image input and grounded teaching references', () => {
  it('passes decoded uploaded pixels to vision and scopes the hash cache to the course', async () => {
    let calls = 0;
    const runner: JsonRunner = async (_prompt, _schema, _signal, _event, images, runOptions) => {
      calls++; expect(images).toHaveLength(1); expect(images![0].assetId).toBe(id);
      expect(runOptions?.model).toBe('chosen-vision-model');
      const metadata = await sharp(images![0].path).metadata(); expect(metadata.format).toBe('png'); expect(metadata.width).toBe(160);
      const pixel = await sharp(images![0].path).raw().toBuffer(); expect([...pixel.subarray(0, 3)]).toEqual([0, 0, 255]);
      return JSON.stringify(observation);
    };
    const options = { ownerProjectId: course, modelProfile: 'test-profile', model: 'chosen-vision-model', signal: AbortSignal.timeout(5000), dependencies: dependencies() };
    const first = await analyzeSourceImages([asset], source().imageOccurrences!, runner, options);
    await analyzeSourceImages([asset], source().imageOccurrences!, runner, options);
    expect(calls).toBe(1); expect(first.analyses[0].hash).toBe(asset.hash);
    await analyzeSourceImages([asset], source().imageOccurrences!, runner, { ...options, ownerProjectId: 'another-course' });
    expect(calls).toBe(2);
    await expect(analyzeSourceImages([{ ...asset, hash: 'b'.repeat(64) }], source().imageOccurrences!, runner, options)).rejects.toThrow('内容与项目快照不一致');
    expect(calls).toBe(2);
  });
  it('repairs teaching-image omissions, grounds detail boxes, and reuses validated chapter IR', async () => {
    const document = source(); let directorCalls = 0; let visionCalls = 0;
    const runner: JsonRunner = async (prompt, schema, _signal, _event, images) => {
      if (prompt.includes('IMAGE_DATA=')) { visionCalls++; return JSON.stringify(observation); }
      directorCalls++; expect(images).toHaveLength(1);
      const contract = schema as { properties: { scenes: { items: { required: string[]; properties: { objects: { items: { required: string[] } } } } } } };
      expect(contract.properties.scenes.items.required).toContain('chapterId');
      expect(contract.properties.scenes.items.properties.objects.items.required).toContain('imagePresentation');
      const payload = JSON.parse(prompt.split('LECTURE_DATA=')[1].split('\nREPAIR_ERRORS=')[0]);
      const image = directorCalls > 1;
      return JSON.stringify({ schemaVersion: '0.1', title: '观察示意图', objectives: ['观察颜色'], scenes: [{ id: 's1', chapterId: null, title: '观察蓝色', chapter: '观察示意图', layout: 'content', sourceBlockIds: payload.sourceBlocks.map((b: { id: string }) => b.id), objects: [{ id: 'o1', type: image ? 'image' : 'text', content: image ? id : '蓝色说明', language: '', imagePresentation: image ? { fit: 'contain', caption: '蓝色示意图', region: { x: 0.9, y: 0.1, width: 0.5, height: 0.4 }, highlight: null } : null }], narration: [{ id: 'u1', text: '画面中展示蓝色示意图，观察它的颜色。', showObjectIds: ['o1'], focusObjectId: 'o1' }] }] });
    };
    const options = { source: document, ownerProjectId: course, runner, cacheDirectory: dependencies().cacheDirectory, analyzeImages: (assets: Asset[], occurrences: NonNullable<typeof document.imageOccurrences>, json: JsonRunner, options: Parameters<typeof analyzeSourceImages>[3]) => analyzeSourceImages(assets, occurrences, json, { ...options, dependencies: dependencies() }) };
    const result = await compileLesson('', defaultSettings, [asset], options);
    expect(directorCalls).toBe(2); expect(visionCalls).toBe(1);
    expect(result.lesson.scenes[0].chapterId).toBe('chapter-a');
    expect(result.lesson.scenes[0].objects[0].imagePresentation?.region).toBeNull();
    expect(result.diagnostics.some(d => d.code === 'IMAGE_REGION_FALLBACK')).toBe(true);
    await compileLesson('', { ...defaultSettings, voice: 'zh-CN-YunxiNeural', rate: 10, resolution: '1080p' }, [asset], options);
    expect(directorCalls).toBe(2); expect(visionCalls).toBe(1);
  });
  it('keeps uncertain visual detail as a full image instead of cropping guessed content', () => {
    const analysis: ImageAnalysis = { ...observation, kind: 'illustration', assetId: id, hash: asset.hash, uncertainties: ['标注文字模糊'] };
    const value = { scenes: [{ id: 's1', objects: [{ type: 'image', content: id, imagePresentation: { fit: 'contain', caption: '原图', region: observation.regions[0].box, highlight: null } }] }] };
    const issues: Parameters<typeof normalizeImagePresentations>[2] = [];
    const normalized = normalizeImagePresentations(value, [analysis], issues) as Lesson;
    expect(normalized.scenes[0].objects[0].imagePresentation?.region).toBeNull();
    expect(issues[0].code).toBe('IMAGE_REGION_FALLBACK');
  });
  it('stages image attachments inside the read-only Codex working directory with a real PNG extension', async () => {
    const input = path.join(temporary, 'uploaded');
    harness.inspectInput = async unknown => {
      const items = unknown as { type: string; path?: string; text?: string }[];
      expect(items[0].text).toContain(id); expect(items[1].type).toBe('local_image');
      expect(items[1].path).toMatch(/opentutor-director-.*\/image-1\.png$/);
      expect((await readFile(items[1].path!)).equals(bytes)).toBe(true);
    };
    const response = await codexJsonRunner('Explain the attached image', { type: 'object' }, AbortSignal.timeout(5000), undefined, [{ assetId: id, path: input, mime: 'image/png', hash: asset.hash }], { model: 'chapter-selected-model' });
    expect(response).toBe('{"ok":true}');
    expect(harness.threadOptions).toEqual(expect.objectContaining({ sandboxMode: 'read-only', approvalPolicy: 'never', model: 'chapter-selected-model' }));
  });
});
