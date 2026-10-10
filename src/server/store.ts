import { createHash, randomUUID } from 'node:crypto';
import { stat, readFile } from 'node:fs/promises';
import sharp from 'sharp';
import type { PoolClient } from 'pg';
import { CreateProjectSchema, UpdateProjectSchema, SubmitJobSchema, LessonSchema, SceneSchema, SettingsSchema, type Diagnostic, type JobRecord, type JobEvent, type Lesson, type Project, type RenderPlan, type Asset, type GenerationSettings, type JobPreview, type Chapter, type ProjectSnapshot, type ProjectExport, type ChapterVideo } from '../shared/schema';
import type { RenderProgress } from '../shared/render-progress';
import { createEmptyChapter, getProjectChapters, getChapterSourceKey, isChapterVideoCurrent, joinChapterMarkdown, splitMarkdownChapters } from '../shared/chapters';
import { validateCustomCode } from '../shared/custom';
import { getPool, initDb, withTransaction, closeDb } from './db';
import { getQueue } from './queue';
import { AppError, notFound } from './errors';

export { initDb, closeDb };
export interface ClaimedJob extends JobRecord { leaseToken: string }
export const validId = (id: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id);
function checkId(id: string) { if (!validId(id)) notFound(); }
const now = () => new Date().toISOString();
const terminal = (s: JobRecord['status']) => ['succeeded', 'failed', 'cancelled'].includes(s);
function sourceSnapshot<T extends ProjectSnapshot>(project: T): T & { chapters: Chapter[]; sourceMode: 'legacy' | 'chapters' } {
  const normalizeChapter = (chapter: Chapter): Chapter => ({ ...chapter, ...(chapter.settings ? { settings: SettingsSchema.parse(chapter.settings) } : {}) });
  return { ...project, settings: SettingsSchema.parse(project.settings), chapters: getProjectChapters(project).map(normalizeChapter), ...(project.context ? { context: project.context.map(normalizeChapter) } : {}), sourceMode: project.sourceMode ?? 'legacy' };
}
function normalizedJob(job: JobRecord): JobRecord { return { ...job, snapshot: sourceSnapshot(job.snapshot) }; }
function chapterIdentity(chapters: Chapter[]) { return JSON.stringify(chapters.map(c => [c.id, c.title, c.markdown, c.settings ? SettingsSchema.parse(c.settings) : null])); }
function assertCustomLesson(lesson: Lesson | null | undefined, settings: GenerationSettings) {
  for (const scene of lesson?.scenes || []) for (const object of scene.objects) if (object.type === 'custom') {
    if (settings.creationMode !== 'creative') throw new AppError(422, 'CUSTOM_MODE', '稳定模式不能执行自定义代码，请切换创意模式或重新生成');
    const error = validateCustomCode(object.content);
    if (error) throw new AppError(422, 'INVALID_CUSTOM_CODE', error);
  }
}
function chapterMarkdown(chapters: Chapter[]) {
  const markdown = joinChapterMarkdown(chapters);
  if (markdown.length > 300000) throw new AppError(422, 'SOURCE_TOO_LARGE', '项目文稿超过 300,000 字符，请缩短章节内容');
  return markdown;
}
async function event(c: PoolClient, job: JobRecord, message: string) {
  await c.query('INSERT INTO job_events(job_id,stage,message) VALUES($1,$2,$3)', [job.id, job.stage, message]);
}
async function saveJob(c: PoolClient, job: JobRecord) {
  job.updatedAt = now();
  await c.query('UPDATE jobs SET data=$2 WHERE id=$1', [job.id, JSON.stringify(job)]);
}
async function lockedProject(c: PoolClient, id: string): Promise<Project> {
  const result = await c.query('SELECT data FROM projects WHERE id=$1 FOR UPDATE', [id]);
  if (!result.rowCount) notFound('项目不存在');
  return sourceSnapshot(result.rows[0].data as Project);
}
async function lockedJob(c: PoolClient, id: string, leaseToken?: string): Promise<JobRecord> {
  const result = await c.query('SELECT data,lease_token FROM jobs WHERE id=$1 FOR UPDATE', [id]);
  if (!result.rowCount) notFound('任务不存在');
  if (leaseToken && result.rows[0].lease_token !== leaseToken) throw new AppError(409, 'STALE_WORKER', '任务已经由其他 Worker 接管');
  return normalizedJob(result.rows[0].data as JobRecord);
}
async function assertAssets(c: PoolClient, assets: Asset[]): Promise<Asset[]> {
  const verified: Asset[] = [];
  for (const asset of assets) {
    const result = await c.query('SELECT mime,path FROM artifacts WHERE id=$1', [asset.id]);
    if (!result.rowCount || result.rows[0].mime !== asset.mime || asset.url !== `/api/artifacts/${asset.id}`) {
      throw new AppError(422, 'INVALID_ASSET', '项目图片必须使用已上传的素材');
    }
    const file = await stat(/* turbopackIgnore: true */ result.rows[0].path).catch(() => null);
    if (!file?.isFile() || file.size < 1 || file.size > 15 * 1024 * 1024) throw new AppError(422, 'INVALID_ASSET', '已上传图片无法读取，请重新上传');
    const bytes = await readFile(/* turbopackIgnore: true */ result.rows[0].path);
    const metadata = await sharp(bytes, { limitInputPixels: 40000000, animated: false }).metadata().catch(() => { throw new AppError(422, 'INVALID_ASSET', '已上传图片无法解码，请重新上传'); });
    const expectedMime = metadata.format === 'jpeg' ? 'image/jpeg' : metadata.format === 'png' ? 'image/png' : metadata.format === 'webp' ? 'image/webp' : null;
    if (expectedMime !== asset.mime || !metadata.width || !metadata.height || (metadata.pages ?? 1) > 1) throw new AppError(422, 'INVALID_ASSET', '已上传图片格式无效，请重新上传');
    const rotated = metadata.orientation && metadata.orientation >= 5;
    verified.push({ ...asset, hash: createHash('sha256').update(bytes).digest('hex'), width: rotated ? metadata.height : metadata.width, height: rotated ? metadata.width : metadata.height });
  }
  return verified;
}
async function assertNarrationAudio(c: PoolClient, projectId: string, plan: RenderPlan) {
  const audio = plan.narrationAudio;
  if (audio === undefined) return; // Saved plans before the master-track feature remain valid.
  const invalid = () => { throw new AppError(422, 'INVALID_NARRATION_AUDIO', '整课音轨无效或时长与当前时间轴不匹配，请重新合成配音'); };
  const match = audio && typeof audio.url === 'string' && /^\/api\/artifacts\/([a-f0-9-]{36})$/.exec(audio.url);
  if (!match || !validId(match[1]) || !Number.isFinite(audio.durationSeconds) || audio.durationSeconds <= 0 || !Number.isInteger(plan.fps) || plan.fps < 1 || !Number.isInteger(plan.totalFrames) || plan.totalFrames < 1 || plan.previewMode === 'draft' || plan.previewMode === 'partial') invalid();
  // One video frame or 50 ms allows codec-frame rounding, while rejecting
  // a truncated, stale, or otherwise mismatched whole-lesson track.
  const tolerance = Math.max(1 / plan.fps, 0.05);
  if (Math.abs(audio!.durationSeconds - plan.totalFrames / plan.fps) > tolerance + Number.EPSILON) invalid();
  const result = await c.query('SELECT mime,project_id,path FROM artifacts WHERE id=$1', [(match as RegExpExecArray)[1]]);
  const artifact = result.rows[0];
  if (!artifact || artifact.project_id !== projectId || !String(artifact.mime).startsWith('audio/')) invalid();
  const file = await stat(/* turbopackIgnore: true */ artifact.path).catch(() => null);
  if (!file?.isFile() || file.size < 1) invalid();
}
async function assertResultArtifact(c: PoolClient, projectId: string, url: string | undefined, kind: 'video' | 'subtitles') {
  if (!url) return;
  const match = /^\/api\/artifacts\/([a-f0-9-]{36})$/.exec(url);
  if (!match || !validId(match[1])) throw new AppError(422, 'INVALID_RESULT_ARTIFACT', '生成结果必须使用本项目已注册的文件');
  const result = await c.query('SELECT mime,project_id,path FROM artifacts WHERE id=$1', [match[1]]);
  const row = result.rows[0];
  const file = row ? await stat(/* turbopackIgnore: true */ row.path).catch(() => null) : null;
  if (!row || row.project_id !== projectId || (kind === 'video' ? row.mime !== 'video/mp4' : !String(row.mime).startsWith('application/x-subrip')) || !file?.isFile() || !file.size) throw new AppError(422, 'INVALID_RESULT_ARTIFACT', '生成结果文件缺失、格式不符或不属于本项目');
}
async function assertAlignedPlan(c: PoolClient, projectId: string, plan: RenderPlan | null | undefined, lesson: Lesson, settings: GenerationSettings, strictParameters = false) {
  assertCustomLesson(lesson, settings);
  const invalid = () => { throw new AppError(422, 'UNALIGNED_PREVIEW', '请先完成当前项目的真实配音与时间轴，再导出视频'); };
  if (!plan || (plan.previewMode !== undefined && plan.previewMode !== 'aligned') || !Number.isInteger(plan.fps) || plan.fps < 1 || !Number.isInteger(plan.totalFrames) || plan.totalFrames < 1 || !Array.isArray(plan.scenes) || plan.scenes.length !== lesson.scenes.length || (plan.voice !== undefined && plan.voice !== settings.voice) || (plan.rate !== undefined && plan.rate !== settings.rate)) invalid();
  const palette = (value: Lesson['palette']) => value ? [value.background, value.surface, value.text, value.muted, value.accent].map(color => color.toLowerCase()) : null;
  if (plan!.theme !== settings.theme || plan!.width !== (settings.resolution === '1080p' ? 1920 : 1280) || plan!.height !== (settings.resolution === '1080p' ? 1080 : 720) || JSON.stringify(palette(plan!.palette)) !== JSON.stringify(palette(lesson.palette)) || (strictParameters && (plan!.voice !== settings.voice || plan!.rate !== settings.rate))) invalid();
  const audioIds = new Set<string>();
  for (const [index, scene] of plan!.scenes.entries()) {
    const expected = lesson.scenes[index];
    if (!expected || JSON.stringify(SceneSchema.parse(scene.scene)) !== JSON.stringify(SceneSchema.parse(expected)) || !Number.isInteger(scene.startFrame) || scene.startFrame < 0 || !Number.isInteger(scene.durationFrames) || scene.durationFrames < 1 || scene.startFrame + scene.durationFrames > plan!.totalFrames || scene.utterances.length !== expected.narration.length) invalid();
    for (const [utteranceIndex, audio] of scene.utterances.entries()) {
      const match = typeof audio.url === 'string' && /^\/api\/artifacts\/([a-f0-9-]{36})$/.exec(audio.url);
      if (!match || !validId(match[1]) || audio.estimated || audio.utteranceId !== expected.narration[utteranceIndex].id || !Number.isFinite(audio.durationSeconds) || audio.durationSeconds <= 0 || !Number.isInteger(audio.startFrame) || audio.startFrame < 0 || !Number.isInteger(audio.durationFrames) || audio.durationFrames < 1 || audio.startFrame + audio.durationFrames > scene.durationFrames) invalid();
      audioIds.add((match as RegExpExecArray)[1]);
    }
  }
  const registered = await c.query('SELECT id,mime,project_id FROM artifacts WHERE id=ANY($1::uuid[])', [[...audioIds]]);
  if (registered.rows.length !== audioIds.size || registered.rows.some(row => !String(row.mime).startsWith('audio/') || row.project_id !== projectId)) invalid();
  await assertNarrationAudio(c, projectId, plan!);
}
async function hydrate(project: Project): Promise<Project> {
  const [result, latestExport, jobs] = await Promise.all([
    getPool().query('SELECT data FROM jobs WHERE project_id=$1 ORDER BY created_at DESC LIMIT 1', [project.id]),
    getCurrentExport(project.id, project.revision),
    getPool().query("SELECT DISTINCT ON (data->>'chapterId') data FROM jobs WHERE project_id=$1 AND data->>'chapterId' IS NOT NULL ORDER BY data->>'chapterId',created_at DESC", [project.id]),
  ]);
  const normalized = sourceSnapshot(project);
  const chapterVideos = Object.fromEntries(await Promise.all(Object.entries(project.chapterVideos || {}).map(async ([id, video]) => {
    const current = isChapterVideoCurrent(normalized, id);
    const latestExport = current && await validChapterExport(project.id, video) ? video.latestExport : null;
    return [id, { ...video, settings: SettingsSchema.parse(video.settings), current, latestExport }];
  })));
  const chapterJobs = Object.fromEntries(jobs.rows.map(row => { const job = normalizedJob(row.data as JobRecord); return [job.chapterId!, job]; }));
  return { ...normalized, latestJob: result.rows[0]?.data ? normalizedJob(result.rows[0].data as JobRecord) : null, latestExport, chapterVideos, chapterJobs };
}
async function validChapterExport(projectId: string, video: ChapterVideo): Promise<boolean> {
  const exported = video.latestExport;
  const match = exported && /^\/api\/artifacts\/([a-f0-9-]{36})$/.exec(exported.videoUrl);
  if (!exported || exported.revision !== video.previewRevision || !match || !validId(match[1]) || !validId(exported.jobId)) return false;
  const result = await getPool().query("SELECT a.path FROM artifacts a JOIN jobs j ON j.id=$2 WHERE a.id=$1 AND a.project_id=$3 AND a.mime='video/mp4' AND j.project_id=$3 AND j.data->>'status'='succeeded' AND j.data->>'chapterId'=$4 AND (j.data->>'outputRevision')::integer=$5 AND j.data->>'videoUrl'=$6 AND j.data#>>'{snapshot,chapterSourceKey}'=$7", [match[1], exported.jobId, projectId, video.chapterId, exported.revision, exported.videoUrl, video.sourceKey]);
  const file = result.rows[0] ? await stat(/* turbopackIgnore: true */ result.rows[0].path).catch(() => null) : null;
  return !!file?.isFile() && file.size > 0;
}
export async function listProjects() {
  await initDb();
  const result = await getPool().query('SELECT data FROM projects ORDER BY updated_at DESC');
  return Promise.all(result.rows.map(r => hydrate(r.data as Project)));
}
export async function getProject(id: string): Promise<Project> {
  checkId(id); await initDb();
  const result = await getPool().query('SELECT data FROM projects WHERE id=$1', [id]);
  if (!result.rowCount) notFound('项目不存在');
  return hydrate(result.rows[0].data as Project);
}
export async function createProject(value: unknown): Promise<Project> {
  const input = CreateProjectSchema.parse(value); await initDb();
  const legacy = input.chapters === undefined && typeof value === 'object' && value !== null && Object.prototype.hasOwnProperty.call(value, 'markdown');
  const chapters = input.chapters ?? (legacy ? splitMarkdownChapters(input.markdown) : [createEmptyChapter('第 1 章')]);
  const markdown = input.chapters ? chapterMarkdown(chapters) : input.markdown;
  const timestamp = now();
  const project: Project = { ...input, markdown, chapters, sourceMode: legacy ? 'legacy' : 'chapters', id: randomUUID(), revision: 1, lesson: null, renderPlan: null, previewRevision: null, previewAssets: [], latestJob: null, latestExport: null, createdAt: timestamp, updatedAt: timestamp };
  await withTransaction(async c => {
    project.assets = await assertAssets(c, input.assets);
    await c.query('INSERT INTO projects(id,data) VALUES($1,$2)', [project.id, JSON.stringify(project)]);
    await c.query('INSERT INTO project_revisions(project_id,revision,data) VALUES($1,$2,$3)', [project.id, project.revision, JSON.stringify(project)]);
  });
  return project;
}
export async function updateProject(id: string, value: unknown): Promise<Project> {
  checkId(id); const input = UpdateProjectSchema.parse(value); await initDb();
  const project = await withTransaction(async c => {
    const old = await lockedProject(c, id);
    if (old.revision !== input.expectedRevision) throw new AppError(409, 'REVISION_CONFLICT', '项目已更新，请刷新后重试，避免覆盖新内容');
    const assets = await assertAssets(c, input.assets);
    const chapters = input.chapters ?? splitMarkdownChapters(input.markdown);
    const markdown = input.chapters ? chapterMarkdown(chapters) : input.markdown;
    const sourceMode = input.chapters ? 'chapters' : 'legacy';
    const changedSource = old.markdown !== markdown || old.sourceMode !== sourceMode || (input.chapters !== undefined && chapterIdentity(getProjectChapters(old)) !== chapterIdentity(chapters));
    const lesson = changedSource ? null : input.lesson;
    assertCustomLesson(lesson, input.settings);
    const updated: Project = { ...old, title: input.title, markdown, chapters, sourceMode, settings: input.settings, assets, lesson, revision: old.revision + 1, latestJob: null, latestExport: null, updatedAt: now() };
    await c.query('UPDATE projects SET data=$2,updated_at=now() WHERE id=$1', [id, JSON.stringify(updated)]);
    await c.query('INSERT INTO project_revisions(project_id,revision,data) VALUES($1,$2,$3)', [id, updated.revision, JSON.stringify(updated)]);
    return updated;
  });
  return hydrate(project);
}
export async function deleteProject(id: string) {
  checkId(id); await initDb();
  await withTransaction(async c => {
    await lockedProject(c, id);
    const busy = await c.query("SELECT id FROM jobs WHERE project_id=$1 AND data->>'status' IN ('running','cancelling')", [id]);
    if (busy.rowCount) throw new AppError(409, 'PROJECT_BUSY', '请先取消正在运行的任务，再删除项目');
    await c.query('DELETE FROM projects WHERE id=$1', [id]);
  });
}
export async function submitJob(projectId: string, value: unknown, idempotencyKey?: string): Promise<JobRecord> {
  checkId(projectId); const input = SubmitJobSchema.parse(value); await initDb();
  if (idempotencyKey && (idempotencyKey.length > 200 || !/^[\x21-\x7e]+$/.test(idempotencyKey))) throw new AppError(400, 'INVALID_IDEMPOTENCY_KEY', '幂等键必须是 1–200 个可打印 ASCII 字符');
  const requestHash = createHash('sha256').update(JSON.stringify(input)).digest('hex');
  const job = await withTransaction(async c => {
    const project = await lockedProject(c, projectId);
    if (idempotencyKey) {
      const existing = await c.query('SELECT k.request_hash,j.data FROM idempotency_keys k JOIN jobs j ON j.id=k.job_id WHERE k.project_id=$1 AND k.key=$2', [projectId, idempotencyKey]);
      if (existing.rowCount) {
        if (existing.rows[0].request_hash !== requestHash) throw new AppError(409, 'IDEMPOTENCY_CONFLICT', '同一幂等键不能用于不同任务');
        return normalizedJob(existing.rows[0].data as JobRecord);
      }
    }
    if (project.revision !== input.expectedRevision) throw new AppError(409, 'REVISION_CONFLICT', '请保存并刷新项目后再生成');
    project.assets = await assertAssets(c, project.assets);
    const chapter = input.chapterId ? getProjectChapters(project).find(ch => ch.id === input.chapterId) : null;
    if (input.chapterId && !chapter) notFound('章节不存在或已删除');
    const chapterVideo = chapter ? project.chapterVideos?.[chapter.id] : null;
    const chapterSourceKey = chapter ? getChapterSourceKey(project, chapter) : undefined;
    const settings = SettingsSchema.parse(chapter?.settings ?? project.settings);
    const lesson = chapter ? chapterVideo?.lesson ?? null : project.lesson;
    const renderPlan = chapter ? chapterVideo?.renderPlan ?? null : project.renderPlan;
    const previewRevision = chapter ? chapterVideo?.previewRevision ?? null : project.previewRevision;
    const markdown = chapter ? chapter.markdown : project.markdown;
    if (!markdown.trim()) throw new AppError(422, 'EMPTY_SOURCE', '文稿为空，请先在章节中添加内容');
    if (!['compose', 'preview', 'generate'].includes(input.kind) && !lesson) throw new AppError(422, 'NO_LESSON', '请先生成项目分镜');
    if (lesson && !['compose', 'preview', 'generate'].includes(input.kind)) assertCustomLesson(lesson, settings);
    if (input.kind === 'export' && (!renderPlan || (chapter ? chapterVideo?.sourceKey !== chapterSourceKey : previewRevision !== project.revision))) throw new AppError(422, 'STALE_PREVIEW', '请先重建当前章节的配音预览，再导出视频');
    if (input.kind === 'export') {
      if (renderPlan!.revision !== (chapter ? previewRevision : project.revision)) throw new AppError(422, 'STALE_PREVIEW', '配音时间轴属于旧项目版本，请重新合成');
      await assertAlignedPlan(c, projectId, renderPlan, lesson!, settings, !!chapter);
    }
    if (input.kind === 'regenerate' && (!input.sceneId || !lesson?.scenes.some(s => s.id === input.sceneId))) throw new AppError(422, 'UNKNOWN_SCENE', '需要指定当前项目中的场景');
    const active = await c.query("SELECT id FROM jobs WHERE project_id=$1 AND data->>'status' IN ('queued','running','cancelling') AND ($2::text IS NULL OR data->>'chapterId' IS NULL OR data->>'chapterId'=$2)", [projectId, chapter?.id || null]);
    if (active.rowCount) throw new AppError(409, 'JOB_ACTIVE', '项目已有任务正在执行，请等待完成或取消');
    const timestamp = now();
    const { id, title, assets, revision } = project;
    const snapshot: ProjectSnapshot = { id, title, markdown, chapters: chapter ? [chapter] : project.chapters, context: chapter ? getProjectChapters(project) : undefined, chapterSourceKey, sourceMode: chapter ? 'chapters' : project.sourceMode, settings, assets, revision: chapter && input.kind === 'export' ? previewRevision! : revision, lesson, renderPlan, previewRevision, previewAssets: chapter ? chapterVideo?.previewAssets ?? [] : project.previewAssets };
    const created: JobRecord = { id: randomUUID(), projectId, chapterId: chapter?.id || null, kind: input.kind, status: 'queued', stage: 'queued', completed: 0, total: 0, inputRevision: revision, outputRevision: null, error: null, diagnostics: [], videoUrl: null, subtitleUrl: null, createdAt: timestamp, updatedAt: timestamp, snapshot, sceneId: input.sceneId || null, instruction: input.instruction || null, preview: null };
    await c.query('INSERT INTO jobs(id,project_id,data) VALUES($1,$2,$3)', [created.id, projectId, JSON.stringify(created)]);
    await c.query('INSERT INTO job_outbox(job_id) VALUES($1)', [created.id]);
    if (idempotencyKey) await c.query('INSERT INTO idempotency_keys(project_id,key,request_hash,job_id) VALUES($1,$2,$3,$4)', [projectId, idempotencyKey, requestHash, created.id]);
    await event(c, created, '任务已保存，等待 Worker');
    return created;
  });
  // Durable outbox remains if Redis is unavailable. The Worker retries dispatch.
  if (process.env.OPENTUTOR_DISABLE_DISPATCH !== '1') void flushOutbox().catch(() => {});
  return job;
}
export async function getJob(id: string): Promise<JobRecord> {
  checkId(id); await initDb();
  const result = await getPool().query('SELECT data FROM jobs WHERE id=$1', [id]);
  if (!result.rowCount) notFound('任务不存在');
  return normalizedJob(result.rows[0].data as JobRecord);
}
export async function getJobEvents(id: string, after = 0): Promise<JobEvent[]> {
  checkId(id); await initDb();
  const result = await getPool().query('SELECT id,job_id,stage,message,created_at FROM job_events WHERE job_id=$1 AND id>$2 ORDER BY id LIMIT 1000', [id, Math.max(0, Number.isSafeInteger(after) ? after : 0)]);
  return result.rows.map(r => ({ id: Number(r.id), jobId: r.job_id, stage: r.stage, message: r.message, createdAt: new Date(r.created_at).toISOString() }));
}
export async function cancelJob(id: string) {
  checkId(id); await initDb();
  return withTransaction(async c => {
    const job = await lockedJob(c, id);
    if (terminal(job.status)) return job;
    job.status = job.status === 'queued' ? 'cancelled' : 'cancelling'; job.stage = job.status;
    await saveJob(c, job); await event(c, job, job.status === 'cancelled' ? '排队任务已取消' : '取消请求已接受，正在停止当前步骤');
    return job;
  });
}
export async function claimJob(id: string): Promise<ClaimedJob | null> {
  checkId(id); await initDb();
  return withTransaction(async c => {
    const result = await c.query('SELECT data,lease_until FROM jobs WHERE id=$1 FOR UPDATE', [id]);
    if (!result.rowCount) return null;
    const job = normalizedJob(result.rows[0].data as JobRecord);
    if (terminal(job.status)) return null;
    if (job.status === 'cancelling') {
      if (!result.rows[0].lease_until || new Date(result.rows[0].lease_until).getTime() <= Date.now()) {
        job.status = 'cancelled'; job.stage = 'cancelled'; await saveJob(c, job); await event(c, job, 'Worker 租约已结束，取消任务完成');
      }
      return null;
    }
    if (job.status === 'running' && result.rows[0].lease_until && new Date(result.rows[0].lease_until).getTime() > Date.now()) return null;
    const leaseToken = randomUUID(); job.status = 'running'; job.stage = 'starting';
    await saveJob(c, job);
    await c.query("UPDATE jobs SET lease_token=$2,lease_until=now()+interval '120 seconds' WHERE id=$1", [id, leaseToken]);
    await event(c, job, 'Worker 开始处理任务');
    return { ...job, leaseToken };
  });
}
export async function heartbeatJob(id: string, leaseToken: string) {
  const result = await getPool().query("UPDATE jobs SET lease_until=now()+interval '120 seconds' WHERE id=$1 AND lease_token=$2 AND data->>'status' IN ('running','cancelling')", [id, leaseToken]);
  return !!result.rowCount;
}
export async function updateJobProgress(id: string, stage: string, completed: number, total: number, message?: string, leaseToken?: string, renderProgress?: RenderProgress) {
  await withTransaction(async c => {
    const job = await lockedJob(c, id, leaseToken);
    if (job.status !== 'running') return;
    job.stage = stage; job.completed = Math.max(0, completed); job.total = Math.max(0, total);
    if (renderProgress) job.renderProgress = renderProgress;
    else if (stage !== 'render') delete job.renderProgress;
    await saveJob(c, job); if (message) await event(c, job, message);
  });
}
export async function addJobDiagnostic(id: string, diagnostic: Diagnostic, leaseToken?: string) {
  await withTransaction(async c => {
    const job = await lockedJob(c, id, leaseToken);
    if (job.status !== 'running') return;
    job.diagnostics.push(diagnostic); await saveJob(c, job); await event(c, job, diagnostic.message);
  });
}
export async function updateJobPreview(id: string, preview: Pick<JobPreview, 'lesson' | 'renderPlan'>, leaseToken?: string) {
  const lesson = LessonSchema.parse(preview.lesson);
  await withTransaction(async c => {
    const job = await lockedJob(c, id, leaseToken);
    if (job.status !== 'running') return;
    assertCustomLesson(lesson, job.snapshot.settings);
    if (preview.renderPlan && preview.renderPlan.revision !== job.snapshot.revision) throw new AppError(422, 'PREVIEW_REVISION_MISMATCH', '任务预览必须绑定提交时的项目版本');
    if (preview.renderPlan) await assertNarrationAudio(c, job.projectId, preview.renderPlan);
    job.preview = { lesson, renderPlan: preview.renderPlan, updatedAt: now() };
    await saveJob(c, job);
  });
}
export interface CompletedResult { lesson?: Lesson; renderPlan?: RenderPlan; videoUrl?: string; subtitleUrl?: string; diagnostics?: Diagnostic[] }
export async function completeJob(id: string, result: CompletedResult, leaseToken?: string) {
  const initial = await getJob(id);
  return withTransaction(async c => {
    const project = await lockedProject(c, initial.projectId);
    const job = await lockedJob(c, id, leaseToken);
    if (terminal(job.status)) return job;
    if (job.status === 'cancelling') {
      job.status = 'cancelled'; job.stage = 'cancelled'; await saveJob(c, job); await event(c, job, '任务已取消，未发布晚到结果'); return job;
    }
    if (job.status !== 'running') throw new AppError(409, 'JOB_NOT_RUNNING', '任务尚未领取');
    if (result.lesson) { LessonSchema.parse(result.lesson); assertCustomLesson(result.lesson, job.snapshot.settings); }
    if ([...job.diagnostics, ...(result.diagnostics || [])].some(d => d.severity === 'error')) throw new AppError(422, 'RESULT_INVALID', '生成结果含错误诊断，不能发布');
    await assertResultArtifact(c, job.projectId, result.videoUrl, 'video');
    await assertResultArtifact(c, job.projectId, result.subtitleUrl, 'subtitles');
    if (job.kind === 'speech' || job.kind === 'preview') {
      if (!result.lesson) throw new AppError(422, 'NO_LESSON', '预览结果缺少已编排的项目');
      if (job.kind === 'speech' && (!job.snapshot.lesson || JSON.stringify(LessonSchema.parse(result.lesson)) !== JSON.stringify(LessonSchema.parse(job.snapshot.lesson)))) throw new AppError(422, 'LESSON_MISMATCH', '配音结果必须保留任务快照中的讲稿和画面');
      if (result.renderPlan?.revision !== job.snapshot.revision) throw new AppError(422, 'PREVIEW_REVISION_MISMATCH', '配音结果必须绑定提交时的项目版本');
      await assertAlignedPlan(c, job.projectId, result.renderPlan, result.lesson, job.snapshot.settings, !!job.chapterId);
    } else if (result.renderPlan) await assertNarrationAudio(c, job.projectId, result.renderPlan);
    await c.query('INSERT INTO generation_results(id,job_id,project_id,input_revision,data) VALUES($1,$2,$3,$4,$5) ON CONFLICT(job_id) DO NOTHING', [randomUUID(), id, project.id, job.inputRevision, JSON.stringify(result)]);
    const chapter = job.chapterId ? getProjectChapters(project).find(ch => ch.id === job.chapterId) : null;
    if (chapter) project.assets = await assertAssets(c, project.assets);
    const publishable = job.chapterId ? !!chapter && job.snapshot.chapterSourceKey === getChapterSourceKey(project, chapter) : project.revision === job.inputRevision;
    if (publishable) {
      if (job.chapterId && chapter) {
        const existing = project.chapterVideos?.[chapter.id];
        if (job.kind === 'export') {
          if (!existing || existing.sourceKey !== job.snapshot.chapterSourceKey || existing.previewRevision !== job.snapshot.revision) throw new AppError(409, 'STALE_PREVIEW', '本章节预览已更新，导出结果仍保留在历史任务');
          job.outputRevision = existing.previewRevision;
          project.chapterVideos = { ...project.chapterVideos, [chapter.id]: { ...existing, latestExport: result.videoUrl ? { jobId: job.id, revision: existing.previewRevision, videoUrl: result.videoUrl, subtitleUrl: result.subtitleUrl || null } : existing.latestExport, updatedAt: now() } };
        } else if (result.lesson) {
          if (result.lesson.scenes.some(scene => scene.chapterId && scene.chapterId !== chapter.id)) throw new AppError(422, 'CHAPTER_MISMATCH', '生成结果包含其他章节画面');
          project.revision += 1;
          const irOnly = ['compose', 'regenerate'].includes(job.kind);
          const renderPlan = !irOnly && result.renderPlan ? { ...result.renderPlan, revision: project.revision } : existing?.renderPlan ?? null;
          const video: ChapterVideo = { chapterId: chapter.id, sourceKey: job.snapshot.chapterSourceKey!, settings: job.snapshot.settings, lesson: result.lesson, renderPlan, previewAssets: !irOnly && result.renderPlan ? job.snapshot.assets : existing?.previewAssets ?? [], previewRevision: !irOnly && result.renderPlan ? project.revision : existing?.previewRevision ?? project.revision, latestExport: result.videoUrl ? { jobId: job.id, revision: project.revision, videoUrl: result.videoUrl, subtitleUrl: result.subtitleUrl || null } : null, updatedAt: now() };
          project.chapterVideos = { ...project.chapterVideos, [chapter.id]: video };
          job.outputRevision = project.revision;
        }
      } else {
      if (job.kind !== 'export' && result.lesson) {
        project.revision += 1; project.lesson = result.lesson;
        if (!['compose', 'regenerate'].includes(job.kind) && result.renderPlan) {
          project.renderPlan = { ...result.renderPlan, revision: project.revision };
          project.previewRevision = project.revision;
          project.previewAssets = job.snapshot.assets;
        }
      }
      // Export attaches artifacts to this immutable job; it does not change the lesson revision.
      job.outputRevision = project.revision;
      }
      project.updatedAt = now(); project.latestJob = null; project.latestExport = null;
      await c.query('UPDATE projects SET data=$2,updated_at=now() WHERE id=$1', [project.id, JSON.stringify(project)]);
      if (job.kind !== 'export') await c.query('INSERT INTO project_revisions(project_id,revision,data) VALUES($1,$2,$3) ON CONFLICT(project_id,revision) DO NOTHING', [project.id, project.revision, JSON.stringify(project)]);
    } else {
      job.diagnostics.push({ code: 'STALE_RESULT', severity: 'warning', message: job.chapterId ? '生成期间本章节已编辑或删除，结果保留在历史，没有覆盖当前章节' : '生成期间项目已编辑，本次结果保留在任务历史，没有覆盖当前项目' });
    }
    job.videoUrl = result.videoUrl || null; job.subtitleUrl = result.subtitleUrl || null;
    if (result.lesson) job.preview = { lesson: result.lesson, renderPlan: result.renderPlan || null, updatedAt: now() };
    if (result.diagnostics) job.diagnostics.push(...result.diagnostics);
    job.status = 'succeeded'; job.stage = 'completed'; job.completed = job.total;
    await saveJob(c, job); await event(c, job, job.outputRevision === null ? '任务完成；结果属于旧版本' : '任务完成');
    return job;
  });
}
export async function failJob(id: string, error: string, leaseToken?: string) {
  return withTransaction(async c => {
    const job = await lockedJob(c, id, leaseToken);
    if (terminal(job.status)) return job;
    if (job.status === 'cancelling') { job.status = 'cancelled'; job.stage = 'cancelled'; }
    else { job.status = 'failed'; job.stage = 'failed'; job.error = error.slice(0, 2000); }
    await saveJob(c, job); await event(c, job, job.error || '任务已取消'); return job;
  });
}
export async function markJobCancelled(id: string, leaseToken?: string) {
  return withTransaction(async c => {
    const job = await lockedJob(c, id, leaseToken);
    if (terminal(job.status)) return job;
    job.status = 'cancelled'; job.stage = 'cancelled'; await saveJob(c, job); await event(c, job, '任务已停止'); return job;
  });
}
export async function flushOutbox() {
  await initDb();
  return withTransaction(async c => {
    const pending = await c.query('SELECT o.job_id,o.dispatch_generation,j.data FROM job_outbox o JOIN jobs j ON j.id=o.job_id WHERE o.dispatched_at IS NULL ORDER BY o.created_at LIMIT 20 FOR UPDATE OF o SKIP LOCKED');
    for (const row of pending.rows) {
      const job = row.data as JobRecord;
      const queueId = Number(row.dispatch_generation) > 0 ? `${job.id}-${row.dispatch_generation}` : job.id;
      if (!terminal(job.status)) {
        const previous = await getQueue().getJob(queueId);
        if (previous && ['completed', 'failed'].includes(await previous.getState())) await previous.remove();
        await getQueue().add(job.kind, { jobId: job.id }, { jobId: queueId });
      }
      await c.query('UPDATE job_outbox SET dispatched_at=now(),attempts=attempts+1 WHERE job_id=$1', [job.id]);
    }
    return pending.rows.length;
  });
}
export async function touchWorker() {
  await initDb();
  await getPool().query("INSERT INTO worker_heartbeat(id,touched_at) VALUES('main',now()) ON CONFLICT(id) DO UPDATE SET touched_at=excluded.touched_at");
}
export async function recoverExpiredJobs() {
  await initDb();
  return withTransaction(async c => {
    const expired = await c.query("SELECT id,data FROM jobs WHERE data->>'status' IN ('running','cancelling') AND lease_until < now() ORDER BY lease_until LIMIT 100 FOR UPDATE SKIP LOCKED");
    for (const row of expired.rows) {
      const job = row.data as JobRecord;
      if (job.status === 'cancelling') {
        job.status = 'cancelled'; job.stage = 'cancelled'; await saveJob(c, job); await event(c, job, 'Worker 租约结束，取消任务已完成');
      } else {
        job.status = 'queued'; job.stage = 'queued'; await saveJob(c, job); await event(c, job, 'Worker 租约结束，任务重新排队恢复');
        await c.query('UPDATE job_outbox SET dispatched_at=NULL,dispatch_generation=dispatch_generation+1 WHERE job_id=$1', [job.id]);
      }
      await c.query('UPDATE jobs SET lease_token=NULL,lease_until=NULL WHERE id=$1', [job.id]);
    }
    return expired.rows.length;
  });
}
export async function workerHealth() {
  await initDb();
  const result = await getPool().query("SELECT touched_at FROM worker_heartbeat WHERE id='main'");
  const lastSeen = result.rows[0]?.touched_at ? new Date(result.rows[0].touched_at).toISOString() : null;
  return { ready: !!lastSeen && Date.now() - new Date(lastSeen).getTime() < 45000, lastSeen };
}
export interface RevisionSummary { revision: number; title: string; createdAt: string; hasLesson: boolean; hasPreview: boolean; previewRevision: number | null }
export type JobSummary = Omit<JobRecord, 'snapshot' | 'preview'>;
export async function getProjectHistory(id: string): Promise<{ revisions: RevisionSummary[]; jobs: JobSummary[]; truncated: boolean }> {
  await getProject(id);
  const [revisions, jobs] = await Promise.all([
    getPool().query('SELECT revision,data,created_at FROM project_revisions WHERE project_id=$1 ORDER BY revision DESC LIMIT 201', [id]),
    getPool().query("SELECT data-'snapshot'-'preview' AS data FROM jobs WHERE project_id=$1 ORDER BY created_at DESC LIMIT 201", [id]),
  ]);
  return {
    revisions: revisions.rows.slice(0, 200).map(r => ({ revision: r.revision, title: r.data.title, createdAt: new Date(r.created_at).toISOString(), hasLesson: !!r.data.lesson, hasPreview: !!r.data.renderPlan && r.data.previewRevision === r.revision, previewRevision: r.data.previewRevision ?? null })),
    jobs: jobs.rows.slice(0, 200).map(r => r.data as JobSummary),
    truncated: revisions.rows.length > 200 || jobs.rows.length > 200,
  };
}
export async function getProjectRevision(id: string, revision: number): Promise<Project> {
  checkId(id); await initDb();
  if (!Number.isSafeInteger(revision) || revision < 1) notFound('版本不存在');
  const result = await getPool().query('SELECT data FROM project_revisions WHERE project_id=$1 AND revision=$2', [id, revision]);
  if (!result.rowCount) notFound('版本不存在');
    const jobs = await getPool().query("SELECT data FROM jobs WHERE project_id=$1 AND data->>'chapterId' IS NULL AND data->>'status'='succeeded' AND ((data->>'outputRevision')::integer=$2 OR (data->>'kind'='export' AND (data->>'inputRevision')::integer=$2)) ORDER BY created_at DESC LIMIT 1", [id, revision]);
  const project = sourceSnapshot(result.rows[0].data as Project);
  const chapterVideos = project.chapterVideos && Object.fromEntries(Object.entries(project.chapterVideos).map(([chapterId, video]) => [chapterId, { ...video, settings: SettingsSchema.parse(video.settings) }]));
  return { ...project, ...(chapterVideos ? { chapterVideos } : {}), latestJob: jobs.rows[0]?.data ? normalizedJob(jobs.rows[0].data as JobRecord) : null, latestExport: await getCurrentExport(id, revision) };
}
export async function getCurrentExport(id: string, revision?: number): Promise<ProjectExport | null> {
  checkId(id); await initDb();
  if (revision === undefined) {
    const project = await getPool().query('SELECT data FROM projects WHERE id=$1', [id]);
    if (!project.rowCount) notFound('项目不存在');
    revision = project.rows[0].data.revision;
  }
  const result = await getPool().query("SELECT j.data,a.path FROM jobs j JOIN artifacts a ON '/api/artifacts/'||a.id::text=j.data->>'videoUrl' WHERE j.project_id=$1 AND j.data->>'chapterId' IS NULL AND a.project_id=$1 AND a.mime='video/mp4' AND j.data->>'status'='succeeded' AND ((j.data->>'outputRevision')::integer=$2 OR (j.data->>'kind'='export' AND (j.data->>'inputRevision')::integer=$2)) ORDER BY j.created_at DESC LIMIT 20", [id, revision]);
  for (const row of result.rows) {
    const file = await stat(/* turbopackIgnore: true */ row.path).catch(() => null);
    if (!file?.isFile() || file.size < 1) continue;
    const job = row.data as JobRecord;
    return { jobId: job.id, revision: revision!, videoUrl: job.videoUrl!, subtitleUrl: job.subtitleUrl };
  }
  return null;
}
export async function getJobResult(id: string): Promise<{ job: JobRecord; result: CompletedResult | null }> {
  const job = await getJob(id);
  const result = await getPool().query('SELECT data FROM generation_results WHERE job_id=$1', [id]);
  return { job, result: result.rows[0]?.data || null };
}
export async function revisionDownload(id: string, revision: number, kind: 'video' | 'subtitles'): Promise<string> {
  await getProjectRevision(id, revision);
  const field = kind === 'video' ? 'videoUrl' : 'subtitleUrl';
  const result = await getPool().query("SELECT data FROM jobs WHERE project_id=$1 AND data->>'chapterId' IS NULL AND data->>'status'='succeeded' AND ((data->>'outputRevision')::integer=$2 OR (data->>'kind'='export' AND (data->>'inputRevision')::integer=$2)) AND data->>$3 IS NOT NULL ORDER BY created_at DESC LIMIT 1", [id, revision, field]);
  const url = result.rows[0]?.data[field] as string | undefined;
  const match = url && /^\/api\/artifacts\/([a-f0-9-]{36})$/.exec(url);
  if (!match || !validId(match[1])) notFound('此版本尚未导出文件');
  const artifact = await getPool().query('SELECT project_id FROM artifacts WHERE id=$1', [match[1]]);
  if (!artifact.rowCount || artifact.rows[0].project_id !== id) notFound('版本文件不存在');
  return match[1];
}
