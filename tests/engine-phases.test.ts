import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pipelineSources, runPipeline, validateExportPlan, type PipelineDependencies, type PipelinePreview, type PipelineReporter } from '../src/engine/pipeline';
import { defaultSettings, type JobKind, type JobRecord, type Lesson, type SpeechResult } from '../src/shared/schema';
import { parseSource } from '../src/shared/source';
import { buildRenderPlan } from '../src/video/timeline';
import { speechCacheKey } from '../src/engine/speech';
import type { RenderProgress } from '../src/shared/render-progress';

const markdown = '先定义问题的范围。\n\n再通过例子检验理解。';
const source = parseSource(markdown);
const fixture: Lesson = { schemaVersion: '0.1', title: '阶段测试讲义', objectives: ['理解步骤'], scenes: source.blocks.map((b, i) => ({ id: `s${i}`, title: '学习步骤', chapter: b.chapter, layout: 'content', sourceBlockIds: [b.id], objects: [{ id: 'o1', type: 'text', content: b.text, language: '' }], narration: [{ id: 'u1', text: `${b.text}我们用简单实例加深理解。`, showObjectIds: ['o1'], focusObjectId: 'o1' }] })) };
let temporary: string;
beforeEach(async () => { temporary = await mkdtemp(path.join(os.tmpdir(), 'opentutor-phase-test-')); });
afterEach(async () => { await rm(temporary, { recursive: true, force: true }); });
function job(kind: JobKind): JobRecord {
  const timestamp = new Date().toISOString();
  return { id: '00000000-0000-4000-8000-000000000001', projectId: '00000000-0000-4000-8000-000000000002', kind, status: 'running', stage: 'starting', completed: 0, total: 0, inputRevision: 1, outputRevision: null, error: null, diagnostics: [], videoUrl: null, subtitleUrl: null, createdAt: timestamp, updatedAt: timestamp, sceneId: kind === 'regenerate' ? 's0' : null, instruction: null, snapshot: { id: '00000000-0000-4000-8000-000000000002', title: fixture.title, markdown, settings: defaultSettings, assets: [], revision: 1, lesson: kind === 'compose' || kind === 'generate' ? null : fixture } };
}
function audio(text: string): SpeechResult { return { url: '/api/artifacts/00000000-0000-4000-8000-000000000003', durationSeconds: 2, boundaries: [{ kind: 'sentence', text, startSeconds: 0.1, endSeconds: 1.9 }], cacheHit: false, hash: speechCacheKey(text, defaultSettings.voice, defaultSettings.rate) }; }
function setup() {
  const previews: PipelinePreview[] = [];
  const reporter: PipelineReporter = { progress: vi.fn(async () => {}), diagnostic: vi.fn(async () => {}), preview: vi.fn(async preview => { previews.push(preview); }) };
  const dependencies: Partial<PipelineDependencies> = {
    compileLesson: vi.fn(async (_markdown, _settings, _assets, options) => { await options?.onLesson?.(fixture); return { lesson: fixture, diagnostics: [] }; }),
    regenerateScene: vi.fn(async (_lesson, _sceneId, _instruction, _source, _settings, _assets, options) => { await options?.onLesson?.(fixture); return { lesson: fixture, diagnostics: [] }; }),
    synthesizeSpeech: vi.fn(async text => audio(text)),
    assembleNarrationAudio: vi.fn(async plan => ({ url: '/api/artifacts/00000000-0000-4000-8000-000000000005', durationSeconds: plan.totalFrames / plan.fps })),
    renderVideo: vi.fn(async () => {}),
    cacheDirectory: name => { const directory = path.join(temporary, name || 'cache'); mkdirSync(directory, { recursive: true }); return directory; },
    publishFile: vi.fn(async (file, mime, name, ownerProjectId) => ({ id: '00000000-0000-4000-8000-000000000004', url: '/api/artifacts/00000000-0000-4000-8000-000000000004', path: file, mime, name: name || 'artifact', projectId: ownerProjectId || null })),
  };
  return { dependencies, reporter, previews };
}

describe('independent generation stages', () => {
  it('targets the frozen chapter while retaining course context and ignoring unrelated missing images', () => {
    const input = job('preview'); input.chapterId = 'a'; input.snapshot.sourceMode = 'chapters';
    input.snapshot.chapters = [{ id: 'a', title: '第一章', markdown: '冻结后的正确正文。' }];
    input.snapshot.context = [{ id: 'a', title: '旧标题', markdown: '过期的上下文正文。' }, { id: 'b', title: '第二章', markdown: '![未上传图片](missing.png)' }];
    const { source, contextSource } = pipelineSources(input);
    expect(source.blocks.every(block => block.chapterId === 'a')).toBe(true);
    expect(source.blocks.map(block => block.text).join('')).toContain('冻结后的正确正文');
    expect(source.diagnostics.some(d => d.severity === 'error')).toBe(false);
    expect(contextSource?.chapters).toHaveLength(2);
  });
  it('resolves a selected chapter image reference whose definition lives in another chapter', () => {
    const input = job('preview'); input.chapterId = 'a'; input.snapshot.sourceMode = 'chapters';
    const asset = { id: '00000000-0000-4000-8000-000000000006', name: 'figure.png', mime: 'image/png' as const, url: '/api/artifacts/00000000-0000-4000-8000-000000000006', hash: 'a'.repeat(64) };
    input.snapshot.assets = [asset]; input.snapshot.chapters = [{ id: 'a', title: '第一章', markdown: '![教学图][reference]' }];
    input.snapshot.context = [...input.snapshot.chapters, { id: 'b', title: '资料', markdown: `[reference]: asset://${asset.id}` }];
    const { source } = pipelineSources(input);
    expect(source.imageOccurrences?.[0].assetId).toBe(asset.id);
    expect(source.diagnostics.some(d => d.severity === 'error')).toBe(false);
    expect(source.blocks.every(b => b.chapterId === 'a')).toBe(true);
  });
  it('selected preview generates only its chapter and passes frozen model/settings plus full context', async () => {
    const { dependencies, reporter } = setup(); const input = job('preview');
    input.chapterId = 'a'; input.snapshot.sourceMode = 'chapters'; input.snapshot.lesson = null;
    input.snapshot.settings = { ...defaultSettings, model: 'chapter-model', voice: 'zh-CN-YunxiNeural', theme: 'ocean' };
    input.snapshot.chapters = [{ id: 'a', title: '第一章', markdown }];
    input.snapshot.context = [...input.snapshot.chapters, { id: 'b', title: '第二章', markdown: '未选中的章节正文。' }];
    const source = pipelineSources(input).source;
    const selected = { ...fixture, title: '第一章', scenes: fixture.scenes.map((scene, index) => ({ ...scene, chapter: '第一章', chapterId: 'a', sourceBlockIds: [source.blocks[index].id] })) };
    dependencies.compileLesson = vi.fn(async (_markdown, settings, _assets, options) => {
      expect(settings.model).toBe('chapter-model'); expect(options?.contextSource?.chapters).toHaveLength(2);
      expect(options?.source?.blocks.every((b: { chapterId?: string }) => b.chapterId === 'a')).toBe(true);
      expect(options?.lessonTitle).toBe('第一章'); await options?.onLesson?.(selected); return { lesson: selected, diagnostics: [] };
    });
    const result = await runPipeline(input, AbortSignal.timeout(5000), reporter, dependencies);
    expect(result.lesson?.scenes.every(s => s.chapterId === 'a')).toBe(true);
    expect(dependencies.synthesizeSpeech).toHaveBeenCalledWith(expect.any(String), 'zh-CN-YunxiNeural', 0, expect.any(Object));
    expect(dependencies.renderVideo).not.toHaveBeenCalled();
  });
  it('chapter export uses its frozen preview revision after unrelated course edits', async () => {
    const { dependencies, reporter } = setup(); const input = job('export');
    input.chapterId = 'a'; input.inputRevision = 10; input.snapshot.revision = 3; input.snapshot.previewRevision = 3;
    input.snapshot.sourceMode = 'chapters'; input.snapshot.chapters = [{ id: 'a', title: '第一章', markdown }];
    input.snapshot.context = [...input.snapshot.chapters, { id: 'b', title: '已编辑的其他章', markdown: '不影响第一章冻结导出。' }];
    const source = pipelineSources(input).source;
    const selected = { ...fixture, title: '第一章', scenes: fixture.scenes.map((scene, index) => ({ ...scene, chapter: '第一章', chapterId: 'a', sourceBlockIds: [source.blocks[index].id] })) };
    input.snapshot.lesson = selected;
    const speech = new Map(selected.scenes.map(s => [`${s.id}:u1`, audio(s.narration[0].text)]));
    input.snapshot.renderPlan = buildRenderPlan(selected, defaultSettings, speech, 3);
    const result = await runPipeline(input, AbortSignal.timeout(5000), reporter, dependencies);
    expect(result.videoUrl).toBeDefined(); expect(dependencies.compileLesson).not.toHaveBeenCalled();
    expect(dependencies.synthesizeSpeech).not.toHaveBeenCalled(); expect(dependencies.renderVideo).toHaveBeenCalledOnce();
    expect(dependencies.renderVideo).toHaveBeenCalledWith(expect.objectContaining({ revision: 3 }), expect.any(Array), expect.any(String), expect.any(AbortSignal), expect.any(Function));
  });
  it('validates edited custom code again before speech or export instead of trusting old compiler validation', async () => {
    const { dependencies, reporter } = setup(); const input = job('speech');
    input.snapshot.settings = { ...defaultSettings, creationMode: 'creative' };
    const edited = structuredClone(fixture); edited.scenes[0].objects[0] = { id: 'o1', type: 'custom', content: 'while(true){}', language: 'javascript' };
    input.snapshot.lesson = edited;
    await expect(runPipeline(input, AbortSignal.timeout(5000), reporter, dependencies)).rejects.toThrow('自定义组件');
    expect(dependencies.synthesizeSpeech).not.toHaveBeenCalled(); expect(dependencies.renderVideo).not.toHaveBeenCalled();
  });
  it('reports actual rendered frames and immediate phase changes without logging every frame or finishing before publication', async () => {
    const { dependencies, reporter } = setup(); const input = job('export');
    const speech = new Map(fixture.scenes.map(s => [`${s.id}:u1`, audio(s.narration[0].text)]));
    input.snapshot.previewRevision = 1;
    input.snapshot.renderPlan = buildRenderPlan(fixture, defaultSettings, speech, 1);
    const frames = input.snapshot.renderPlan.totalFrames;
    const timestamp = vi.spyOn(Date, 'now').mockReturnValue(5000);
    dependencies.renderVideo = vi.fn(async (_plan, _assets, _output, _signal, onProgress) => {
      const detail: RenderProgress = { phase: 'rendering', renderedFrames: 10, totalFrames: frames, elapsedMs: 1000, framesPerSecond: 10 };
      onProgress?.(0.1, detail);
      timestamp.mockReturnValue(6200);
      onProgress?.(0.2, { ...detail, renderedFrames: 20, elapsedMs: 2200 });
      onProgress?.(0.3, { ...detail, renderedFrames: 30, elapsedMs: 2250 });
      onProgress?.(0.94, { ...detail, phase: 'encoding', renderedFrames: frames, elapsedMs: 2260 });
      onProgress?.(1, { ...detail, phase: 'muxing', renderedFrames: frames, elapsedMs: 2270 });
    });
    try {
      await runPipeline(input, AbortSignal.timeout(5000), reporter, dependencies);
      const updates = vi.mocked(reporter.progress).mock.calls.filter(call => call[0] === 'render');
      const details = updates.filter(call => call[4] !== undefined);
      expect(details.map(call => [call[4]!.phase, call[4]!.renderedFrames])).toEqual([
        ['rendering', 10], ['rendering', 20], ['encoding', frames], ['muxing', frames],
      ]);
      expect(details.filter(call => call[3] !== undefined).map(call => call[3])).toEqual(['绘制视频画面', '编码视频', '合成音视频']);
      expect(details.every(call => call[1] < 100)).toBe(true);
      expect(updates.at(-1)).toEqual(['render', 100, 100, '视频与字幕已生成']);
      expect(dependencies.publishFile).toHaveBeenCalledTimes(2);
    } finally { timestamp.mockRestore(); }
  });
  it('preview composes IR and continuous speech/SRT without rendering MP4', async () => {
    const { dependencies, reporter } = setup();
    const input = job('preview'); input.snapshot.lesson = null;
    const result = await runPipeline(input, AbortSignal.timeout(5000), reporter, dependencies);
    expect(dependencies.compileLesson).toHaveBeenCalledOnce();
    expect(dependencies.synthesizeSpeech).toHaveBeenCalledTimes(fixture.scenes.length);
    expect(dependencies.assembleNarrationAudio).toHaveBeenCalledOnce();
    expect(result.renderPlan?.previewMode).toBe('aligned');
    expect(result.subtitleUrl).toBeDefined(); expect(result.videoUrl).toBeUndefined();
    expect(dependencies.renderVideo).not.toHaveBeenCalled();
  });
  it('compose returns IR and publishes a silent draft without touching TTS or rendering', async () => {
    const { dependencies, reporter, previews } = setup();
    const result = await runPipeline(job('compose'), AbortSignal.timeout(5000), reporter, dependencies);
    expect(result.lesson).toEqual(fixture);
    expect(result.renderPlan).toBeUndefined();
    expect(result.videoUrl).toBeUndefined();
    expect(dependencies.synthesizeSpeech).not.toHaveBeenCalled();
    expect(dependencies.assembleNarrationAudio).not.toHaveBeenCalled();
    expect(dependencies.renderVideo).not.toHaveBeenCalled();
    expect(dependencies.publishFile).not.toHaveBeenCalled();
    expect(previews[0].renderPlan?.previewMode).toBe('draft');
    expect(previews[0].renderPlan?.scenes.every(s => s.utterances.every(u => u.estimated && !u.url))).toBe(true);
  });
  it('regenerate changes only the IR stage and does not automatically synthesize or export', async () => {
    const { dependencies, reporter } = setup();
    const result = await runPipeline(job('regenerate'), AbortSignal.timeout(5000), reporter, dependencies);
    expect(result.lesson).toEqual(fixture);
    expect(dependencies.regenerateScene).toHaveBeenCalledOnce();
    expect(dependencies.compileLesson).not.toHaveBeenCalled();
    expect(dependencies.synthesizeSpeech).not.toHaveBeenCalled();
    expect(dependencies.renderVideo).not.toHaveBeenCalled();
  });
  it('speech exposes completed real clips incrementally and returns aligned subtitles without Codex or MP4', async () => {
    const { dependencies, reporter, previews } = setup();
    dependencies.synthesizeSpeech = vi.fn(async text => {
      if (text === fixture.scenes[1].narration[0].text) {
        expect(previews.at(-1)?.renderPlan?.previewMode).toBe('partial');
        expect(previews.at(-1)?.renderPlan?.scenes[0].utterances[0].url).not.toBe('');
        expect(previews.at(-1)?.renderPlan?.scenes[1].utterances[0].estimated).toBe(true);
      }
      return audio(text);
    });
    const result = await runPipeline(job('speech'), AbortSignal.timeout(5000), reporter, dependencies);
    expect(dependencies.compileLesson).not.toHaveBeenCalled();
    expect(dependencies.renderVideo).not.toHaveBeenCalled();
    expect(result.renderPlan?.previewMode).toBe('aligned');
    expect(dependencies.assembleNarrationAudio).toHaveBeenCalledOnce();
    expect(result.renderPlan?.narrationAudio?.durationSeconds).toBe(result.renderPlan!.totalFrames / result.renderPlan!.fps);
    expect(previews.at(-1)?.renderPlan?.narrationAudio).toEqual(result.renderPlan?.narrationAudio);
    expect(result.renderPlan?.scenes.every(s => s.utterances.every(u => !u.estimated && !!u.url))).toBe(true);
    expect(result.subtitleUrl).toBeDefined();
    expect(result.videoUrl).toBeUndefined();
    expect(dependencies.publishFile).toHaveBeenCalledOnce();
    expect(previews.at(-1)?.renderPlan?.previewMode).toBe('aligned');
  });
  it('export refuses partial preview before any synthesis or rendering', async () => {
    const { dependencies, reporter } = setup();
    const exported = job('export');
    const speech = new Map(fixture.scenes.map(s => [`${s.id}:u1`, audio(s.narration[0].text)]));
    exported.snapshot.renderPlan = { ...buildRenderPlan(fixture, defaultSettings, speech, 1), previewMode: 'partial' };
    exported.snapshot.previewRevision = 1;
    await expect(runPipeline(exported, AbortSignal.timeout(5000), reporter, dependencies)).rejects.toThrow('部分配音预览不能导出');
    expect(dependencies.compileLesson).not.toHaveBeenCalled();
    expect(dependencies.synthesizeSpeech).not.toHaveBeenCalled();
    expect(dependencies.renderVideo).not.toHaveBeenCalled();
  });
  it('aligned export protects against silently using old narration or different voice', () => {
    const speech = new Map(fixture.scenes.map(s => [`${s.id}:u1`, audio(s.narration[0].text)]));
    const plan = { ...buildRenderPlan(fixture, defaultSettings, speech, 1), previewMode: 'aligned' as const, voice: defaultSettings.voice, rate: defaultSettings.rate };
    expect(() => validateExportPlan(plan, fixture, 'en-US-AriaNeural', 0)).toThrow('配音设置已变化');
    const edited = structuredClone(fixture); edited.scenes[0].narration[0].text = '修改后的讲解。';
    expect(() => validateExportPlan(plan, edited, defaultSettings.voice, 0)).toThrow('不属于当前分镜');
    const estimated = structuredClone(plan); estimated.scenes[0].utterances[0].estimated = true;
    expect(() => validateExportPlan(estimated, fixture, defaultSettings.voice, 0)).toThrow('未完成配音');
  });
  it('cancelled speech keeps the first playable preview and skips later audio and rendering', async () => {
    const { dependencies, reporter, previews } = setup();
    const controller = new AbortController();
    reporter.preview = vi.fn(async preview => {
      previews.push(preview);
      if (preview.renderPlan?.previewMode === 'partial') controller.abort('test_cancel');
    });
    await expect(runPipeline(job('speech'), controller.signal, reporter, dependencies)).rejects.toBeDefined();
    expect(dependencies.synthesizeSpeech).toHaveBeenCalledOnce();
    expect(previews.at(-1)?.renderPlan?.scenes[0].utterances[0].url).not.toBe('');
    expect(dependencies.renderVideo).not.toHaveBeenCalled();
    expect(dependencies.publishFile).not.toHaveBeenCalled();
  });
});
