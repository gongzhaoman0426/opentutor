import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import type { JobRecord, Project } from '../src/shared/schema';

// Deliberately uses the real Codex model, Microsoft speech, and MP4 renderer.
const base = process.env.OPENTUTOR_BASE_URL || 'http://127.0.0.1:3330';
const directory = '.data/verification';
const auth: Record<string, string> = process.env.AUTH_TOKEN ? { Authorization: `Bearer ${process.env.AUTH_TOKEN}` } : {};
async function api<T>(route: string, method = 'GET', body?: unknown): Promise<T> {
  const response = await fetch(base + route, { method, headers: { ...auth, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(30000) });
  const value = await response.json(); if (!response.ok) throw new Error(value.error?.message || `HTTP ${response.status}`); return value as T;
}
async function run(project: Project, chapterId: string, kind: 'preview' | 'export') {
  const { job } = await api<{ job: JobRecord }>(`/api/projects/${project.id}/jobs`, 'POST', { kind, chapterId, expectedRevision: project.revision });
  let previous = ''; const deadline = Date.now() + 900000;
  while (Date.now() < deadline) {
    const { job: state } = await api<{ job: JobRecord }>(`/api/jobs/${job.id}`);
    const summary = `${chapterId} ${kind} ${state.status} ${state.stage} ${state.completed}/${state.total}`;
    if (summary !== previous) { console.log(summary); previous = summary; }
    if (state.status === 'succeeded') return { project: (await api<{ project: Project }>(`/api/projects/${project.id}`)).project, job: state };
    if (state.status === 'failed' || state.status === 'cancelled') throw new Error(state.error || state.status);
    await new Promise(resolve => setTimeout(resolve, 2000));
  }
  throw new Error('Smoke task timed out');
}
let project: Project | undefined;
await mkdir(directory, { recursive: true });
try {
  const catalog = await api<{ models: { id: string; isDefault: boolean }[] }>('/api/models');
  const model = catalog.models.find(item => item.isDefault)?.id || '';
  assert(model, 'Real Codex catalog must provide a default model for this verification');
  project = (await api<{ project: Project }>('/api/projects', 'POST', { title: '[验证] 章节参数与创作组件', chapters: [
    { id: 'motion', title: '圆周运动', markdown: '物体沿圆周运动时，到圆心的距离始终等于半径。请用一幅持续运动的示意图直观解释，只讲这个概念，讲稿控制在两三句话。', settings: { model, creationMode: 'creative', theme: 'ink', resolution: '720p', voice: 'zh-CN-XiaoxiaoNeural', stylePrompt: '深海蓝背景（#071d32），青色动态图形，简洁科技课堂。请为圆周运动编写自定义动态组件。' } },
    { id: 'radius', title: '认识半径', markdown: '半径是圆心到圆周上任意一点的距离。只用一句话和简单预设组件讲解。', settings: { model, creationMode: 'stable', theme: 'sunset', resolution: '1080p', voice: 'zh-CN-YunxiNeural', stylePrompt: '暖纸色与陶橙，简洁清楚。' } },
  ] })).project;
  console.log('validation project', project.id);
  await writeFile(`${directory}/chapter-settings-current.json`, JSON.stringify({ projectId: project.id }));
  const first = await run(project, 'motion', 'preview'); project = first.project;
  const motion = project.chapterVideos?.motion;
  assert(motion?.renderPlan?.narrationAudio?.url); assert(motion.lesson.scenes.every(scene => scene.chapterId === 'motion'));
  assert(motion.lesson.scenes.some(scene => scene.objects.some(object => object.type === 'custom')));
  assert(motion.lesson.palette); assert.equal(motion.renderPlan.width, 1280); assert.equal(first.job.videoUrl, null);
  const key = motion.sourceKey;
  project = (await api<{ project: Project }>(`/api/projects/${project.id}`, 'PATCH', { ...project, expectedRevision: project.revision, chapters: project.chapters!.map(chapter => chapter.id === 'radius' ? { ...chapter, markdown: chapter.markdown + '\n\n同一个圆的所有半径相等。' } : chapter) })).project;
  assert.equal(project.chapterVideos?.motion.sourceKey, key); assert.equal(project.chapterVideos?.motion.current, true);
  const second = await run(project, 'radius', 'preview'); project = second.project;
  const radius = project.chapterVideos?.radius;
  assert(radius?.renderPlan?.narrationAudio?.url); assert(radius.lesson.scenes.every(scene => scene.chapterId === 'radius'));
  assert(radius.lesson.scenes.every(scene => scene.objects.every(object => object.type !== 'custom')));
  assert.equal(radius.renderPlan.width, 1920); assert.equal(radius.renderPlan.voice, 'zh-CN-YunxiNeural');
  assert.equal(project.chapterVideos?.motion.sourceKey, key); assert.equal(project.chapterVideos?.motion.current, true);
  const exported = await run(project, 'motion', 'export'); project = exported.project;
  assert(exported.job.videoUrl); assert.equal(project.chapterVideos?.motion.latestExport?.videoUrl, exported.job.videoUrl);
  assert.equal(project.chapterVideos?.radius.latestExport, null);
  const response = await fetch(base + exported.job.videoUrl, { headers: auth, signal: AbortSignal.timeout(60000) }); assert.equal(response.status, 200);
  const localVideo = `${directory}/chapter-settings-creative.mp4`; await writeFile(localVideo, Buffer.from(await response.arrayBuffer()));
  const report = { projectId: project.id, model, chapterIds: Object.keys(project.chapterVideos || {}), previewJobs: [first.job.id, second.job.id], exportJob: exported.job.id, localVideo, creativeScenes: motion.lesson.scenes.length, customObjects: motion.lesson.scenes.flatMap(scene => scene.objects).filter(object => object.type === 'custom').length, creativeSeconds: motion.renderPlan.totalFrames / motion.renderPlan.fps, stableScenes: radius.lesson.scenes.length, palette: motion.lesson.palette, checks: ['real-selected-model', 'chapter-isolation', 'unrelated-edit-preserves-video', 'real-creative-code-generation', 'stable-presets-only', 'chapter-voice-and-resolution', 'preview-without-mp4', 'independent-chapter-export'], chapterVideos: project.chapterVideos };
  await writeFile(`${directory}/chapter-settings-report.json`, JSON.stringify(report, null, 2));
  console.log('all checks passed', JSON.stringify({ customObjects: report.customObjects, creativeSeconds: report.creativeSeconds, localVideo }));
} finally {
  if (project && process.env.KEEP_SMOKE_PROJECT !== '1') await api(`/api/projects/${project.id}`, 'DELETE');
}
