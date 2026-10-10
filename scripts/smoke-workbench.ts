import assert from 'node:assert/strict';
import { parseSource } from '../src/shared/source';
import type { JobKind, JobRecord, Lesson, Project } from '../src/shared/schema';

const base = process.env.OPENTUTOR_BASE_URL || 'http://127.0.0.1:3330';
const headers = { 'Content-Type': 'application/json', ...(process.env.AUTH_TOKEN ? { Authorization: `Bearer ${process.env.AUTH_TOKEN}` } : {}) };
async function api<T>(route: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`${base}${route}`, { ...init, headers: { ...headers, ...init.headers }, signal: AbortSignal.timeout(30000) });
  const value = await response.json();
  if (!response.ok) throw new Error(value.error?.message || `HTTP ${response.status}`);
  return value as T;
}
async function run(project: Project, kind: JobKind): Promise<{ project: Project; job: JobRecord }> {
  const { job } = await api<{ job: JobRecord }>(`/api/projects/${project.id}/jobs`, { method: 'POST', body: JSON.stringify({ kind, expectedRevision: project.revision }) });
  const deadline = Date.now() + 240000;
  while (Date.now() < deadline) {
    const { job: next } = await api<{ job: JobRecord }>(`/api/jobs/${job.id}`);
    if (next.status === 'succeeded') return { ...(await api<{ project: Project }>(`/api/projects/${project.id}`)), job: next };
    if (['failed', 'cancelled'].includes(next.status)) throw new Error(next.error || '任务取消');
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  throw new Error('阶段验证超时');
}

// Real provider check. Compiler caches are scoped to the test course, so the
// initial compose may call Codex even when these notes were generated elsewhere.
const { projects } = await api<{ projects: Project[] }>('/api/projects');
const source = projects.find(p => p.title === '验证课程 · 勾股定理' && p.lesson);
if (!source) throw new Error('请先运行原始端到端验证，建立已校验的勾股定理课程与 Codex 缓存。');
let testProject: Project | null = null;
try {
  const created = await api<{ project: Project }>('/api/projects', { method: 'POST', body: JSON.stringify({ title: '[验证] 分阶段工作台', markdown: source.markdown, settings: source.settings, assets: source.assets }) });
  testProject = created.project;
  const composed = await run(testProject, 'compose'); testProject = composed.project;
  assert(testProject.lesson && !testProject.renderPlan);
  assert.equal(composed.job.videoUrl, null);
  assert(composed.job.preview?.lesson);
  console.log('compose: saved editable IR without synthesizing or rendering');

  // Explicit author edit between stages; the live pipeline receives the saved representation.
  const edited: Lesson = { schemaVersion: '0.1', title: '勾股定理', objectives: ['理解平方之间的关系'], scenes: [{ id: 'controlled-scene', title: '由两条直角边求斜边', chapter: '勾股定理', layout: 'content', sourceBlockIds: parseSource(source.markdown, source.assets).blocks.map(b => b.id), objects: [{ id: 'formula', type: 'formula', content: '3^2 + 4^2 = 5^2', language: '' }, { id: 'rule', type: 'text', content: '直角三角形中，两条直角边的平方和等于斜边的平方。', language: '' }], narration: [{ id: 'controlled-speech', text: '直角三角形，三平方加四平方，等于五平方。', showObjectIds: ['formula', 'rule'], focusObjectId: 'formula' }] }] };
  const saved = await api<{ project: Project }>(`/api/projects/${testProject.id}`, { method: 'PATCH', body: JSON.stringify({ expectedRevision: testProject.revision, title: testProject.title, markdown: testProject.markdown, settings: testProject.settings, assets: testProject.assets, lesson: edited }) });
  testProject = saved.project;
  const spoken = await run(testProject, 'speech'); testProject = spoken.project;
  assert.equal(spoken.job.videoUrl, null);
  assert(spoken.job.subtitleUrl);
  assert.equal(testProject.renderPlan?.previewMode, 'aligned');
  assert(testProject.renderPlan?.narrationAudio?.url);
  assert(Math.abs(testProject.renderPlan.narrationAudio.durationSeconds - testProject.renderPlan.totalFrames / testProject.renderPlan.fps) < 0.001);
  assert.equal(testProject.lesson?.scenes[0].id, 'controlled-scene');
  assert(testProject.renderPlan?.scenes.every(s => s.utterances.every(u => !u.estimated && u.url)));
  console.log('speech: real Microsoft voice, continuous PCM track and aligned preview, no MP4 render');
  const frozenRevision = testProject.revision;
  const exported = await run(testProject, 'export'); testProject = exported.project;
  assert.equal(testProject.revision, frozenRevision);
  assert(exported.job.videoUrl);
  const download = await fetch(`${base}${exported.job.videoUrl}`, { headers: { ...headers, Range: 'bytes=0-63' } });
  assert.equal(download.status, 206);
  assert.equal(download.headers.get('content-type'), 'video/mp4');
  assert.equal((await download.arrayBuffer()).byteLength, 64);
  console.log('export: rendered the frozen edited representation, downloadable H.264/AAC MP4');
} finally {
  if (testProject) await api(`/api/projects/${testProject.id}`, { method: 'DELETE' });
}
