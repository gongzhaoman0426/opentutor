import { createHash } from 'node:crypto';
import { rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { compileLesson, regenerateScene, type CompiledLesson } from './codex';
import { synthesizeSpeech } from './speech';
import { assembleNarrationAudio } from './narration-audio';
import { LessonSchema, validateLesson, type Diagnostic, type JobRecord, type Lesson, type RenderPlan, type SourceDocument, type SpeechResult } from '../shared/schema';
import { parseSource } from '../shared/source';
import { cacheDirectory, publishFile } from '../server/artifacts';
import { renderVideo, buildRenderPlan, toSrt } from '../video/export';
import { buildPreviewPlan } from '../video/preview';
import type { CompletedResult } from '../server/store';
import { validateCustomLesson } from './custom-validation';
import { videoDirection } from '../shared/video-intent';
import { renderPhaseLabels, type RenderProgress } from '../shared/render-progress';

export interface PipelinePreview { lesson: Lesson; renderPlan: RenderPlan | null }
export interface PipelineReporter {
  progress(stage: string, completed: number, total: number, message?: string, renderProgress?: RenderProgress): Promise<void>;
  diagnostic(diagnostic: Diagnostic): Promise<void>;
  preview?(preview: PipelinePreview): Promise<void>;
}
export interface PipelineDependencies {
  compileLesson: typeof compileLesson;
  regenerateScene: typeof regenerateScene;
  synthesizeSpeech: typeof synthesizeSpeech;
  assembleNarrationAudio: typeof assembleNarrationAudio;
  renderVideo: typeof renderVideo;
  cacheDirectory: typeof cacheDirectory;
  publishFile: typeof publishFile;
  buildPreviewPlan: typeof buildPreviewPlan;
  validateCustomLesson: typeof validateCustomLesson;
}
const actualDependencies: PipelineDependencies = { compileLesson, regenerateScene, synthesizeSpeech, assembleNarrationAudio, renderVideo, cacheDirectory, publishFile, buildPreviewPlan, validateCustomLesson };

export function pipelineSources(job: JobRecord): { source: SourceDocument; contextSource?: SourceDocument } {
  const snapshot = job.snapshot;
  if (snapshot.sourceMode !== 'chapters') return { source: parseSource(snapshot.markdown, snapshot.assets) };
  const frozenChapters = snapshot.chapters || [];
  const frozenById = new Map(frozenChapters.map(chapter => [chapter.id, chapter]));
  const context = (snapshot.context?.length ? snapshot.context : frozenChapters).map(chapter => frozenById.get(chapter.id) || chapter);
  for (const chapter of frozenChapters) if (!context.some(item => item.id === chapter.id)) context.push(chapter);
  const complete = parseSource(snapshot.markdown, snapshot.assets, context);
  if (!job.chapterId) return { source: complete, contextSource: complete };
  const selected = new Set((snapshot.chapters || []).map(chapter => chapter.id));
  if (selected.size !== 1 || !selected.has(job.chapterId)) throw new Error('章节任务快照必须只包含选中的章节');
  const blocks = complete.blocks.filter(block => block.chapterId === job.chapterId);
  const blockIds = new Set(blocks.map(block => block.id));
  if (!blocks.length) throw new Error('选中的章节没有可生成的正文或图片');
  const chapters = complete.chapters?.filter(chapter => selected.has(chapter.id));
  const source: SourceDocument = { ...complete, hash: createHash('sha256').update(JSON.stringify({ chapters, chapterSourceKey: snapshot.chapterSourceKey })).digest('hex'), blocks, chapters, imageOccurrences: complete.imageOccurrences?.filter(occurrence => blockIds.has(occurrence.sourceBlockId)), diagnostics: complete.diagnostics.filter(diagnostic => !diagnostic.sourceBlockId || blockIds.has(diagnostic.sourceBlockId)) };
  return { source, contextSource: complete };
}

export async function runPipeline(job: JobRecord, signal: AbortSignal, reporter: PipelineReporter, overrides: Partial<PipelineDependencies> = {}): Promise<CompletedResult> {
  // Dependency overrides are explicit test seams. The live Worker uses only the real dependencies above.
  const services = { ...actualDependencies, ...overrides };
  const snapshot = job.snapshot;
  const publishPreview = async (lesson: Lesson, speech = new Map<string, SpeechResult>(), alignedPlan?: RenderPlan) => {
    signal.throwIfAborted();
    if (!reporter.preview) return;
    const renderPlan = alignedPlan || services.buildPreviewPlan(lesson, snapshot.settings, snapshot.revision, snapshot.renderPlan, speech);
    await reporter.preview({ lesson, renderPlan });
  };
  signal.throwIfAborted();
  await reporter.progress('parse', 0, 1, '解析 Markdown 并建立来源映射');
  const { source, contextSource } = pipelineSources(job);
  for (const diagnostic of source.diagnostics) await reporter.diagnostic(diagnostic);
  if (source.diagnostics.some(d => d.severity === 'error')) throw new Error(source.diagnostics.filter(d => d.severity === 'error').map(d => d.message).join('；'));
  await reporter.progress('parse', 1, 1);
  let lesson: Lesson | null = snapshot.lesson;
  if (['compose', 'preview', 'generate', 'regenerate'].includes(job.kind)) {
    const checkpointDir = services.cacheDirectory('checkpoints');
    const fingerprint = directorCacheKey(job);
    const checkpointPath = path.join(checkpointDir, `${fingerprint}.lesson.json`);
    let compiled: CompiledLesson | undefined;
    // Only the compiler's scoped chapter cache is reused: it validates real image bytes,
    // full course context and the resolved model profile before returning cached IR.
    if (!compiled) {
      await reporter.progress('codex', 0, 1, job.kind === 'regenerate' ? 'Codex 正在重新规划选中的场景' : 'Codex 正在规划旁白、分镜与画面对象');
      const options = { signal, contextSource, ownerProjectId: snapshot.id, courseTitle: snapshot.title, lessonTitle: job.chapterId ? snapshot.chapters?.find(chapter => chapter.id === job.chapterId)?.title : undefined, validateCustom: services.validateCustomLesson, cacheDirectory: services.cacheDirectory, onLesson: (partial: Lesson) => publishPreview(partial), onProgress: (done: number, total: number, message: string) => reporter.progress('codex', done, total, message), onStage: (stage: string, done: number, total: number, message: string) => reporter.progress(stage, done, total, message) };
      if (job.kind === 'regenerate') {
        if (!lesson || !job.sceneId) throw new Error('缺少需要重新生成的场景');
        compiled = await services.regenerateScene(lesson, job.sceneId, job.instruction || '让表达更清晰，并改进画面编排', source, snapshot.settings, snapshot.assets, options);
      } else {
        compiled = await services.compileLesson(snapshot.markdown, snapshot.settings, snapshot.assets, { ...options, source });
      }
      signal.throwIfAborted();
      await writeFile(checkpointPath, JSON.stringify({ fingerprint, lesson: compiled.lesson }), { mode: 0o600 });
    }
    lesson = compiled.lesson;
    for (const diagnostic of compiled.diagnostics) if (!source.diagnostics.some(d => d.code === diagnostic.code && d.message === diagnostic.message)) await reporter.diagnostic(diagnostic);
  }
  if (!lesson) throw new Error('当前任务缺少已生成视频内容');
  signal.throwIfAborted();
  await reporter.progress('validate', 0, 1, '检查视频结构、画面引用与来源覆盖');
  // Existing legacy lessons keep their original source IDs and remain exportable; newly directed lessons enforce every image occurrence.
  const validationSource = snapshot.sourceMode !== 'chapters' && !['compose', 'preview', 'generate', 'regenerate'].includes(job.kind) ? { ...source, imageOccurrences: [] } : source;
  const validation = [...validateLesson(lesson, validationSource, snapshot.assets, snapshot.settings.mode, snapshot.settings.creationMode), ...await services.validateCustomLesson(lesson)];
  const errors = validation.filter(d => d.severity === 'error');
  if (errors.length) throw new Error(`视频无法生成：${errors.slice(0, 8).map(d => d.message).join('；')}`);
  if (['speech', 'rebuild', 'export'].includes(job.kind)) for (const diagnostic of validation) await reporter.diagnostic(diagnostic);
  await reporter.progress('validate', 1, 1);
  // Publish the IR as soon as it is available. Estimated preview durations are explicit and have no fake audio.
  if (job.kind !== 'export') await publishPreview(lesson);
  if (job.kind === 'compose' || job.kind === 'regenerate') return { lesson };

  let plan = job.kind === 'export' ? snapshot.renderPlan : null;
  if (job.kind === 'export') {
    if (!plan || snapshot.previewRevision !== snapshot.revision) throw new Error('导出快照没有当前版本的已对齐预览，请先生成配音');
    validateExportPlan(plan, lesson, snapshot.settings.voice, snapshot.settings.rate);
  }
  if (!plan) {
    const utterances = lesson.scenes.flatMap(scene => scene.narration.map(utterance => ({ scene, utterance })));
    const speechResults = new Map<string, SpeechResult>();
    await reporter.progress('speech', 0, utterances.length, '使用微软免费 TTS 生成语音与边界时间');
    for (const [index, { scene, utterance }] of utterances.entries()) {
      signal.throwIfAborted();
      const speech = await services.synthesizeSpeech(utterance.text, snapshot.settings.voice, snapshot.settings.rate, { signal, ownerProjectId: snapshot.id, onWarning: message => reporter.diagnostic({ code: 'UTTERANCE_SYNC', severity: 'warning', sceneId: scene.id, message }) });
      speechResults.set(`${scene.id}:${utterance.id}`, speech);
      // Each real audio artifact becomes immediately playable while later utterances are still being synthesized.
      await publishPreview(lesson, speechResults);
      await reporter.progress('speech', index + 1, utterances.length, `配音 ${index + 1}/${utterances.length}${speech.cacheHit ? '（复用缓存）' : ''}`);
    }
    await reporter.progress('timeline', 0, 1, '合成连续配音音轨，按实际时长编译字幕与画面时间轴');
    plan = buildRenderPlan(lesson, snapshot.settings, speechResults, snapshot.revision);
    plan.narrationAudio = await services.assembleNarrationAudio(plan, snapshot.id, signal);
    signal.throwIfAborted();
    await publishPreview(lesson, speechResults, plan);
    await reporter.progress('timeline', 1, 1);
  }
  signal.throwIfAborted();
  const outputDir = services.cacheDirectory('exports');
  const subtitlePath = path.join(outputDir, `${job.id}.srt`);
  await writeFile(subtitlePath, toSrt(plan), { mode: 0o600 });
  if (job.kind === 'speech' || job.kind === 'preview') {
    try {
      signal.throwIfAborted();
      const subtitle = await services.publishFile(subtitlePath, 'application/x-subrip; charset=utf-8', `${lesson.title}.srt`, snapshot.id);
      signal.throwIfAborted();
      return { lesson, renderPlan: plan, subtitleUrl: subtitle.url };
    } finally { await rm(subtitlePath, { force: true }); }
  }
  const videoPath = path.join(outputDir, `${job.id}.mp4`);
  try {
    await reporter.progress('render', 0, 100, '正在渲染 MP4 视频');
    let lastReport = 0;
    let lastPhase: RenderProgress['phase'] | undefined;
    let pending = Promise.resolve();
    await services.renderVideo(plan, snapshot.assets, videoPath, signal, (fraction, detail) => {
      const phaseChanged = detail !== undefined && detail.phase !== lastPhase;
      if (Date.now() - lastReport < 1000 && fraction < 1 && !phaseChanged) return;
      lastReport = Date.now();
      if (detail) lastPhase = detail.phase;
      const message = phaseChanged ? renderPhaseLabels[detail!.phase] : undefined;
      // Keep the weighted Remotion percentage for older clients; completion also requires publishing the files.
      pending = pending.then(() => reporter.progress('render', Math.min(99, Math.floor(fraction * 100)), 100, message, detail)).catch(() => {});
    });
    await pending;
    signal.throwIfAborted();
    const video = await services.publishFile(videoPath, 'video/mp4', `${lesson.title}.mp4`, snapshot.id);
    const subtitle = await services.publishFile(subtitlePath, 'application/x-subrip; charset=utf-8', `${lesson.title}.srt`, snapshot.id);
    signal.throwIfAborted();
    await reporter.progress('render', 100, 100, '视频与字幕已生成');
    return { lesson, renderPlan: plan, videoUrl: video.url, subtitleUrl: subtitle.url };
  } finally { await Promise.all([rm(videoPath, { force: true }), rm(subtitlePath, { force: true })]); }
}

export function validateExportPlan(plan: RenderPlan, lesson: Lesson, voice: string, rate: number): void {
  if (plan.previewMode === 'draft' || plan.previewMode === 'partial') throw new Error('分镜或部分配音预览不能导出，请先完成全部配音');
  if (plan.voice !== undefined && plan.voice !== voice || plan.rate !== undefined && plan.rate !== rate) throw new Error('配音设置已变化，请重新生成配音后导出');
  if (JSON.stringify(plan.scenes.map(s => s.scene)) !== JSON.stringify(lesson.scenes)) throw new Error('配音预览不属于当前分镜，请重新生成配音');
  if (plan.scenes.some(scene => scene.utterances.length !== scene.scene.narration.length || scene.utterances.some(clip => clip.estimated || !clip.url || !Number.isFinite(clip.durationSeconds) || clip.durationSeconds <= 0))) throw new Error('预览仍有未完成配音，不能导出');
  if (plan.narrationAudio && (!plan.narrationAudio.url || !Number.isFinite(plan.narrationAudio.durationSeconds) || Math.abs(plan.narrationAudio.durationSeconds - plan.totalFrames / plan.fps) > 0.05)) throw new Error('连续音轨与视频时间轴不一致，请重新生成配音');
}

export function directorCacheKey(job: Pick<JobRecord, 'kind' | 'snapshot' | 'sceneId' | 'instruction'>): string {
  const { markdown, settings, assets, lesson } = job.snapshot;
  return createHash('sha256').update(JSON.stringify({ version: 'codex-director-video-intent-v6', owner: job.snapshot.id, title: job.snapshot.title, sourceMode: job.snapshot.sourceMode || 'legacy', chapterSourceKey: job.snapshot.chapterSourceKey, chapters: job.snapshot.sourceMode === 'chapters' ? job.snapshot.chapters : undefined, model: settings.model || process.env.CODEX_MODEL || 'configured', markdown, settings: { ...videoDirection(settings), language: settings.language, audience: settings.audience, mode: settings.mode, creationMode: settings.creationMode, stylePrompt: settings.stylePrompt, theme: settings.theme }, assets: assets.map(({ id, name, hash, mime }) => ({ id, name, hash, mime })), ...(job.kind === 'regenerate' ? { kind: 'regenerate', lesson, sceneId: job.sceneId, instruction: job.instruction } : { kind: 'generate' }) })).digest('hex');
}
