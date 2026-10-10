import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { SettingsSchema, type Asset, type Lesson, type Project, type RenderPlan, type JobRecord } from '../src/shared/schema';
import { getProjectChapters, joinChapterMarkdown } from '../src/shared/chapters';

const schema = `test_${randomUUID().replaceAll('-', '')}`;
let admin: Pool;
let store: typeof import('../src/server/store');
let db: typeof import('../src/server/db');
let queue: typeof import('../src/server/queue');
let artifacts: typeof import('../src/server/artifacts');
let dataDir: string;
const lesson: Lesson = { schemaVersion: '0.1', title: '测试课程', objectives: ['学会测试'], scenes: [{ id: 'scene1', title: '场景', chapter: '章节', layout: 'content', sourceBlockIds: ['block1'], objects: [{ id: 'object1', type: 'text', content: '知识', language: '' }], narration: [{ id: 'utterance1', text: '这是知识。', showObjectIds: ['object1'], focusObjectId: 'object1' }] }] };
const patch = (p: Project, markdown = p.markdown) => ({ expectedRevision: p.revision, title: p.title, markdown, settings: p.settings, assets: p.assets, lesson: p.lesson });
function planFor(p: Project, value: Lesson = lesson, url = '', mode: RenderPlan['previewMode'] = 'draft'): RenderPlan {
  return { schemaVersion: '0.1', revision: p.revision, title: value.title, fps: 30, width: p.settings.resolution === '1080p' ? 1920 : 1280, height: p.settings.resolution === '1080p' ? 1080 : 720, theme: p.settings.theme, previewMode: mode, voice: p.settings.voice, rate: p.settings.rate, totalFrames: 30 * value.scenes.length, scenes: value.scenes.map((scene, index) => ({ scene, startFrame: index * 30, durationFrames: 30, utterances: scene.narration.map(utterance => ({ utteranceId: utterance.id, startFrame: 0, durationFrames: 30, durationSeconds: 1, boundaries: [{ kind: 'utterance' as const, text: utterance.text, startSeconds: 0, endSeconds: 1 }], cacheHit: false, hash: 'fixture', url, estimated: !url })) })) };
}
async function registeredAudio(p: Project) {
  const file = path.join(dataDir, randomUUID()); await writeFile(file, 'registered-audio-fixture');
  return artifacts.publishFile(file, 'audio/mpeg', 'speech.mp3', p.id);
}
function chapterResult(p: Project, job: JobRecord, url: string, value: Lesson = lesson) {
  const chapterLesson = { ...value, scenes: value.scenes.map(scene => ({ ...scene, ...(job.chapterId ? { chapterId: job.chapterId } : {}) })) };
  return { lesson: chapterLesson, renderPlan: planFor({ ...p, settings: job.snapshot.settings, revision: job.snapshot.revision }, chapterLesson, url, 'aligned') };
}
beforeAll(async () => {
  const base = process.env.DATABASE_URL || 'postgresql://opentutor:opentutor@127.0.0.1:54329/opentutor';
  admin = new Pool({ connectionString: base }); await admin.query(`CREATE SCHEMA ${schema}`);
  const url = new URL(base); url.searchParams.set('options', `-c search_path=${schema}`);
  process.env.DATABASE_URL = url.toString(); process.env.OPENTUTOR_DISABLE_DISPATCH = '1'; process.env.OPENTUTOR_QUEUE_NAME = schema;
  dataDir = await mkdtemp(path.join(os.tmpdir(), 'opentutor-server-test-')); process.env.OPENTUTOR_DATA_DIR = dataDir;
  store = await import('../src/server/store'); db = await import('../src/server/db'); queue = await import('../src/server/queue');
  artifacts = await import('../src/server/artifacts');
  await store.initDb();
});
afterAll(async () => {
  if (queue) { await queue.getQueue().obliterate({ force: true }); await queue.closeQueue(); }
  if (store) await store.closeDb();
  if (admin) { await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end(); }
  if (dataDir) await rm(dataDir, { recursive: true, force: true });
});
describe('durable PostgreSQL task transactions', () => {
  it('persists render frame telemetry without appending events for every progress update', async () => {
    const p = await store.createProject({ title: 'render telemetry', markdown: '# 内容' });
    const job = await store.submitJob(p.id, { kind: 'generate', expectedRevision: 1 });
    const claimed = await store.claimJob(job.id); expect(claimed).not.toBeNull();
    const previousEvents = await store.getJobEvents(job.id);
    const detail = { phase: 'rendering' as const, renderedFrames: 12, totalFrames: 120, elapsedMs: 1000, framesPerSecond: 12 };
    await store.updateJobProgress(job.id, 'render', 10, 100, undefined, claimed!.leaseToken, detail);
    await store.updateJobProgress(job.id, 'render', 20, 100, undefined, claimed!.leaseToken, { ...detail, renderedFrames: 24, elapsedMs: 2000 });
    expect((await store.getJob(job.id)).renderProgress).toEqual({ ...detail, renderedFrames: 24, elapsedMs: 2000 });
    expect(await store.getJobEvents(job.id)).toHaveLength(previousEvents.length);
    await store.updateJobProgress(job.id, 'render', 94, 100, '合成音视频', claimed!.leaseToken, { ...detail, phase: 'muxing', renderedFrames: 120, elapsedMs: 3000 });
    expect((await store.getJob(job.id)).renderProgress?.phase).toBe('muxing');
    expect(await store.getJobEvents(job.id)).toHaveLength(previousEvents.length + 1);
    await store.cancelJob(job.id); await store.markJobCancelled(job.id, claimed!.leaseToken); await store.deleteProject(p.id);
  });
  it('rejects stale drafts and freezes source/settings in the submitted job', async () => {
    const p = await store.createProject({ title: 'revision', markdown: '# 第一版' });
    const job = await store.submitJob(p.id, { kind: 'generate', expectedRevision: 1 });
    const next = await store.updateProject(p.id, patch(p, '# 第二版'));
    expect(next.revision).toBe(2);
    await expect(store.updateProject(p.id, patch(p, '# 覆盖'))).rejects.toThrow('项目已更新');
    expect((await store.getJob(job.id)).snapshot.markdown).toBe('# 第一版');
    await store.cancelJob(job.id); await store.deleteProject(p.id);
  });
  it('deduplicates matching idempotency keys and rejects key reuse with new inputs', async () => {
    const p = await store.createProject({ title: 'idempotency', markdown: '# 内容' });
    const input = { kind: 'generate', expectedRevision: 1 };
    const [a, b] = await Promise.all([store.submitJob(p.id, input, 'same-key'), store.submitJob(p.id, input, 'same-key')]);
    expect(a.id).toBe(b.id);
    await expect(store.submitJob(p.id, { ...input, instruction: 'other' }, 'same-key')).rejects.toThrow('幂等键');
    await store.cancelJob(a.id); await store.deleteProject(p.id);
  });
  it('cancellation committed first prevents even valid late results from publishing', async () => {
    const p = await store.createProject({ title: 'cancel', markdown: '# 内容' });
    const job = await store.submitJob(p.id, { kind: 'generate', expectedRevision: 1 });
    const claimed = await store.claimJob(job.id); expect(claimed).not.toBeNull();
    expect((await store.cancelJob(job.id)).status).toBe('cancelling');
    expect((await store.completeJob(job.id, { lesson }, claimed!.leaseToken)).status).toBe('cancelled');
    expect((await store.getProject(p.id)).lesson).toBe(null);
    expect((await db.getPool().query('SELECT * FROM generation_results WHERE job_id=$1', [job.id])).rowCount).toBe(0);
    await store.deleteProject(p.id);
  });
  it('retains historical results without overwriting edits made during generation', async () => {
    const p = await store.createProject({ title: 'older-result', markdown: '# 原始内容' });
    const job = await store.submitJob(p.id, { kind: 'generate', expectedRevision: 1 });
    const claimed = await store.claimJob(job.id); await store.updateProject(p.id, patch(p, '# 作者的新内容'));
    const finished = await store.completeJob(job.id, { lesson }, claimed!.leaseToken);
    expect(finished.status).toBe('succeeded'); expect(finished.outputRevision).toBe(null);
    const current = await store.getProject(p.id); expect(current.markdown).toBe('# 作者的新内容'); expect(current.lesson).toBe(null);
    expect((await db.getPool().query('SELECT * FROM generation_results WHERE job_id=$1', [job.id])).rowCount).toBe(1);
    await store.deleteProject(p.id);
  });
  it('fences a stale Worker after its expired lease was reclaimed', async () => {
    const p = await store.createProject({ title: 'lease', markdown: '# 内容' });
    const job = await store.submitJob(p.id, { kind: 'generate', expectedRevision: 1 });
    const first = await store.claimJob(job.id); expect(await store.claimJob(job.id)).toBe(null);
    await db.getPool().query("UPDATE jobs SET lease_until=now()-interval '1 second' WHERE id=$1", [job.id]);
    const second = await store.claimJob(job.id); expect(second!.leaseToken).not.toBe(first!.leaseToken);
    await expect(store.completeJob(job.id, { lesson }, first!.leaseToken)).rejects.toThrow('接管');
    const result = await store.completeJob(job.id, { lesson }, second!.leaseToken);
    expect(result.outputRevision).toBe(2); expect((await store.getProject(p.id)).lesson?.title).toBe(lesson.title);
    await store.deleteProject(p.id);
  });
  it('dispatches outbox records idempotently despite repeated delivery', async () => {
    const p = await store.createProject({ title: 'outbox', markdown: '# 内容' });
    const job = await store.submitJob(p.id, { kind: 'generate', expectedRevision: 1 });
    expect((await db.getPool().query('SELECT * FROM job_outbox WHERE job_id=$1 AND dispatched_at IS NULL', [job.id])).rowCount).toBe(1);
    await store.flushOutbox();
    await db.getPool().query('UPDATE job_outbox SET dispatched_at=NULL WHERE job_id=$1', [job.id]);
    await store.flushOutbox();
    const jobs = await queue.getQueue().getJobs(['waiting', 'delayed']);
    expect(jobs.filter(j => j.id === job.id)).toHaveLength(1);
    await store.cancelJob(job.id); await store.deleteProject(p.id);
  });
  it('recovers expired work with a fresh queue delivery and finishes abandoned cancellations', async () => {
    const p = await store.createProject({ title: 'recovery', markdown: '# 内容' });
    const job = await store.submitJob(p.id, { kind: 'generate', expectedRevision: 1 });
    const initial = await store.claimJob(job.id); await store.flushOutbox();
    await db.getPool().query("UPDATE jobs SET lease_until=now()-interval '1 second' WHERE id=$1", [job.id]);
    expect(await store.recoverExpiredJobs()).toBe(1); expect((await store.getJob(job.id)).status).toBe('queued');
    await store.flushOutbox(); expect(await queue.getQueue().getJob(`${job.id}-1`)).not.toBeUndefined();
    const recovered = await store.claimJob(job.id);
    await expect(store.completeJob(job.id, { lesson }, initial!.leaseToken)).rejects.toThrow('接管');
    await store.cancelJob(job.id);
    await db.getPool().query("UPDATE jobs SET lease_until=now()-interval '1 second' WHERE id=$1", [job.id]);
    expect(await store.recoverExpiredJobs()).toBe(1); expect((await store.getJob(job.id)).status).toBe('cancelled');
    expect(await store.heartbeatJob(job.id, recovered!.leaseToken)).toBe(false);
    await store.deleteProject(p.id);
  });
  it('refuses error diagnostics before result publication', async () => {
    const p = await store.createProject({ title: 'bad-result', markdown: '# 内容' });
    const job = await store.submitJob(p.id, { kind: 'generate', expectedRevision: 1 });
    const claimed = await store.claimJob(job.id);
    await expect(store.completeJob(job.id, { lesson, diagnostics: [{ code: 'ERROR', severity: 'error', message: 'bad' }] }, claimed!.leaseToken)).rejects.toThrow('错误诊断');
    expect((await store.getProject(p.id)).lesson).toBe(null);
    await store.failJob(job.id, 'test failure', claimed!.leaseToken); await store.deleteProject(p.id);
  });
  it('keeps old previews readable and binds historical downloads to the rendered revision', async () => {
    let p = await store.createProject({ title: 'history', markdown: '# 来源讲义' });
    const sourceFile = path.join(dataDir, 'fixture.bin'); await writeFile(sourceFile, 'media-fixture');
    const media = await artifacts.publishFile(sourceFile, 'video/mp4', 'lesson.mp4', p.id);
    const audio = await artifacts.publishFile(sourceFile, 'audio/mpeg', 'speech.mp3', p.id);
    const speech = { utteranceId: 'utterance1', startFrame: 0, durationFrames: 30, url: audio.url, durationSeconds: 1, boundaries: [{ kind: 'utterance' as const, text: '这是知识。', startSeconds: 0, endSeconds: 1 }], cacheHit: false, hash: 'fixture' };
    const plan: RenderPlan = { schemaVersion: '0.1', revision: 1, title: lesson.title, fps: 30, width: 1280, height: 720, theme: 'sage', totalFrames: 30, scenes: [{ scene: lesson.scenes[0], startFrame: 0, durationFrames: 30, utterances: [speech] }] };
    const generated = await store.submitJob(p.id, { kind: 'generate', expectedRevision: 1 });
    const claimed = await store.claimJob(generated.id);
    await store.completeJob(generated.id, { lesson, renderPlan: plan, videoUrl: media.url }, claimed!.leaseToken);
    p = await store.getProject(p.id); expect(p.revision).toBe(2); expect(p.previewRevision).toBe(2);
    const exported = await store.submitJob(p.id, { kind: 'export', expectedRevision: 2 });
    const exportedClaim = await store.claimJob(exported.id);
    const draft = await store.updateProject(p.id, patch(p, '# 更改后的来源'));
    expect(draft.lesson).toBe(null); expect(draft.renderPlan?.revision).toBe(2); expect(draft.previewRevision).toBe(2);
    expect((await store.getJob(exported.id)).snapshot.renderPlan?.revision).toBe(2);
    expect((await store.getJob(exported.id)).snapshot.markdown).toBe('# 来源讲义');
    await store.completeJob(exported.id, { lesson, renderPlan: p.renderPlan!, videoUrl: media.url }, exportedClaim!.leaseToken);
    expect(await store.revisionDownload(p.id, 2, 'video')).toBe(media.id);
    await expect(store.revisionDownload(p.id, 3, 'video')).rejects.toThrow('尚未导出');
    const saved = await store.getProjectRevision(p.id, 2); expect(saved.lesson?.title).toBe(lesson.title); expect(saved.markdown).toBe('# 来源讲义');
    const history = await store.getProjectHistory(p.id); expect(history.jobs).toHaveLength(2); expect(history.revisions[0]).toMatchObject({ revision: 3, hasPreview: false, previewRevision: 2 });
    expect('snapshot' in history.jobs[0]).toBe(false);
    expect((await store.getJobResult(exported.id)).result?.videoUrl).toBe(media.url);
    await store.deleteProject(p.id);
  });
  it('separates composing, author edits, real speech, and export permissions', async () => {
    let p = await store.createProject({ title: 'stages', markdown: '# 分阶段课程' });
    await expect(store.submitJob(p.id, { kind: 'speech', expectedRevision: p.revision })).rejects.toThrow('分镜');
    const composed = await store.submitJob(p.id, { kind: 'compose', expectedRevision: p.revision });
    const director = await store.claimJob(composed.id);
    const draftPlan = planFor(p);
    await store.updateJobPreview(composed.id, { lesson, renderPlan: draftPlan }, director!.leaseToken);
    expect((await store.getJob(composed.id)).preview?.renderPlan?.previewMode).toBe('draft');
    expect((await store.getProject(p.id)).lesson).toBe(null);
    await store.completeJob(composed.id, { lesson, renderPlan: draftPlan }, director!.leaseToken);
    p = await store.getProject(p.id); expect(p.revision).toBe(2); expect(p.lesson).not.toBeNull(); expect(p.renderPlan).toBe(null);
    await expect(store.submitJob(p.id, { kind: 'export', expectedRevision: p.revision })).rejects.toThrow('配音预览');
    p = await store.updateProject(p.id, { ...patch(p), title: '作者确认讲稿' });
    const audio = await registeredAudio(p);
    const speech = await store.submitJob(p.id, { kind: 'speech', expectedRevision: p.revision });
    const speaker = await store.claimJob(speech.id);
    const partialPlan = planFor(p, lesson, audio.url, 'partial');
    await store.updateJobPreview(speech.id, { lesson, renderPlan: partialPlan }, speaker!.leaseToken);
    expect((await store.getJob(speech.id)).preview?.renderPlan?.previewMode).toBe('partial');
    await expect(store.completeJob(speech.id, { lesson, renderPlan: partialPlan }, speaker!.leaseToken)).rejects.toThrow('真实配音');
    const alignedPlan = { ...partialPlan, previewMode: 'aligned' as const };
    await store.completeJob(speech.id, { lesson, renderPlan: alignedPlan }, speaker!.leaseToken);
    p = await store.getProject(p.id); expect(p.revision).toBe(4); expect(p.previewRevision).toBe(4); expect(p.renderPlan?.previewMode).toBe('aligned');
    const exported = await store.submitJob(p.id, { kind: 'export', expectedRevision: p.revision });
    expect(exported.snapshot.renderPlan?.revision).toBe(4);
    await store.cancelJob(exported.id); await store.deleteProject(p.id);
  });
  it('preserves a prior aligned preview when a new composition publishes only IR', async () => {
    let p = await store.createProject({ title: 'IR revision', markdown: '# 旧课程' });
    const audio = await registeredAudio(p); const oldPlan = planFor(p, lesson, audio.url, 'aligned');
    const generated = await store.submitJob(p.id, { kind: 'generate', expectedRevision: p.revision });
    const generator = await store.claimJob(generated.id); await store.completeJob(generated.id, { lesson, renderPlan: oldPlan }, generator!.leaseToken);
    p = await store.getProject(p.id);
    const newerLesson = { ...lesson, title: '新版 IR' };
    const composed = await store.submitJob(p.id, { kind: 'compose', expectedRevision: p.revision });
    const director = await store.claimJob(composed.id); await store.completeJob(composed.id, { lesson: newerLesson, renderPlan: planFor(p, newerLesson) }, director!.leaseToken);
    const updated = await store.getProject(p.id);
    expect(updated.revision).toBe(3); expect(updated.lesson?.title).toBe('新版 IR'); expect(updated.renderPlan?.previewMode).toBe('aligned'); expect(updated.previewRevision).toBe(2);
    expect((await store.getJobResult(composed.id)).result?.renderPlan?.previewMode).toBe('draft');
    await expect(store.submitJob(p.id, { kind: 'export', expectedRevision: updated.revision })).rejects.toThrow('配音预览');
    await store.deleteProject(p.id);
  });
  it('fences incremental previews and preserves partial output through cancellation and failure', async () => {
    const p = await store.createProject({ title: 'partial', markdown: '# 部分预览' });
    const job = await store.submitJob(p.id, { kind: 'compose', expectedRevision: p.revision });
    const first = await store.claimJob(job.id); await store.updateJobPreview(job.id, { lesson, renderPlan: planFor(p) }, first!.leaseToken);
    await db.getPool().query("UPDATE jobs SET lease_until=now()-interval '1 second' WHERE id=$1", [job.id]);
    const second = await store.claimJob(job.id);
    await expect(store.updateJobPreview(job.id, { lesson, renderPlan: null }, first!.leaseToken)).rejects.toThrow('接管');
    const newer = { ...lesson, title: '最新部分预览' };
    await store.updateJobPreview(job.id, { lesson: newer, renderPlan: planFor(p, newer) }, second!.leaseToken);
    await store.cancelJob(job.id);
    await store.updateJobPreview(job.id, { lesson, renderPlan: null }, second!.leaseToken);
    await store.completeJob(job.id, { lesson }, second!.leaseToken);
    const cancelled = await store.getJob(job.id); expect(cancelled.status).toBe('cancelled'); expect(cancelled.preview?.lesson.title).toBe('最新部分预览'); expect((await store.getProject(p.id)).lesson).toBe(null);
    const failedJob = await store.submitJob(p.id, { kind: 'compose', expectedRevision: p.revision });
    const failing = await store.claimJob(failedJob.id); await store.updateJobPreview(failedJob.id, { lesson, renderPlan: null }, failing!.leaseToken);
    await store.failJob(failedJob.id, '后续生成失败', failing!.leaseToken);
    expect((await store.getJob(failedJob.id)).preview?.lesson.title).toBe(lesson.title);
    await store.deleteProject(p.id);
  });
  it('rejects errors already recorded on a running job before any result commit', async () => {
    const p = await store.createProject({ title: 'accumulated error', markdown: '# 错误阻断' });
    const job = await store.submitJob(p.id, { kind: 'compose', expectedRevision: p.revision }); const claimed = await store.claimJob(job.id);
    await store.addJobDiagnostic(job.id, { code: 'ERROR', severity: 'error', message: '已有阻断错误' }, claimed!.leaseToken);
    await expect(store.completeJob(job.id, { lesson }, claimed!.leaseToken)).rejects.toThrow('错误诊断');
    expect((await store.getJobResult(job.id)).result).toBe(null);
    await store.failJob(job.id, '不可发布', claimed!.leaseToken); await store.deleteProject(p.id);
  });
  it('refuses draft, partial, estimated, unregistered, and mismatched scene plans at export submission', async () => {
    let p = await store.createProject({ title: 'export alignment', markdown: '# 配音校验' });
    const audio = await registeredAudio(p); const plan = planFor(p, lesson, audio.url, 'aligned');
    const job = await store.submitJob(p.id, { kind: 'generate', expectedRevision: p.revision }); const claimed = await store.claimJob(job.id);
    await store.completeJob(job.id, { lesson, renderPlan: plan }, claimed!.leaseToken); p = await store.getProject(p.id);
    const aligned = p.renderPlan!;
    const variants: RenderPlan[] = [
      { ...aligned, previewMode: 'draft' }, { ...aligned, previewMode: 'partial' },
      { ...aligned, scenes: aligned.scenes.map(s => ({ ...s, utterances: s.utterances.map(u => ({ ...u, estimated: true })) })) },
      { ...aligned, scenes: aligned.scenes.map(s => ({ ...s, utterances: s.utterances.map(u => ({ ...u, url: '' })) })) },
      { ...aligned, scenes: aligned.scenes.map(s => ({ ...s, utterances: s.utterances.map(u => ({ ...u, url: `/api/artifacts/${randomUUID()}` })) })) },
      { ...aligned, scenes: aligned.scenes.map(s => ({ ...s, scene: { ...s.scene, title: '旧场景' } })) },
    ];
    for (const variant of variants) {
      await db.getPool().query('UPDATE projects SET data=$2 WHERE id=$1', [p.id, JSON.stringify({ ...p, renderPlan: variant })]);
      await expect(store.submitJob(p.id, { kind: 'export', expectedRevision: p.revision })).rejects.toThrow('真实配音');
    }
    const legacy = { ...aligned }; delete legacy.previewMode; delete legacy.voice; delete legacy.rate;
    await db.getPool().query('UPDATE projects SET data=$2 WHERE id=$1', [p.id, JSON.stringify({ ...p, renderPlan: legacy })]);
    const exported = await store.submitJob(p.id, { kind: 'export', expectedRevision: p.revision }); expect(exported.kind).toBe('export');
    await store.cancelJob(exported.id); await store.deleteProject(p.id);
  });
  it('validates the registered owner and exact timeline duration of a whole-lesson audio track', async () => {
    let p = await store.createProject({ title: 'master audio', markdown: '# 整课音轨' });
    const composed = await store.submitJob(p.id, { kind: 'compose', expectedRevision: p.revision });
    const director = await store.claimJob(composed.id); await store.completeJob(composed.id, { lesson }, director!.leaseToken); p = await store.getProject(p.id);
    const clips = await registeredAudio(p); const master = await registeredAudio(p);
    const another = await store.createProject({ title: 'other owner', markdown: '# 不同课程' }); const foreign = await registeredAudio(another);
    const fixture = path.join(dataDir, randomUUID()); await writeFile(fixture, 'non-audio-artifact');
    const wrongMime = await artifacts.publishFile(fixture, 'video/mp4', 'wrong.mp4', p.id);
    const missing = await registeredAudio(p); await rm(missing.path);
    const emptyFile = path.join(dataDir, randomUUID()); await writeFile(emptyFile, ''); const empty = await artifacts.publishFile(emptyFile, 'audio/mpeg', 'empty.mp3', p.id);
    const plan = { ...planFor(p, lesson, clips.url, 'aligned'), narrationAudio: { url: master.url, durationSeconds: 1 } };
    const job = await store.submitJob(p.id, { kind: 'speech', expectedRevision: p.revision }); const speaker = await store.claimJob(job.id);
    const invalidTracks = [
      { url: foreign.url, durationSeconds: 1 }, { url: `/api/artifacts/${randomUUID()}`, durationSeconds: 1 },
      { url: wrongMime.url, durationSeconds: 1 }, { url: missing.url, durationSeconds: 1 }, { url: empty.url, durationSeconds: 1 },
      { url: master.url, durationSeconds: 0 }, { url: master.url, durationSeconds: NaN }, { url: master.url, durationSeconds: Infinity },
      { url: master.url, durationSeconds: 0.7 }, { url: master.url, durationSeconds: 1.25 }, { url: '', durationSeconds: 1 },
    ];
    for (const narrationAudio of invalidTracks) {
      const invalid = { ...plan, narrationAudio };
      await expect(store.updateJobPreview(job.id, { lesson, renderPlan: invalid }, speaker!.leaseToken)).rejects.toThrow('整课音轨');
      await expect(store.completeJob(job.id, { lesson, renderPlan: invalid }, speaker!.leaseToken)).rejects.toThrow('整课音轨');
      expect((await store.getJobResult(job.id)).result).toBe(null);
    }
    // AAC/MP3 metadata may include a small final codec frame. That tolerance
    // is bounded and does not let a stale or truncated track pass.
    const accepted = { ...plan, narrationAudio: { ...plan.narrationAudio, durationSeconds: 1.04 } };
    await store.updateJobPreview(job.id, { lesson, renderPlan: accepted }, speaker!.leaseToken);
    await store.completeJob(job.id, { lesson, renderPlan: accepted }, speaker!.leaseToken); p = await store.getProject(p.id);
    expect(p.renderPlan?.narrationAudio?.url).toBe(master.url);
    const published = p;
    await db.getPool().query('UPDATE projects SET data=$2 WHERE id=$1', [p.id, JSON.stringify({ ...p, renderPlan: { ...p.renderPlan, narrationAudio: invalidTracks[0] } })]);
    await expect(store.submitJob(p.id, { kind: 'export', expectedRevision: p.revision })).rejects.toThrow('整课音轨');
    await db.getPool().query('UPDATE projects SET data=$2 WHERE id=$1', [p.id, JSON.stringify(published)]);
    const exported = await store.submitJob(p.id, { kind: 'export', expectedRevision: p.revision });
    expect(exported.snapshot.renderPlan?.narrationAudio?.url).toBe(master.url);
    await store.cancelJob(exported.id); await store.deleteProject(p.id); await store.deleteProject(another.id);
  });
  it('fences master-track publication and preserves it for review after cancellation or failure', async () => {
    let p = await store.createProject({ title: 'master fence', markdown: '# 音轨提交隔离' });
    const composed = await store.submitJob(p.id, { kind: 'compose', expectedRevision: p.revision });
    const director = await store.claimJob(composed.id); await store.completeJob(composed.id, { lesson }, director!.leaseToken); p = await store.getProject(p.id);
    const audio = await registeredAudio(p); const plan = { ...planFor(p, lesson, audio.url, 'aligned'), narrationAudio: { url: audio.url, durationSeconds: 1 } };
    const job = await store.submitJob(p.id, { kind: 'speech', expectedRevision: p.revision }); const first = await store.claimJob(job.id);
    await db.getPool().query("UPDATE jobs SET lease_until=now()-interval '1 second' WHERE id=$1", [job.id]); const second = await store.claimJob(job.id);
    await expect(store.updateJobPreview(job.id, { lesson, renderPlan: plan }, first!.leaseToken)).rejects.toThrow('接管');
    await expect(store.completeJob(job.id, { lesson, renderPlan: plan }, first!.leaseToken)).rejects.toThrow('接管');
    await store.updateJobPreview(job.id, { lesson, renderPlan: plan }, second!.leaseToken);
    await store.cancelJob(job.id);
    await store.updateJobPreview(job.id, { lesson, renderPlan: { ...plan, narrationAudio: { url: '', durationSeconds: 0 } } }, second!.leaseToken);
    expect((await store.completeJob(job.id, { lesson, renderPlan: plan }, second!.leaseToken)).status).toBe('cancelled');
    expect((await store.getProject(p.id)).renderPlan).toBe(null);
    expect((await store.getJob(job.id)).preview?.renderPlan?.narrationAudio?.url).toBe(audio.url);
    expect((await store.getJobResult(job.id)).result).toBe(null);
    const failingJob = await store.submitJob(p.id, { kind: 'speech', expectedRevision: p.revision }); const failing = await store.claimJob(failingJob.id);
    await store.updateJobPreview(failingJob.id, { lesson, renderPlan: plan }, failing!.leaseToken); await store.failJob(failingJob.id, '后续步骤失败', failing!.leaseToken);
    expect((await store.getJob(failingJob.id)).preview?.renderPlan?.narrationAudio?.url).toBe(audio.url);
    expect((await store.getProject(p.id)).renderPlan).toBe(null);
    await store.deleteProject(p.id);
  });
  it('creates a title-only draft with one empty chapter and blocks empty preview generation', async () => {
    const p = await store.createProject({ title: '新的空课程' });
    expect(p.sourceMode).toBe('chapters'); expect(p.markdown).toBe(''); expect(p.chapters).toHaveLength(1); expect(p.chapters![0].markdown).toBe('');
    for (const kind of ['preview', 'compose', 'generate']) await expect(store.submitJob(p.id, { kind, expectedRevision: p.revision })).rejects.toThrow('文稿为空');
    const read = await store.getProject(p.id); expect(read.chapters).toEqual(p.chapters); expect(read.latestExport).toBe(null);
    await store.deleteProject(p.id);
  });
  it('freezes chapter source truth and keeps a stale preview result from replacing newer chapter edits', async () => {
    const chapters = [{ id: 'chapter-a', title: 'A 章', markdown: '# A\n\n知识' }, { id: 'chapter-empty', title: '待编写', markdown: '' }];
    let p = await store.createProject({ title: '章稿', chapters, markdown: '# 这个旧字段应被忽略' });
    expect(p.markdown).toBe(joinChapterMarkdown(chapters)); expect(p.sourceMode).toBe('chapters');
    const job = await store.submitJob(p.id, { kind: 'preview', expectedRevision: p.revision }); const claimed = await store.claimJob(job.id);
    const audio = await registeredAudio(p); const plan = planFor(p, lesson, audio.url, 'aligned');
    const nextChapters = chapters.map(c => c.id === 'chapter-a' ? { ...c, title: '作者的新章名', markdown: '# 修改后的 A\n\n新知识' } : c);
    p = await store.updateProject(p.id, { ...patch(p), chapters: nextChapters });
    const frozen = await store.getJob(job.id); expect(frozen.snapshot.chapters).toEqual(chapters); expect(frozen.snapshot.sourceMode).toBe('chapters'); expect(frozen.snapshot.markdown).toBe('# A\n\n知识');
    const finished = await store.completeJob(job.id, { lesson, renderPlan: plan }, claimed!.leaseToken);
    expect(finished.outputRevision).toBe(null); expect((await store.getProject(p.id)).lesson).toBe(null); expect((await store.getProject(p.id)).chapters![0].title).toBe('作者的新章名');
    expect((await store.getJobResult(job.id)).result?.lesson?.title).toBe(lesson.title);
    await store.deleteProject(p.id);
  });
  it('invalidates IR for chapter title, ID, or order changes even when aggregate Markdown is unchanged', async () => {
    let p = await store.createProject({ title: 'metadata invalidation', chapters: [{ id: 'a', title: 'A', markdown: '相同正文' }, { id: 'b', title: 'B', markdown: '相同正文' }] });
    const audio = await registeredAudio(p); const firstJob = await store.submitJob(p.id, { kind: 'preview', expectedRevision: p.revision }); const first = await store.claimJob(firstJob.id);
    await store.completeJob(firstJob.id, { lesson, renderPlan: planFor(p, lesson, audio.url, 'aligned') }, first!.leaseToken); p = await store.getProject(p.id);
    const previousPreview = p.previewRevision;
    const mutations = [
      (chapters: NonNullable<Project['chapters']>) => chapters.map((c, i) => i === 0 ? { ...c, title: '改名' } : c),
      (chapters: NonNullable<Project['chapters']>) => [...chapters].reverse(),
      (chapters: NonNullable<Project['chapters']>) => chapters.map((c, i) => i === 0 ? { ...c, id: 'changed-id' } : c),
    ];
    for (const mutate of mutations) {
      const markdown = p.markdown;
      p = await store.updateProject(p.id, { ...patch(p), chapters: mutate(getProjectChapters(p)) });
      expect(p.markdown).toBe(markdown); expect(p.lesson).toBe(null); expect(p.previewRevision).toBe(previousPreview); expect(p.renderPlan).not.toBe(null);
      const composed = await store.submitJob(p.id, { kind: 'compose', expectedRevision: p.revision }); const director = await store.claimJob(composed.id);
      await store.completeJob(composed.id, { lesson }, director!.leaseToken); p = await store.getProject(p.id);
    }
    p = await store.updateProject(p.id, { ...patch(p), chapters: getProjectChapters(p) }); expect(p.lesson?.title).toBe(lesson.title);
    await store.deleteProject(p.id);
  });
  it('adapts legacy chapters on reads without rewriting original Markdown or old previews', async () => {
    let p = await store.createProject({ title: 'legacy read', markdown: '# 旧课程\r\n\r\n## 原章\r\n原稿 🧮' });
    const audio = await registeredAudio(p); const generated = await store.submitJob(p.id, { kind: 'generate', expectedRevision: p.revision }); const worker = await store.claimJob(generated.id);
    await store.completeJob(generated.id, { lesson, renderPlan: planFor(p, lesson, audio.url, 'aligned') }, worker!.leaseToken); p = await store.getProject(p.id);
    const legacy = { ...p }; delete legacy.chapters; delete legacy.sourceMode;
    await db.getPool().query('UPDATE projects SET data=$2 WHERE id=$1', [p.id, JSON.stringify(legacy)]);
    const before = (await db.getPool().query('SELECT data FROM projects WHERE id=$1', [p.id])).rows[0].data;
    const read = await store.getProject(p.id); expect(read.sourceMode).toBe('legacy'); expect(read.chapters?.length).toBeGreaterThan(0); expect(read.markdown).toBe(legacy.markdown); expect(read.renderPlan).toEqual(legacy.renderPlan);
    const after = (await db.getPool().query('SELECT data FROM projects WHERE id=$1', [p.id])).rows[0].data; expect(after).toEqual(before);
    const exported = await store.submitJob(p.id, { kind: 'export', expectedRevision: p.revision }); expect(exported.snapshot.sourceMode).toBe('legacy'); expect(exported.snapshot.chapters).toEqual(read.chapters); expect(exported.snapshot.markdown).toBe(legacy.markdown); await store.cancelJob(exported.id);
    const migrated = await store.updateProject(p.id, { ...patch(read), chapters: read.chapters }); expect(migrated.sourceMode).toBe('chapters'); expect(migrated.lesson).toBe(null); expect(migrated.previewRevision).toBe(read.previewRevision);
    const oldApi = await store.updateProject(p.id, patch(migrated, '# 原 API 新正文')); expect(oldApi.sourceMode).toBe('legacy'); expect(oldApi.markdown).toBe('# 原 API 新正文');
    await store.deleteProject(p.id);
  });
  it('reuses a successful current-version export after later tasks and excludes exports after source edits', async () => {
    let p = await store.createProject({ title: 'download reuse', chapters: [{ id: 'only', title: '唯一章节', markdown: '# 内容\n\n讲义' }] });
    const audio = await registeredAudio(p); const preview = await store.submitJob(p.id, { kind: 'preview', expectedRevision: p.revision }); const director = await store.claimJob(preview.id);
    await expect(store.completeJob(preview.id, { lesson, renderPlan: { ...planFor(p, lesson, audio.url, 'aligned'), previewMode: 'partial' } }, director!.leaseToken)).rejects.toThrow('真实配音');
    await store.completeJob(preview.id, { lesson, renderPlan: planFor(p, lesson, audio.url, 'aligned') }, director!.leaseToken); p = await store.getProject(p.id);
    expect(p.latestExport).toBe(null);
    const file = path.join(dataDir, randomUUID()); await writeFile(file, 'registered-video-fixture'); const media = await artifacts.publishFile(file, 'video/mp4', 'export.mp4', p.id);
    const exported = await store.submitJob(p.id, { kind: 'export', expectedRevision: p.revision }); const renderer = await store.claimJob(exported.id);
    await store.completeJob(exported.id, { lesson, renderPlan: p.renderPlan!, videoUrl: media.url }, renderer!.leaseToken);
    const expected = { jobId: exported.id, revision: p.revision, videoUrl: media.url, subtitleUrl: null };
    expect(await store.getCurrentExport(p.id)).toEqual(expected); expect((await store.getProject(p.id)).latestExport).toEqual(expected);
    const otherJob = await store.submitJob(p.id, { kind: 'compose', expectedRevision: p.revision }); await store.cancelJob(otherJob.id);
    expect((await store.getProject(p.id)).latestJob?.status).toBe('cancelled'); expect((await store.getProject(p.id)).latestExport).toEqual(expected);
    const updated = await store.updateProject(p.id, { ...patch(p), chapters: [{ ...p.chapters![0], markdown: '# 改稿\n\n新内容' }] }); expect(updated.latestExport).toBe(null); expect(await store.getCurrentExport(p.id)).toBe(null);
    expect(await store.getCurrentExport(p.id, p.revision)).toEqual(expected);
    await store.deleteProject(p.id);
  });
  it('normalizes asset hashes and dimensions from registered bytes before saving or freezing jobs', async () => {
    const bytes = await sharp({ create: { width: 24, height: 40, channels: 3, background: { r: 240, g: 245, b: 230 } } }).png().toBuffer();
    const uploaded = await artifacts.uploadImage(bytes, 'portrait.png');
    const forged = { ...uploaded, hash: 'forged-client-hash', width: 4000, height: 20 };
    let p = await store.createProject({ title: 'asset metadata', chapters: [{ id: 'image', title: '图文', markdown: '![图片](portrait.png)' }], assets: [forged] });
    expect(p.assets[0]).toMatchObject({ hash: uploaded.hash, width: 24, height: 40 });
    const legacyAsset: Asset = { ...uploaded }; delete legacyAsset.width; delete legacyAsset.height;
    p = await store.updateProject(p.id, { ...patch(p), chapters: p.chapters, assets: [legacyAsset] }); expect(p.assets[0].width).toBe(24);
    // Even a previously stored untrusted hash cannot enter a new task cache key.
    await db.getPool().query('UPDATE projects SET data=$2 WHERE id=$1', [p.id, JSON.stringify({ ...p, assets: [forged] })]);
    const job = await store.submitJob(p.id, { kind: 'preview', expectedRevision: p.revision });
    expect(job.snapshot.assets[0]).toMatchObject({ hash: uploaded.hash, width: 24, height: 40 });
    await store.cancelJob(job.id); await store.deleteProject(p.id);
  });
  it('normalizes old intent settings without rewriting stored data or invalidating a published chapter', async () => {
    const oldSettings = SettingsSchema.parse({ audience: '初学者' });
    let p = await store.createProject({ title: '旧项目用途兼容', settings: oldSettings, chapters: [{ id: 'a', title: '原章节', markdown: '保留旧内容', settings: oldSettings }] });
    const job = await store.submitJob(p.id, { kind: 'preview', chapterId: 'a', expectedRevision: p.revision });
    const owner = await store.claimJob(job.id); const audio = await registeredAudio(p);
    await store.completeJob(job.id, chapterResult(p, job, audio.url), owner!.leaseToken);
    p = await store.getProject(p.id);
    const withoutNewFields = (value: unknown): unknown => Array.isArray(value) ? value.map(withoutNewFields) : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).filter(([key]) => !['videoIntent', 'creativeBrief'].includes(key)).map(([key, child]) => [key, withoutNewFields(child)])) : value;
    const stored = withoutNewFields(p);
    await db.getPool().query('UPDATE projects SET data=$2 WHERE id=$1', [p.id, JSON.stringify(stored)]);
    await db.getPool().query('UPDATE project_revisions SET data=$3 WHERE project_id=$1 AND revision=$2', [p.id, p.revision, JSON.stringify(stored)]);
    const finishedJob = await store.getJob(job.id);
    await db.getPool().query('UPDATE jobs SET data=$2 WHERE id=$1', [job.id, JSON.stringify(withoutNewFields(finishedJob))]);
    const reloaded = await store.getProject(p.id);
    const expected = { videoIntent: 'auto', creativeBrief: '', audience: '初学者' };
    expect(reloaded.settings).toMatchObject(expected);
    expect(reloaded.chapters![0].settings).toMatchObject(expected);
    expect(reloaded.chapterVideos!.a.settings).toMatchObject(expected);
    expect(reloaded.chapterVideos!.a.current).toBe(true);
    expect((await store.getProjectRevision(p.id, p.revision)).chapterVideos!.a.settings).toMatchObject(expected);
    const historical = await store.getJob(job.id);
    expect(historical.snapshot.settings).toMatchObject(expected);
    expect(historical.snapshot.chapters![0].settings).toMatchObject(expected);
    expect(historical.snapshot.context![0].settings).toMatchObject(expected);
    expect((await db.getPool().query('SELECT data FROM projects WHERE id=$1', [p.id])).rows[0].data).toEqual(stored);
    const exported = await store.submitJob(p.id, { kind: 'export', chapterId: 'a', expectedRevision: reloaded.revision });
    expect(exported.snapshot.lesson).toEqual(reloaded.chapterVideos!.a.lesson);
    await store.cancelJob(exported.id); await store.deleteProject(p.id);
  });
  it('freezes creative intent and only invalidates the chapter whose direction changed', async () => {
    let p = await store.createProject({ title: '通用视频', chapters: [{ id: 'a', title: '产品介绍', markdown: '介绍图片整理功能。' }, { id: 'b', title: '故事', markdown: '傍晚，灯亮了。' }] });
    expect(p.settings).toMatchObject({ videoIntent: 'auto', creativeBrief: '', audience: '普通观众' });
    const audio = await registeredAudio(p);
    for (const chapterId of ['a', 'b']) {
      const job = await store.submitJob(p.id, { kind: 'preview', chapterId, expectedRevision: p.revision }); const owner = await store.claimJob(job.id);
      await store.completeJob(job.id, chapterResult(p, job, audio.url), owner!.leaseToken); p = await store.getProject(p.id);
    }
    const next = SettingsSchema.parse({ ...p.settings, videoIntent: 'product', creativeBrief: '以一次使用过程介绍功能，不添加未提供的数据。' });
    p = await store.updateProject(p.id, { ...patch(p), chapters: p.chapters!.map(chapter => chapter.id === 'a' ? { ...chapter, settings: next } : chapter) });
    expect(p.chapterVideos!.a.current).toBe(false); expect(p.chapterVideos!.b.current).toBe(true);
    await expect(store.submitJob(p.id, { kind: 'export', chapterId: 'a', expectedRevision: p.revision })).rejects.toThrow('重建');
    const job = await store.submitJob(p.id, { kind: 'preview', chapterId: 'a', expectedRevision: p.revision }); const owner = await store.claimJob(job.id);
    expect(job.snapshot.settings).toMatchObject({ videoIntent: 'product', creativeBrief: next.creativeBrief });
    p = await store.updateProject(p.id, { ...patch(p), chapters: p.chapters!.map(chapter => chapter.id === 'a' ? { ...chapter, settings: { ...next, creativeBrief: '改为介绍信息结构。' } } : chapter) });
    expect((await store.getJob(job.id)).snapshot.settings.creativeBrief).toBe(next.creativeBrief);
    expect((await store.completeJob(job.id, chapterResult(p, job, audio.url), owner!.leaseToken)).outputRevision).toBe(null);
    expect((await store.getProject(p.id)).chapterVideos!.b.current).toBe(true);
    await store.deleteProject(p.id);
  });
  it('freezes chapter-owned settings and allows independent chapters to queue while deduplicating one chapter', async () => {
    const a = SettingsSchema.parse({ resolution: '720p', voice: 'zh-CN-XiaoxiaoNeural', creationMode: 'creative', model: 'model-a', theme: 'ocean', stylePrompt: '蓝色几何图解' });
    const b = SettingsSchema.parse({ resolution: '1080p', voice: 'zh-CN-YunxiNeural', model: 'model-b', theme: 'sunset' });
    let p = await store.createProject({ title: '独立章节', chapters: [{ id: 'a', title: 'A', markdown: '# A\n\n正文A', settings: a }, { id: 'b', title: 'B', markdown: '# B\n\n正文B', settings: b }] });
    const ja = await store.submitJob(p.id, { kind: 'preview', chapterId: 'a', expectedRevision: p.revision }, 'chapter-a-key');
    const duplicate = await store.submitJob(p.id, { kind: 'preview', chapterId: 'a', expectedRevision: p.revision }, 'chapter-a-key'); expect(duplicate.id).toBe(ja.id);
    await expect(store.submitJob(p.id, { kind: 'preview', chapterId: 'a', expectedRevision: p.revision })).rejects.toThrow('任务正在执行');
    const jb = await store.submitJob(p.id, { kind: 'preview', chapterId: 'b', expectedRevision: p.revision });
    expect(ja.snapshot.settings).toEqual(a); expect(jb.snapshot.settings).toEqual(b); expect(ja.snapshot.chapters?.map(ch => ch.id)).toEqual(['a']); expect(ja.snapshot.context?.map(ch => ch.id)).toEqual(['a', 'b']);
    expect((await store.getProject(p.id)).chapterJobs?.a.id).toBe(ja.id); expect((await store.getProject(p.id)).chapterJobs?.b.id).toBe(jb.id);
    await store.cancelJob(jb.id);
    const claimed = await store.claimJob(ja.id); const audio = await registeredAudio(p); await store.completeJob(ja.id, chapterResult(p, ja, audio.url), claimed!.leaseToken);
    p = await store.getProject(p.id); expect(p.chapterVideos?.a.current).toBe(true); expect(p.chapterVideos?.a.renderPlan).toMatchObject({ width: 1280, height: 720, theme: 'ocean' }); expect(p.lesson).toBe(null); expect(p.renderPlan).toBe(null);
    p = await store.updateProject(p.id, { ...patch(p), chapters: p.chapters!.map(ch => ch.id === 'b' ? { ...ch, markdown: '# B\n\n修改不相关正文' } : ch) });
    expect(p.chapterVideos?.a.current).toBe(true);
    const newB = await store.submitJob(p.id, { kind: 'preview', chapterId: 'b', expectedRevision: p.revision }); const speaker = await store.claimJob(newB.id);
    await store.completeJob(newB.id, chapterResult(p, newB, audio.url), speaker!.leaseToken); p = await store.getProject(p.id);
    expect(p.chapterVideos?.a.current).toBe(true); expect(p.chapterVideos?.b.current).toBe(true); expect(p.chapterVideos?.b.renderPlan).toMatchObject({ width: 1920, height: 1080, voice: 'zh-CN-YunxiNeural' });
    await store.deleteProject(p.id);
  });
  it('publishes a running chapter despite unrelated edits, but rejects its own edits and deletion', async () => {
    let p = await store.createProject({ title: '提交竞争', chapters: [{ id: 'a', title: 'A', markdown: 'A正文' }, { id: 'b', title: 'B', markdown: 'B正文' }] });
    const first = await store.submitJob(p.id, { kind: 'preview', chapterId: 'a', expectedRevision: p.revision }); const owner = await store.claimJob(first.id); const audio = await registeredAudio(p);
    p = await store.updateProject(p.id, { ...patch(p), chapters: p.chapters!.map(ch => ch.id === 'b' ? { ...ch, markdown: 'B的新正文' } : ch) });
    expect((await store.completeJob(first.id, chapterResult(p, first, audio.url), owner!.leaseToken)).outputRevision).not.toBe(null);
    p = await store.getProject(p.id); expect(p.chapterVideos?.a.current).toBe(true); const previous = p.chapterVideos!.a;
    const second = await store.submitJob(p.id, { kind: 'preview', chapterId: 'a', expectedRevision: p.revision }); const secondOwner = await store.claimJob(second.id);
    p = await store.updateProject(p.id, { ...patch(p), chapters: p.chapters!.map(ch => ch.id === 'a' ? { ...ch, markdown: 'A的新正文' } : ch) });
    const stale = await store.completeJob(second.id, chapterResult(p, second, audio.url), secondOwner!.leaseToken); expect(stale.outputRevision).toBe(null);
    p = await store.getProject(p.id); expect(p.chapterVideos?.a.previewRevision).toBe(previous.previewRevision); expect(p.chapterVideos?.a.current).toBe(false);
    const third = await store.submitJob(p.id, { kind: 'preview', chapterId: 'a', expectedRevision: p.revision }); const thirdOwner = await store.claimJob(third.id);
    p = await store.updateProject(p.id, { ...patch(p), chapters: p.chapters!.filter(ch => ch.id !== 'a') });
    expect((await store.completeJob(third.id, chapterResult(p, third, audio.url), thirdOwner!.leaseToken)).outputRevision).toBe(null);
    await expect(store.submitJob(p.id, { kind: 'preview', chapterId: 'a', expectedRevision: p.revision })).rejects.toThrow('章节不存在');
    expect((await store.getProject(p.id)).chapterVideos?.a.current).toBe(false);
    await store.deleteProject(p.id);
  });
  it('binds export to one chapter preview, keeping the other chapter and legacy whole-course outputs separate', async () => {
    let p = await store.createProject({ title: '导出隔离', chapters: [{ id: 'a', title: 'A', markdown: 'A正文' }, { id: 'b', title: 'B', markdown: 'B正文' }] }); const audio = await registeredAudio(p);
    for (const chapterId of ['a', 'b']) {
      const job = await store.submitJob(p.id, { kind: 'preview', chapterId, expectedRevision: p.revision }); const owner = await store.claimJob(job.id);
      await store.completeJob(job.id, chapterResult(p, job, audio.url), owner!.leaseToken); p = await store.getProject(p.id);
    }
    const a = p.chapterVideos!.a; const b = p.chapterVideos!.b;
    expect(a.previewRevision).not.toBe(p.revision);
    const exported = await store.submitJob(p.id, { kind: 'export', chapterId: 'a', expectedRevision: p.revision }); const renderer = await store.claimJob(exported.id);
    expect(exported.snapshot.revision).toBe(a.previewRevision); expect(exported.inputRevision).toBe(p.revision); expect(exported.snapshot.settings).toEqual(a.settings);
    const file = path.join(dataDir, randomUUID()); await writeFile(file, 'chapter-video-fixture'); const media = await artifacts.publishFile(file, 'video/mp4', 'a.mp4', p.id);
    p = await store.updateProject(p.id, { ...patch(p), chapters: p.chapters!.map(ch => ch.id === 'b' ? { ...ch, markdown: 'B独立修改' } : ch) });
    const completed = await store.completeJob(exported.id, { lesson: a.lesson, renderPlan: a.renderPlan!, videoUrl: media.url }, renderer!.leaseToken); expect(completed.outputRevision).toBe(a.previewRevision);
    p = await store.getProject(p.id); expect(p.chapterVideos?.a.latestExport?.videoUrl).toBe(media.url); expect(p.chapterVideos?.a.current).toBe(true); expect(p.chapterVideos?.b.latestExport).toBe(null); expect(p.chapterVideos?.b.previewRevision).toBe(b.previewRevision); expect(p.latestExport).toBe(null); expect(await store.getCurrentExport(p.id, a.previewRevision)).toBe(null);
    await rm(media.path); expect((await store.getProject(p.id)).chapterVideos?.a.latestExport).toBe(null);
    const retry = await store.submitJob(p.id, { kind: 'export', chapterId: 'a', expectedRevision: p.revision }); await store.cancelJob(retry.id);
    await store.deleteProject(p.id);
  });
  it('allows creative-to-stable recompilation while preventing stable jobs from executing old custom code', async () => {
    let p = await store.createProject({ title: '模式切换', chapters: [{ id: 'a', title: 'A', markdown: 'A正文', settings: SettingsSchema.parse({ creationMode: 'creative' }) }] });
    const custom: Lesson = { ...lesson, scenes: lesson.scenes.map(scene => ({ ...scene, objects: scene.objects.map(object => ({ ...object, type: 'custom' as const, content: 'return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1104 286"><rect width="100" height="100" fill="#567c44"/></svg>`;' })) })) };
    const first = await store.submitJob(p.id, { kind: 'preview', chapterId: 'a', expectedRevision: p.revision }); const owner = await store.claimJob(first.id); const audio = await registeredAudio(p);
    await store.completeJob(first.id, chapterResult(p, first, audio.url, custom), owner!.leaseToken); p = await store.getProject(p.id);
    p = await store.updateProject(p.id, { ...patch(p), chapters: p.chapters!.map(ch => ({ ...ch, settings: SettingsSchema.parse({ creationMode: 'stable' }) })) });
    await expect(store.submitJob(p.id, { kind: 'speech', chapterId: 'a', expectedRevision: p.revision })).rejects.toThrow('稳定模式');
    const rebuilt = await store.submitJob(p.id, { kind: 'preview', chapterId: 'a', expectedRevision: p.revision }); const stable = await store.claimJob(rebuilt.id);
    await expect(store.completeJob(rebuilt.id, chapterResult(p, rebuilt, audio.url, custom), stable!.leaseToken)).rejects.toThrow('稳定模式');
    await store.completeJob(rebuilt.id, chapterResult(p, rebuilt, audio.url), stable!.leaseToken); p = await store.getProject(p.id); expect(p.chapterVideos?.a.current).toBe(true); expect(p.chapterVideos?.a.settings.creationMode).toBe('stable');
    await store.deleteProject(p.id);
  });
  it('binds chapter previews to their exact style, resolution, voice and palette before publication or export', async () => {
    let p = await store.createProject({ title: '绑定画面参数', chapters: [{ id: 'a', title: 'A', markdown: 'A正文', settings: SettingsSchema.parse({ theme: 'ocean', resolution: '1080p', voice: 'zh-CN-YunxiNeural' }) }] });
    const job = await store.submitJob(p.id, { kind: 'preview', chapterId: 'a', expectedRevision: p.revision }); const owner = await store.claimJob(job.id); const audio = await registeredAudio(p);
    const palette = { background: '#eef4fa', surface: '#ffffff', text: '#15304a', muted: '#566b80', accent: '#2473b6' };
    const payload = chapterResult(p, job, audio.url, { ...lesson, palette }); payload.renderPlan.palette = palette;
    const missingVoice = { ...payload.renderPlan }; delete missingVoice.voice;
    const variants: RenderPlan[] = [{ ...payload.renderPlan, theme: 'sage' }, { ...payload.renderPlan, width: 1280, height: 720 }, { ...payload.renderPlan, voice: 'zh-CN-XiaoxiaoNeural' }, { ...payload.renderPlan, rate: 20 }, missingVoice, { ...payload.renderPlan, palette: { ...palette, accent: '#111111' } }];
    for (const renderPlan of variants) await expect(store.completeJob(job.id, { lesson: payload.lesson, renderPlan }, owner!.leaseToken)).rejects.toThrow('真实配音');
    await store.completeJob(job.id, payload, owner!.leaseToken); p = await store.getProject(p.id); expect(p.chapterVideos?.a.current).toBe(true);
    const composed = await store.submitJob(p.id, { kind: 'compose', chapterId: 'a', expectedRevision: p.revision }); const composer = await store.claimJob(composed.id);
    await store.completeJob(composed.id, { lesson: { ...payload.lesson, palette: { ...palette, accent: '#cd5533' } } }, composer!.leaseToken);
    p = await store.getProject(p.id); expect(p.chapterVideos?.a.current).toBe(false);
    await expect(store.submitJob(p.id, { kind: 'export', chapterId: 'a', expectedRevision: p.revision })).rejects.toThrow('真实配音');
    await store.deleteProject(p.id);
  });
});
