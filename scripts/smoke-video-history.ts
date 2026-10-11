import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Pool } from 'pg';
import sharp from 'sharp';
import { defaultSettings, type Lesson, type Palette, type Project, type SpeechResult } from '../src/shared/schema';
import { buildRenderPlan } from '../src/video/timeline';
import { synthesizeSpeech } from '../src/engine/speech';
import { assembleNarrationAudio } from '../src/engine/narration-audio';
import { pipelineSources, runPipeline } from '../src/engine/pipeline';
import { runProcess } from '../src/engine/process';
import { artifactRecord } from '../src/server/artifacts';
import { getPool } from '../src/server/db';
import { closeQueue } from '../src/server/queue';
import * as store from '../src/server/store';

// This is an explicitly hand-authored media fixture, never AI-generated content.
// A private schema also prevents a live Worker from claiming its outbox jobs.
const output = path.resolve('.data/verification/video-history');
const schema = `history_smoke_${randomUUID().replaceAll('-', '')}`;
const database = process.env.DATABASE_URL || 'postgresql://opentutor:opentutor@127.0.0.1:54329/opentutor';
const admin = new Pool({ connectionString: database, max: 1 });
const temporaryData = await mkdtemp(path.join(os.tmpdir(), 'opentutor-history-smoke-'));
const isolated = new URL(database); isolated.searchParams.set('options', `-c search_path=${schema}`);
process.env.DATABASE_URL = isolated.toString();
process.env.OPENTUTOR_DATA_DIR = temporaryData;
process.env.OPENTUTOR_DISABLE_DISPATCH = '1';
process.env.OPENTUTOR_QUEUE_NAME = schema;
let project: Project | undefined;
let report: Record<string, unknown> | undefined;
const signal = AbortSignal.timeout(300_000);
const oldPalette: Palette = { background: '#fff1d6', surface: '#ffe2b1', text: '#45280d', muted: '#805022', accent: '#a74108' };
const newPalette: Palette = { background: '#dff1ff', surface: '#badbfa', text: '#0f2740', muted: '#385b7d', accent: '#1253b5' };
const narratedText = '这是历史版本测试。';

async function save(project: Project, extra: Partial<Project> = {}) {
  return store.updateProject(project.id, { ...project, ...extra, expectedRevision: project.revision });
}
async function completePreview(project: Project, label: string, palette: Palette, speech: SpeechResult) {
  const job = await store.submitJob(project.id, { kind: 'preview', chapterId: 'chapter-a', expectedRevision: project.revision });
  const claimed = await store.claimJob(job.id); assert(claimed);
  const source = pipelineSources(claimed).source;
  const lesson: Lesson = { schemaVersion: '0.1', title: label, objectives: ['验证可恢复的独立视频版本'], palette,
    scenes: [{ id: 'scene', chapterId: 'chapter-a', chapter: '历史视频验证', title: label, layout: 'content', sourceBlockIds: source.blocks.map(block => block.id),
      objects: [{ id: 'label', type: 'text', content: `# ${label}`, language: '' }],
      narration: [{ id: 'line', text: narratedText, showObjectIds: ['label'], focusObjectId: 'label' }] }] };
  const renderPlan = buildRenderPlan(lesson, claimed.snapshot.settings, new Map([['scene:line', speech]]), claimed.snapshot.revision);
  renderPlan.narrationAudio = await assembleNarrationAudio(renderPlan, project.id, signal);
  await store.completeJob(job.id, { lesson, renderPlan }, claimed.leaseToken);
  return { project: await store.getProject(project.id), jobId: job.id, lesson, renderPlan };
}

try {
  await mkdir(output, { recursive: true });
  await admin.query(`CREATE SCHEMA ${schema}`);
  project = await store.createProject({ title: '[verification] history export', settings: { ...defaultSettings, resolution: '720p', theme: 'ink' },
    chapters: [{ id: 'chapter-a', title: '历史视频验证', markdown: '# 版本测试\n\n这是历史版本测试。第一版画面标记 VERSION ONE，第二版标记 VERSION TWO。' }] });
  console.log('Generating one short Microsoft speech clip');
  const speech = await synthesizeSpeech(narratedText, project.settings.voice, project.settings.rate, { ownerProjectId: project.id, signal });
  assert.equal(speech.cacheHit, false, 'An isolated cache must exercise the real free Microsoft provider');
  const first = await completePreview(project, 'VERSION ONE', oldPalette, speech); project = first.project;
  project = await save(project, { title: '[verification] autosave one' });
  project = await save(project, { title: '[verification] autosave two' });
  assert.equal((await store.listVideoVersions(project.id, 'chapter-a')).length, 1);
  const second = await completePreview(project, 'VERSION TWO', newPalette, speech); project = second.project;
  const versions = await store.listVideoVersions(project.id, 'chapter-a');
  assert.deepEqual(versions.map(version => [version.id, version.version, version.current]), [[second.jobId, 2, true], [first.jobId, 1, false]]);
  const changedSettings = { ...project.settings, resolution: '1080p' as const, voice: 'zh-CN-YunxiNeural', rate: 20 };
  project = await save(project, { settings: changedSettings, chapters: project.chapters!.map(chapter => ({ ...chapter, markdown: '# 已改稿\n\n现在的文稿与旧版完全不同。', settings: changedSettings })) });
  const before = await store.getProject(project.id);
  const old = await store.getVideoVersion(project.id, first.jobId);
  assert.equal(old.renderPlan.width, 1280); assert.equal(old.title, 'VERSION ONE');
  const queued = await store.submitVideoVersionExport(project.id, first.jobId, 'history-smoke-old-version');
  const repeated = await store.submitVideoVersionExport(project.id, first.jobId, 'history-smoke-old-version');
  assert.equal(repeated.id, queued.id);
  assert.equal(queued.videoVersionId, first.jobId);
  assert.equal(queued.snapshot.settings.resolution, '720p');
  assert.equal(queued.snapshot.settings.voice, defaultSettings.voice);
  assert.match(queued.snapshot.markdown, /VERSION ONE/);
  const claimed = await store.claimJob(queued.id); assert(claimed);
  let compilerCalls = 0; let speechCalls = 0; let lastStage = '';
  const stages: string[] = [];
  console.log(`Rendering version 1: ${(old.renderPlan.totalFrames / old.renderPlan.fps).toFixed(2)} seconds`);
  const result = await runPipeline(claimed, signal, {
    progress: async (stage, completed, total, message, detail) => {
      if (stage !== lastStage) { stages.push(stage); console.log(`Stage: ${stage}`); lastStage = stage; }
      await store.updateJobProgress(claimed.id, stage, completed, total, message, claimed.leaseToken, detail);
    },
    diagnostic: diagnostic => store.addJobDiagnostic(claimed.id, diagnostic, claimed.leaseToken),
  }, {
    compileLesson: async () => { compilerCalls++; throw new Error('Historical export must not invoke Codex'); },
    regenerateScene: async () => { compilerCalls++; throw new Error('Historical export must not regenerate a scene'); },
    synthesizeSpeech: async () => { speechCalls++; throw new Error('Historical export must reuse the frozen real audio'); },
  });
  assert(result.videoUrl && result.renderPlan);
  const finished = await store.completeJob(claimed.id, result, claimed.leaseToken);
  assert.equal(finished.status, 'succeeded');
  const after = await store.getProject(project.id);
  for (const key of ['revision', 'title', 'markdown', 'chapters', 'settings', 'chapterVideos', 'latestJob'] as const) assert.deepEqual(after[key], before[key], `Historical export changed current ${key}`);
  const afterVersions = await store.listVideoVersions(project.id, 'chapter-a');
  assert.deepEqual(afterVersions.map(version => [version.id, version.version]), [[second.jobId, 2], [first.jobId, 1]]);
  assert.equal(afterVersions.find(version => version.id === first.jobId)?.videoUrl, finished.videoUrl);
  assert.equal((await store.submitVideoVersionExport(project.id, first.jobId)).id, finished.id);
  assert.equal(compilerCalls, 0); assert.equal(speechCalls, 0);
  const video = await artifactRecord(result.videoUrl.split('/').at(-1)!);
  const mp4 = path.join(output, 'version-1.mp4'); const frame = path.join(output, 'version-1-frame.png');
  await copyFile(video.path, mp4);
  await copyFile((await artifactRecord(speech.url.split('/').at(-1)!)).path, path.join(output, 'source-narration.wav'));
  const probe = JSON.parse(await runProcess(process.env.FFPROBE_PATH || 'ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', mp4], { signal }));
  assert(probe.streams.some((stream: { codec_type: string }) => stream.codec_type === 'audio'));
  const visual = probe.streams.find((stream: { codec_type: string }) => stream.codec_type === 'video');
  assert.equal(visual.width, 1280); assert.equal(visual.height, 720);
  await runProcess(process.env.FFMPEG_PATH || 'ffmpeg', ['-v', 'error', '-y', '-ss', '0.6', '-i', mp4, '-frames:v', '1', frame], { signal });
  const pixel = await sharp(frame).extract({ left: 10, top: 10, width: 1, height: 1 }).removeAlpha().raw().toBuffer();
  const expected = [255, 241, 214];
  assert(expected.every((channel, i) => Math.abs(pixel[i] - channel) <= 8), `Export used the wrong version palette: ${[...pixel]}`);
  assert(Math.abs(pixel[0] - 223) > 20, 'The new blue version must not replace the old amber version');
  await writeFile(path.join(output, 'frozen-version-1.json'), JSON.stringify(old, null, 2));
  await writeFile(path.join(output, 'current-version-2.json'), JSON.stringify({ lesson: second.lesson, renderPlan: second.renderPlan }, null, 2));
  await writeFile(path.join(output, 'ffprobe.json'), JSON.stringify(probe, null, 2));
  report = { passed: true, fixture: 'hand-authored DSL; real free Microsoft speech and Remotion MP4', projectId: project.id, versionIds: [first.jobId, second.jobId], exportJobId: finished.id,
    audioSeconds: speech.durationSeconds, videoSeconds: Number(probe.format.duration), resolution: [visual.width, visual.height], sampledOldPalettePixel: [...pixel], compilerCalls, speechCallsDuringExport: speechCalls, stages,
    currentRevisionBefore: before.revision, currentRevisionAfter: after.revision, versionsAfterExport: afterVersions.map(version => ({ id: version.id, version: version.version, current: version.current })),
    checks: ['real-microsoft-tts', 'autosaves-do-not-create-video-versions', 'two-real-aligned-previews', 'frozen-source-and-settings', 'old-plan-real-mp4', 'old-palette-in-exported-frame', 'audio-and-video-tracks', 'current-project-unchanged', 'idempotent-export', 'existing-mp4-reused', 'zero-model-and-tts-calls-during-export'], mp4, frame };
} finally {
  if (project) {
    const jobs = await getPool().query("SELECT id FROM jobs WHERE project_id=$1 AND data->>'status' IN ('queued','running','cancelling')", [project.id]);
    for (const row of jobs.rows) await store.markJobCancelled(row.id);
    await store.deleteProject(project.id);
  }
  await closeQueue(); await store.closeDb();
  await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); await admin.end();
  await rm(temporaryData, { recursive: true, force: true });
  if (report) { report.temporaryProjectRemoved = true; report.isolatedSchemaRemoved = true; await writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2)); }
}
console.log(JSON.stringify(report));
