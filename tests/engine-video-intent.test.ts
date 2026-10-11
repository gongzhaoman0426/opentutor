import { afterEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { compileLesson, regenerateScene, type JsonRunner } from '../src/engine/codex';
import { analyzeSourceImages } from '../src/engine/images';
import { directorCacheKey } from '../src/engine/pipeline';
import { defaultSettings, SettingsSchema, validateLesson, type Asset, type GenerationSettings, type JobRecord, type Lesson } from '../src/shared/schema';
import { parseSource } from '../src/shared/source';
import { videoIntentIds } from '../src/shared/video-intent';

const temporary: string[] = [];
async function directory() { const value = await mkdtemp(path.join(os.tmpdir(), 'opentutor-video-intent-')); temporary.push(value); return value; }
afterEach(async () => { await Promise.all(temporary.splice(0).map(value => rm(value, { recursive: true, force: true }))); });
type Payload = { title?: string; settings: GenerationSettings; sourceBlocks: { id: string; chapter: string }[]; imageOccurrences?: { assetId: string; sourceBlockId: string }[]; chapters?: { id: string; title: string }[]; currentScene?: Lesson['scenes'][number] };
function payload(prompt: string, marker = 'VIDEO_DATA='): Payload { return JSON.parse(prompt.split(marker)[1].split('\nREPAIR_ERRORS=')[0]); }
function output(data: Payload): Lesson {
  const image = data.imageOccurrences?.[0];
  return { schemaVersion: '0.1', title: data.title || '城市夜行', objectives: ['呈现城市入夜后的变化'], scenes: [{ id: 'scene', title: '灯光亮起', chapter: data.sourceBlocks[0].chapter, layout: 'content', sourceBlockIds: data.sourceBlocks.map(block => block.id), objects: [{ id: 'visual', type: image ? 'image' : 'text', content: image?.assetId || '夜色渐深，灯光亮起。', language: '' }], narration: [{ id: 'line', text: '入夜，街边的灯光依次亮起。', showObjectIds: ['visual'], focusObjectId: 'visual' }] }] };
}

describe('general video direction', () => {
  it.each(videoIntentIds)('keeps the brief and neutral contracts through every planning/repair stage for %s', async intent => {
    const chapters = [{ id: 'a', title: '日落', markdown: '# 日落\n\n街头灯光亮起。' }, { id: 'b', title: '深夜', markdown: '# 深夜\n\n行人逐渐归家。' }];
    const markdown = chapters.map(chapter => chapter.markdown).join('\n\n');
    const settings = SettingsSchema.parse({ videoIntent: intent, creativeBrief: '城市氛围短片，用平静的观察者旁白', model: 'test-model', creationMode: 'creative' });
    const source = parseSource(markdown, [], chapters);
    const calls: string[] = [];
    let first = true;
    const runner: JsonRunner = async (prompt, schema, _signal, _event, _images, runOptions) => {
      expect(runOptions?.model).toBe('test-model');
      expect(prompt).toContain('SELF-CONTAINED VISUALS');
      // These examples once leaked into every topic via the shared instructions.
      expect(prompt).not.toMatch(/square\(-2\)|mul\(x,x\)|负二乘以负二|返回4|局部帧|Edit this code|LECTURE_DATA=|COURSE_DATA=/);
      expect(prompt).not.toContain('Aim for 3–6');
      const overview = prompt.includes('PROJECT_DATA=');
      const data = payload(prompt, overview ? 'PROJECT_DATA=' : 'VIDEO_DATA=');
      expect(data.settings).toMatchObject({ videoIntent: intent, creativeBrief: settings.creativeBrief });
      if (!data.currentScene) expect(JSON.stringify(schema)).toContain('Communication goals:');
      if (overview) { calls.push('overview'); return JSON.stringify({ summary: '从日落到深夜的城市氛围', objectives: ['呈现城市的时间变化'], chapters: data.chapters!.map(chapter => ({ id: chapter.id, title: chapter.title, summary: '时间与城市景象' })) }); }
      calls.push(data.currentScene ? 'regenerate' : prompt.includes('REPAIR_ERRORS=') ? 'repair' : 'batch');
      const jsonSchema = schema as { properties: { scenes?: { items: unknown }; objects?: unknown } };
      expect(JSON.stringify(jsonSchema.properties.scenes?.items || jsonSchema.properties.objects)).toContain('"custom"');
      expect(prompt).toContain('NARRATION-BOUND MOTION');
      expect(prompt).toContain('抽象、情绪或氛围');
      if (data.currentScene) {
        expect(prompt).toContain('Do not output a palette field');
        expect(prompt).not.toContain('returning palette=null');
        const revised = { ...data.currentScene, title: '城市安静下来' };
        if (!prompt.includes('REPAIR_ERRORS=')) revised.sourceBlockIds = ['invalid'];
        else expect(prompt).toContain('Keep the requested purpose, tone');
        return JSON.stringify(revised);
      }
      const value = output(data);
      if (first) { first = false; value.scenes[0].sourceBlockIds = ['invalid']; }
      return JSON.stringify(value);
    };
    const result = await compileLesson(markdown, settings, [], { source, runner });
    expect(calls).toEqual(['overview', 'batch', 'repair', 'batch']);
    expect(result.lesson.objectives).toEqual(['呈现城市入夜后的变化']);
    expect(result.lesson.scenes.every(scene => scene.narration[0].text === '入夜，街边的灯光依次亮起。')).toBe(true);
    const revised = await regenerateScene(result.lesson, result.lesson.scenes[0].id, '强化夜晚氛围', source, settings, [], { runner });
    expect(revised.lesson.scenes[0].title).toBe('城市安静下来');
    expect(revised.lesson.scenes[1]).toEqual(result.lesson.scenes[1]);
    expect(calls.at(-1)).toBe('regenerate');
  });

  it('uses the existing palette during scene regeneration without requesting fields excluded by its schema', async () => {
    const markdown = '入夜，街边的灯光亮起。';
    const source = parseSource(markdown);
    const settings = SettingsSchema.parse({ videoIntent: 'story', stylePrompt: '暖色夜景' });
    const lesson = output({ settings, sourceBlocks: source.blocks });
    lesson.palette = { background: '#181820', surface: '#24242c', text: '#ffffff', muted: '#ccccdd', accent: '#ffaa66' };
    const result = await regenerateScene(lesson, 'scene', '保持意境，调整构图', source, settings, [], { runner: async (prompt, schema) => {
      expect(prompt).toContain('Do not output a palette field');
      expect(prompt).not.toContain('output five #RRGGBB colors');
      const data = payload(prompt);
      expect(JSON.parse(prompt.split('VIDEO_DATA=')[1]).palette).toEqual(lesson.palette);
      expect((schema as { properties: unknown }).properties).not.toHaveProperty('palette');
      return JSON.stringify(data.currentScene);
    } });
    expect(result.lesson.palette).toEqual(lesson.palette);
  });

  it('reuses identical direction caches and invalidates overview and batches when intent or brief changes', async () => {
    const dir = await directory();
    const chapters = [{ id: 'a', title: '功能', markdown: '离线写作。' }, { id: 'b', title: '应用', markdown: '用于草稿整理。' }];
    const markdown = chapters.map(chapter => chapter.markdown).join('\n\n');
    const source = parseSource(markdown, [], chapters);
    let count = 0;
    const runner: JsonRunner = async prompt => {
      count++;
      if (prompt.includes('PROJECT_DATA=')) { const data = payload(prompt, 'PROJECT_DATA='); return JSON.stringify({ summary: '功能与应用', objectives: ['介绍产品'], chapters: data.chapters!.map(chapter => ({ id: chapter.id, title: chapter.title, summary: chapter.title })) }); }
      return JSON.stringify(output(payload(prompt)));
    };
    const run = (settings: GenerationSettings) => compileLesson(markdown, settings, [], { runner, source, ownerProjectId: 'direction-cache', cacheDirectory: () => dir });
    await run(defaultSettings); expect(count).toBe(3);
    await run(defaultSettings); expect(count).toBe(3);
    const product = { ...defaultSettings, videoIntent: 'product' as const };
    await run(product); expect(count).toBe(6);
    await run({ ...product, creativeBrief: '用于官网的产品开场' }); expect(count).toBe(9);
    const { videoIntent: _intent, creativeBrief: _brief, ...legacy } = defaultSettings;
    await run(legacy as GenerationSettings); expect(count).toBe(9);
    const job: Pick<JobRecord, 'kind' | 'sceneId' | 'instruction' | 'snapshot'> = { kind: 'preview', sceneId: null, instruction: null, snapshot: { id: 'p', title: '产品', markdown, settings: defaultSettings, assets: [], revision: 1, lesson: null } };
    expect(directorCacheKey({ ...job, snapshot: { ...job.snapshot, settings: legacy as GenerationSettings } })).toBe(directorCacheKey(job));
    expect(directorCacheKey({ ...job, snapshot: { ...job.snapshot, settings: product } })).not.toBe(directorCacheKey(job));
    expect(directorCacheKey({ ...job, snapshot: { ...job.snapshot, settings: { ...defaultSettings, creativeBrief: '展示新功能' } } })).not.toBe(directorCacheKey(job));
  });

  it('passes direction to image understanding during compilation and single-scene repair', async () => {
    const asset: Asset = { id: '00000000-0000-4000-8000-000000000001', name: 'screen.png', hash: 'screen', mime: 'image/png', url: '/api/artifacts/00000000-0000-4000-8000-000000000001' };
    const markdown = '![编辑器界面](screen.png)'; const source = parseSource(markdown, [asset]);
    const settings = { ...defaultSettings, videoIntent: 'product' as const, creativeBrief: '通过界面展示离线写作' };
    let analyses = 0;
    const analyzeImages: typeof analyzeSourceImages = async (_assets, _occurrences, _runner, options) => {
      analyses++; expect(options.creativeContext).toEqual({ videoIntent: 'product', creativeBrief: settings.creativeBrief, audience: settings.audience, language: settings.language });
      return { analyses: [], attachments: [], diagnostics: [] };
    };
    const runner: JsonRunner = async prompt => { const data = payload(prompt); return JSON.stringify(data.currentScene || output(data)); };
    const first = await compileLesson(markdown, settings, [asset], { source, runner, analyzeImages });
    await regenerateScene(first.lesson, first.lesson.scenes[0].id, '保持原图', source, settings, [asset], { runner, analyzeImages });
    expect(analyses).toBe(2);
    expect(first.lesson.scenes[0].objects[0].content).toBe(asset.id);
    expect(validateLesson(first.lesson, source, [asset], 'full').filter(issue => issue.severity === 'error')).toEqual([]);
  });

  it('sends author direction with real pixels and invalidates vision cache for a changed brief', async () => {
    const dir = await directory(); const imagePath = path.join(dir, 'source.png');
    await sharp({ create: { width: 8, height: 8, channels: 3, background: '#eeeeee' } }).png().toFile(imagePath);
    // Use the exact file bytes for the upload fingerprint, not a re-encoding.
    const asset: Asset = { id: '00000000-0000-4000-8000-000000000002', name: 'cover.png', hash: createHash('sha256').update(await readFile(imagePath)).digest('hex'), mime: 'image/png', url: '/api/artifacts/00000000-0000-4000-8000-000000000002' };
    const occurrences = [{ id: 'occ', assetId: asset.id, sourceBlockId: 'block', chapterId: 'section', alt: '封面', caption: '' }];
    const contexts: { videoIntent: string; creativeBrief: string }[] = [];
    const runner: JsonRunner = async (prompt, _schema, _signal, _onEvent, images) => {
      const data = JSON.parse(prompt.split('IMAGE_DATA=')[1]); contexts.push(data.creativeContext);
      expect(images).toHaveLength(1); expect(images![0].hash).toBe(asset.hash);
      return JSON.stringify({ summary: '浅灰色方形', kind: 'illustration', visibleText: [], uncertainties: [], regions: [] });
    };
    const options = { signal: new AbortController().signal, ownerProjectId: 'project', creativeContext: { videoIntent: 'story' as const, creativeBrief: '安静的序幕', audience: '普通观众', language: 'zh-CN' as const }, dependencies: { cacheDirectory: () => dir, artifactRecord: async () => ({ ...asset, path: imagePath, projectId: 'project' }) } };
    await analyzeSourceImages([asset], occurrences, runner, options);
    await analyzeSourceImages([asset], occurrences, runner, options);
    expect(contexts).toHaveLength(1);
    await analyzeSourceImages([asset], occurrences, runner, { ...options, creativeContext: { ...options.creativeContext, creativeBrief: '产品发布的开场' } });
    expect(contexts.map(context => context.creativeBrief)).toEqual(['安静的序幕', '产品发布的开场']);
  });

  it('keeps custom execution constrained by creation mode for every video intent', () => {
    const source = parseSource('展示产品结构。', []);
    const lesson = output({ settings: defaultSettings, sourceBlocks: source.blocks });
    lesson.scenes[0].objects[0] = { id: 'visual', type: 'custom', content: 'return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1104 286"><rect x="40" y="40" width="200" height="100" fill="#336699"/></svg>`;', language: '' };
    for (const videoIntent of ['auto', 'explainer', 'product', 'briefing', 'story']) {
      const settings = SettingsSchema.parse({ videoIntent });
      expect(validateLesson(lesson, source, [], 'full', settings.creationMode).some(issue => issue.code === 'CUSTOM_MODE')).toBe(true);
      expect(validateLesson(lesson, source, [], 'full', 'creative').filter(issue => issue.severity === 'error')).toEqual([]);
    }
    expect(SettingsSchema.safeParse({ videoIntent: 'unknown' }).success).toBe(false);
    expect(SettingsSchema.safeParse({ creativeBrief: 'x'.repeat(2001) }).success).toBe(false);
  });
});
