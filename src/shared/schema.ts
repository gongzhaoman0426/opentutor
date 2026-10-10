import { z } from 'zod';
import { isNormalizedBox } from './images';
import { validateCustomCode } from './custom';
import { videoIntentIds } from './video-intent';
import type { RenderProgress } from './render-progress';

export const PaletteSchema = z.object({ background: z.string().regex(/^#[a-fA-F0-9]{6}$/), surface: z.string().regex(/^#[a-fA-F0-9]{6}$/), text: z.string().regex(/^#[a-fA-F0-9]{6}$/), muted: z.string().regex(/^#[a-fA-F0-9]{6}$/), accent: z.string().regex(/^#[a-fA-F0-9]{6}$/) }).strict();
export type Palette = z.infer<typeof PaletteSchema>;

export const SettingsSchema = z.object({
  language: z.enum(['zh-CN', 'en-US']).default('zh-CN'),
  audience: z.string().min(1).max(200).default('普通观众'),
  mode: z.enum(['full', 'summary']).default('full'),
  voice: z.string().regex(/^[a-z]{2,3}-[A-Z]{2}-[A-Za-z0-9]+Neural$/).default('zh-CN-XiaoxiaoNeural'),
  rate: z.number().int().min(-50).max(100).default(0),
  theme: z.enum(['sage', 'ink', 'ocean', 'sunset']).default('sage'),
  resolution: z.enum(['720p', '1080p']).default('720p'),
  model: z.string().max(120).regex(/^[A-Za-z0-9_.:/-]*$/).default(''),
  creationMode: z.enum(['stable', 'creative']).default('stable'),
  stylePrompt: z.string().max(2000).default(''),
  videoIntent: z.enum(videoIntentIds).default('auto'),
  creativeBrief: z.string().max(2000).default(''),
});
export type GenerationSettings = z.infer<typeof SettingsSchema>;
export const defaultSettings = SettingsSchema.parse({});

export const AssetSchema = z.object({ id: z.string().uuid(), name: z.string().max(200), mime: z.enum(['image/png', 'image/jpeg', 'image/webp']), url: z.string(), hash: z.string(), width: z.number().int().positive().optional(), height: z.number().int().positive().optional() });
export type Asset = z.infer<typeof AssetSchema>;
export const ChapterSchema = z.object({ id: z.string().min(1).max(80), title: z.string().min(1).max(120), markdown: z.string().max(300000), settings: SettingsSchema.optional() });
export type Chapter = z.infer<typeof ChapterSchema>;
const ChaptersSchema = z.array(ChapterSchema).min(1).max(200).refine(chapters => new Set(chapters.map(c => c.id)).size === chapters.length, '章节 ID 不能重复').refine(chapters => chapters.reduce((length, c) => length + c.markdown.length, 0) <= 300000, '项目素材超过 300,000 字符');
export const NormalizedBoxSchema = z.object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1), width: z.number().positive().max(1), height: z.number().positive().max(1) }).strict();
export type NormalizedBox = z.infer<typeof NormalizedBoxSchema>;
export const ImagePresentationSchema = z.object({ fit: z.literal('contain'), caption: z.string().max(300), region: NormalizedBoxSchema.nullable(), highlight: NormalizedBoxSchema.nullable() }).strict();
export type ImagePresentation = z.infer<typeof ImagePresentationSchema>;

export const ObjectSchema = z.object({
  id: z.string().min(1).max(80), type: z.enum(['text', 'code', 'formula', 'table', 'image', 'diagram', 'custom']),
  content: z.string().max(12000), language: z.string().max(40), imagePresentation: ImagePresentationSchema.nullable().optional(),
}).strict();
export const UtteranceSchema = z.object({
  id: z.string().min(1).max(80), text: z.string().min(1).max(2000),
  showObjectIds: z.array(z.string()).max(8), focusObjectId: z.string().max(80),
}).strict();
export const SceneSchema = z.object({
  id: z.string().min(1).max(80), title: z.string().min(1).max(120), chapter: z.string().max(120), chapterId: z.string().max(80).optional(),
  layout: z.enum(['title', 'content', 'compare', 'code', 'diagram', 'summary']),
  sourceBlockIds: z.array(z.string()).min(1),
  objects: z.array(ObjectSchema).min(1).max(8), narration: z.array(UtteranceSchema).min(1).max(16),
}).strict();
export const LessonSchema = z.object({
  schemaVersion: z.literal('0.1'), title: z.string().min(1).max(120),
  objectives: z.array(z.string().max(300)).min(1).max(20), scenes: z.array(SceneSchema).min(1).max(500), palette: PaletteSchema.optional(),
}).strict();
export type Lesson = z.infer<typeof LessonSchema>;
export type Scene = z.infer<typeof SceneSchema>;
export type TeachingObject = z.infer<typeof ObjectSchema>;
export type Utterance = z.infer<typeof UtteranceSchema>;

export interface SourceBlock { id: string; type: string; text: string; markdown: string; start: number; end: number; chapter: string; chapterId?: string }
export interface ImageOccurrence { id: string; assetId: string; sourceBlockId: string; chapterId: string; alt: string; caption: string; start?: number; end?: number }
export interface SourceChapter extends Chapter { blockIds: string[] }
export interface SourceDocument { title: string; hash: string; blocks: SourceBlock[]; diagnostics: Diagnostic[]; chapters?: SourceChapter[]; imageOccurrences?: ImageOccurrence[] }
export interface Diagnostic { code: string; severity: 'info' | 'warning' | 'error'; message: string; sceneId?: string; sourceBlockId?: string }
export interface Boundary { kind: 'word' | 'sentence' | 'utterance'; text: string; startSeconds: number; endSeconds: number }
export interface SpeechResult { url: string; durationSeconds: number; boundaries: Boundary[]; cacheHit: boolean; hash: string }
export interface RenderUtterance extends SpeechResult { utteranceId: string; startFrame: number; durationFrames: number; estimated?: boolean }
export interface RenderScene { scene: Scene; startFrame: number; durationFrames: number; utterances: RenderUtterance[] }
export interface NarrationAudio { url: string; durationSeconds: number }
export interface RenderPlan { schemaVersion: '0.1'; revision: number; title: string; fps: number; width: number; height: number; theme: GenerationSettings['theme']; totalFrames: number; scenes: RenderScene[]; previewMode?: 'draft' | 'partial' | 'aligned'; voice?: string; rate?: number; narrationAudio?: NarrationAudio; palette?: Palette }
export type JobStatus = 'queued' | 'running' | 'cancelling' | 'cancelled' | 'succeeded' | 'failed';
export type JobKind = 'preview' | 'compose' | 'speech' | 'generate' | 'rebuild' | 'export' | 'regenerate';
export interface JobPreview { lesson: Lesson; renderPlan: RenderPlan | null; updatedAt: string }
export interface ProjectSnapshot { id: string; title: string; markdown: string; chapters?: Chapter[]; context?: Chapter[]; chapterSourceKey?: string; sourceMode?: 'legacy' | 'chapters'; settings: GenerationSettings; assets: Asset[]; revision: number; lesson: Lesson | null; renderPlan?: RenderPlan | null; previewRevision?: number | null; previewAssets?: Asset[] }
export interface JobRecord { id: string; projectId: string; chapterId?: string | null; kind: JobKind; status: JobStatus; stage: string; completed: number; total: number; inputRevision: number; outputRevision: number | null; error: string | null; diagnostics: Diagnostic[]; videoUrl: string | null; subtitleUrl: string | null; createdAt: string; updatedAt: string; snapshot: ProjectSnapshot; sceneId: string | null; instruction: string | null; preview?: JobPreview | null; renderProgress?: RenderProgress }
export interface ProjectExport { jobId: string; revision: number; videoUrl: string; subtitleUrl?: string | null }
export interface ChapterVideo { chapterId: string; sourceKey: string; settings: GenerationSettings; lesson: Lesson; renderPlan: RenderPlan | null; previewAssets: Asset[]; previewRevision: number; latestExport: ProjectExport | null; updatedAt: string; current?: boolean }
export interface Project extends ProjectSnapshot { renderPlan: RenderPlan | null; previewRevision: number | null; latestJob: JobRecord | null; latestExport?: ProjectExport | null; chapterVideos?: Record<string, ChapterVideo>; chapterJobs?: Record<string, JobRecord>; createdAt: string; updatedAt: string }
export interface JobEvent { id: number; jobId: string; stage: string; message: string; createdAt: string }

export const CreateProjectSchema = z.object({ title: z.string().min(1).max(120), markdown: z.string().max(300000).default(''), chapters: ChaptersSchema.optional(), settings: SettingsSchema.default(defaultSettings), assets: z.array(AssetSchema).max(50).default([]) });
export const UpdateProjectSchema = z.object({ expectedRevision: z.number().int().positive(), title: z.string().min(1).max(120), markdown: z.string().max(300000).default(''), chapters: ChaptersSchema.optional(), settings: SettingsSchema, assets: z.array(AssetSchema).max(50), lesson: LessonSchema.nullable() });
export const SubmitJobSchema = z.object({ kind: z.enum(['preview', 'compose', 'speech', 'generate', 'rebuild', 'export', 'regenerate']), expectedRevision: z.number().int().positive(), chapterId: z.string().min(1).max(80).optional(), sceneId: z.string().optional(), instruction: z.string().max(2000).optional() });

export function validateLesson(lesson: Lesson, source: SourceDocument, assets: Asset[], mode: 'full' | 'summary', creationMode: GenerationSettings['creationMode'] = 'stable'): Diagnostic[] {
  const issues: Diagnostic[] = [];
  const blockIds = new Set(source.blocks.map(b => b.id));
  const covered = new Set<string>();
  const sceneIds = new Set<string>();
  for (const scene of lesson.scenes) {
    if (sceneIds.has(scene.id)) issues.push({ code: 'DUPLICATE_SCENE', severity: 'error', sceneId: scene.id, message: '场景 ID 重复' });
    sceneIds.add(scene.id);
    const ids = new Set(scene.objects.map(o => o.id));
    if (ids.size !== scene.objects.length) issues.push({ code: 'DUPLICATE_OBJECT', severity: 'error', sceneId: scene.id, message: '画面对象 ID 重复' });
    const utteranceIds = new Set(scene.narration.map(u => u.id));
    if (utteranceIds.size !== scene.narration.length) issues.push({ code: 'DUPLICATE_UTTERANCE', severity: 'error', sceneId: scene.id, message: '旁白 ID 重复' });
    for (const id of scene.sourceBlockIds) {
      if (!blockIds.has(id)) issues.push({ code: 'UNKNOWN_SOURCE', severity: 'error', sceneId: scene.id, message: `来源不存在：${id}` });
      else covered.add(id);
    }
    for (const u of scene.narration) {
      for (const id of [...u.showObjectIds, ...(u.focusObjectId ? [u.focusObjectId] : [])]) {
        if (!ids.has(id)) issues.push({ code: 'UNKNOWN_TARGET', severity: 'error', sceneId: scene.id, message: `动画目标不存在：${id}` });
      }
    }
    const shown = new Set(scene.narration.flatMap(u => u.showObjectIds));
    for (const o of scene.objects) {
      if (o.type === 'custom') {
        const codeError = validateCustomCode(o.content);
        if (creationMode !== 'creative') issues.push({ code: 'CUSTOM_MODE', severity: 'error', sceneId: scene.id, message: '稳定模式不能执行自定义代码，请选择创意模式或重新生成模板画面。' });
        if (codeError) issues.push({ code: 'INVALID_CUSTOM_CODE', severity: 'error', sceneId: scene.id, message: codeError });
      } else if (o.content.length > 6000) issues.push({ code: 'CONTENT_TOO_LONG', severity: 'error', sceneId: scene.id, message: '模板对象内容最多 6,000 字符。' });
      if (!shown.has(o.id)) issues.push({ code: 'HIDDEN_OBJECT', severity: 'error', sceneId: scene.id, message: `对象未在旁白对应画面中显示：${o.id}` });
      if (o.type === 'image' && !assets.some(a => a.id === o.content)) issues.push({ code: 'MISSING_ASSET', severity: 'error', sceneId: scene.id, message: '图片必须引用已上传素材 ID' });
      if (o.type === 'image' && [o.imagePresentation?.region, o.imagePresentation?.highlight].some(box => box && !isNormalizedBox(box))) issues.push({ code: 'INVALID_IMAGE_REGION', severity: 'error', sceneId: scene.id, message: '图片裁剪或高亮区域必须位于原图范围内；无法确定时展示完整图片。' });
      if (o.type === 'diagram') issues.push({ code: 'DIAGRAM_FALLBACK', severity: 'warning', sceneId: scene.id, message: '图解采用文本或 Markdown 分步表达；未执行专用图形仿真' });
    }
    const estimatedHeights = scene.objects.map(o => {
      const columns = scene.layout === 'compare' ? 20 : 42;
      const units = (text: string) => [...text].reduce((sum, ch) => sum + (/[^\x00-\x7F]/.test(ch) ? 1 : 0.55), 0);
      if (o.type === 'image' || o.type === 'custom') return 326;
      if (o.type === 'formula') return 96;
      const lines = o.content.split('\n').reduce((sum, line) => sum + Math.max(1, Math.ceil(units(line) / columns)), 0);
      return 36 + lines * (o.type === 'code' ? 34 : 39);
    });
    const estimatedHeight = scene.layout === 'compare'
      ? estimatedHeights.reduce((sum, height, i) => sum + (i % 2 === 0 ? Math.max(height, estimatedHeights[i + 1] ?? 0) + 16 : 0), 0)
      : estimatedHeights.reduce((sum, height) => sum + height + 16, 0);
    if (estimatedHeight > 360) issues.push({ code: 'CONTENT_TOO_DENSE', severity: 'error', sceneId: scene.id, message: `画面内容预计超过可读高度（${Math.round(estimatedHeight)}px）。请拆成更多场景并保留内容和来源，不能缩小字体或删内容。` });
    if ([...scene.title].reduce((sum, ch) => sum + (/[^\x00-\x7F]/.test(ch) ? 1 : 0.55), 0) > 48) issues.push({ code: 'TITLE_TOO_LONG', severity: 'error', sceneId: scene.id, message: '标题过长，请缩短画面标题，把必要说明保留在正文或旁白。' });
  }
  for (const occurrence of source.imageOccurrences ?? []) {
    const used = lesson.scenes.some(scene => scene.sourceBlockIds.includes(occurrence.sourceBlockId) && scene.objects.some(object => object.type === 'image' && object.content === occurrence.assetId && scene.narration.some(utterance => utterance.text.trim() && utterance.showObjectIds.includes(object.id))));
    if (!used) issues.push({ code: 'UNUSED_SOURCE_IMAGE', severity: 'error', sourceBlockId: occurrence.sourceBlockId, message: `素材引用的图片「${occurrence.alt || occurrence.assetId}」未在对应内容中显示，请安排图片和旁白，不可静默丢弃。` });
  }
  if (mode === 'full') for (const b of source.blocks) if (!covered.has(b.id)) issues.push({ code: 'UNCOVERED_SOURCE', severity: 'error', sourceBlockId: b.id, message: `完整内容缺少来源块：${b.id}` });
  issues.push({ code: 'SUBJECT_REVIEW', severity: 'warning', message: '已检查结构、来源覆盖与画面引用；事实陈述和新增表达仍需作者复核。' });
  return issues;
}
