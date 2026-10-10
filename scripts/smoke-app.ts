import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { cacheDirectory } from '../src/server/artifacts';
import type { JobRecord, Project } from '../src/shared/schema';

const base = process.env.OPENTUTOR_BASE_URL || 'http://127.0.0.1:3330';
const headers: Record<string, string> = { 'Content-Type': 'application/json', ...(process.env.AUTH_TOKEN ? { Authorization: `Bearer ${process.env.AUTH_TOKEN}` } : {}) };
async function request<T>(route: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${base}${route}`, { ...init, headers: { ...headers, ...init?.headers }, signal: AbortSignal.timeout(60000) });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error?.message || `HTTP ${response.status}`);
  return body as T;
}
const { project } = await request<{ project: Project }>('/api/projects', { method: 'POST', body: JSON.stringify({ title: '验证课程 · 勾股定理', markdown: '# 勾股定理\n\n直角三角形中，两条直角边的平方和等于斜边的平方。当直角边为 3 和 4 时，斜边为 5，因为 3² + 4² = 25，而 5² = 25。' }) });
const { job } = await request<{ job: JobRecord }>(`/api/projects/${project.id}/jobs`, { method: 'POST', headers: { 'Idempotency-Key': crypto.randomUUID() }, body: JSON.stringify({ kind: 'generate', expectedRevision: project.revision }) });
const ids = { projectId: project.id, jobId: job.id };
await writeFile(path.join(cacheDirectory('verification'), 'app-smoke.json'), JSON.stringify(ids));
console.log('Submitted real end-to-end generation', ids);
let last = '';
const deadline = Date.now() + 900000;
while (Date.now() < deadline) {
  const { job: current } = await request<{ job: JobRecord }>(`/api/jobs/${job.id}`);
  const progress = `${current.status} ${current.stage} ${current.completed}/${current.total}`;
  if (progress !== last) { console.log(progress); last = progress; }
  if (current.status === 'succeeded') {
    const { project: finished } = await request<{ project: Project }>(`/api/projects/${project.id}`);
    console.log(JSON.stringify({ ...ids, revision: finished.revision, scenes: finished.lesson?.scenes.length, frames: finished.renderPlan?.totalFrames, videoUrl: current.videoUrl, subtitleUrl: current.subtitleUrl, diagnostics: current.diagnostics.map(d => d.code) }));
    process.exit(0);
  }
  if (current.status === 'failed' || current.status === 'cancelled') throw new Error(current.error || 'Generation was cancelled');
  await new Promise(resolve => setTimeout(resolve, 2000));
}
throw new Error('End-to-end generation exceeded verification deadline. Inspect saved job ID; task was not silently cancelled.');
