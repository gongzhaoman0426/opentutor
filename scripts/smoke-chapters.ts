import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { cacheDirectory } from '../src/server/artifacts';
import type { Asset, JobKind, JobRecord, Project } from '../src/shared/schema';

// Real Codex + Microsoft Edge TTS + MP4 verification. No model or speech mocks.
const base = process.env.OPENTUTOR_BASE_URL || 'http://127.0.0.1:3330';
const auth: Record<string, string> = process.env.AUTH_TOKEN ? { Authorization: `Bearer ${process.env.AUTH_TOKEN}` } : {};
const directory = cacheDirectory('verification');
async function api<T>(route: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  for (const [key, value] of Object.entries(auth)) headers.set(key, value);
  if (!(init.body instanceof FormData)) headers.set('Content-Type', 'application/json');
  const response = await fetch(base + route, { ...init, headers, signal: AbortSignal.timeout(30000) });
  const value = await response.json();
  if (!response.ok) throw new Error(value.error?.message || `HTTP ${response.status}`);
  return value as T;
}
async function run(project: Project, kind: JobKind) {
  const { job } = await api<{ job: JobRecord }>(`/api/projects/${project.id}/jobs`, { method: 'POST', body: JSON.stringify({ kind, expectedRevision: project.revision }) });
  const deadline = Date.now() + 900000;
  let state = '';
  while (Date.now() < deadline) {
    const { job: current } = await api<{ job: JobRecord }>(`/api/jobs/${job.id}`);
    const next = `${current.status}: ${current.stage} ${current.completed}/${current.total}`;
    if (state !== next) { state = next; console.log(kind, next); }
    if (current.status === 'succeeded') return { project: (await api<{ project: Project }>(`/api/projects/${project.id}`)).project, job: current };
    if (['failed', 'cancelled'].includes(current.status)) throw new Error(current.error || current.status);
    await new Promise(resolve => setTimeout(resolve, 2000));
  }
  throw new Error(`${kind} timed out`);
}

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="960" height="540" viewBox="0 0 960 540"><rect width="960" height="540" fill="#f6f7ed"/><text x="60" y="70" font-family="Arial" font-size="36" font-weight="bold" fill="#153e32">Two trial results</text><line x1="140" y1="420" x2="820" y2="420" stroke="#153e32" stroke-width="3"/><rect x="240" y="270" width="170" height="150" rx="8" fill="#427b61"/><rect x="570" y="120" width="170" height="300" rx="8" fill="#9eb765"/><text x="325" y="248" text-anchor="middle" font-family="Arial" font-size="42" fill="#153e32">30</text><text x="655" y="100" text-anchor="middle" font-family="Arial" font-size="42" fill="#153e32">60</text><text x="325" y="468" text-anchor="middle" font-family="Arial" font-size="28" fill="#153e32">Trial A</text><text x="655" y="468" text-anchor="middle" font-family="Arial" font-size="28" fill="#153e32">Trial B</text></svg>`;
const imagePath = path.join(directory, 'chapter-vision-input.png');
const png = await sharp(Buffer.from(svg)).png().toBuffer();
await writeFile(imagePath, png);
let project: Project | null = null;
try {
  const data = new FormData(); data.append('file', new File([new Uint8Array(png)], 'trial-results.png', { type: 'image/png' }));
  const { asset } = await api<{ asset: Asset }>('/api/assets', { method: 'POST', body: data });
  assert.equal(asset.width, 960); assert.equal(asset.height, 540);
  project = (await api<{ project: Project }>('/api/projects', { method: 'POST', body: JSON.stringify({ title: '[验证] 图片读图与章节流程', assets: [asset], chapters: [
    { id: 'read-chart', title: '读图', markdown: `观察下面两次实验的柱状图，读出图上的数值，并比较哪个更高。单位和实验原因没有提供，不要推断。\n\n![实验结果图](asset://${asset.id})` },
    { id: 'compare-results', title: '比较方法', markdown: '比较两个结果时，先核对数值，再计算倍数。数值的差异不等于因果解释。' },
  ] }) })).project;
  console.log('project', project.id);
  await writeFile(path.join(directory, 'chapter-smoke-current.json'), JSON.stringify({ projectId: project.id, imagePath }));
  const generated = await run(project, 'preview'); project = generated.project;
  assert(project.lesson && project.renderPlan);
  assert.equal(generated.job.videoUrl, null);
  assert.equal(project.latestExport ?? null, null);
  assert.equal(project.renderPlan.previewMode, 'aligned');
  assert(project.renderPlan.narrationAudio?.url);
  assert(project.lesson.scenes.some(scene => scene.chapterId === 'read-chart' && scene.objects.some(object => object.type === 'image' && object.content === asset.id)));
  assert(project.lesson.scenes.some(scene => scene.chapterId === 'compare-results'));
  const narration = project.lesson.scenes.flatMap(scene => scene.narration.map(utterance => utterance.text)).join('\n');
  assert(/30|三十/.test(narration) && /60|六十/.test(narration), 'Actual image numbers must appear in the explanation; Markdown did not supply them');
  console.log('preview verified: actual image values recognized, both chapters covered, real continuous audio, no MP4');
  const revision = project.revision;
  const exported = await run(project, 'export'); project = exported.project;
  assert.equal(project.revision, revision);
  assert(exported.job.videoUrl);
  assert.equal(project.latestExport?.videoUrl, exported.job.videoUrl);
  const media = await fetch(base + exported.job.videoUrl, { headers: { ...auth, Range: 'bytes=0-63' } });
  assert.equal(media.status, 206); assert.equal(media.headers.get('content-type'), 'video/mp4');
  assert.equal((await media.arrayBuffer()).byteLength, 64);
  const fullVideo = await fetch(base + exported.job.videoUrl, { headers: auth, signal: AbortSignal.timeout(60000) });
  assert.equal(fullVideo.status, 200);
  const localVideo = path.join(directory, 'chapter-smoke.mp4');
  await writeFile(localVideo, Buffer.from(await fullVideo.arrayBuffer()));
  const report = { projectId: project.id, revision, previewJobId: generated.job.id, exportJobId: exported.job.id, image: asset, scenes: project.lesson?.scenes.length, seconds: project.renderPlan!.totalFrames / project.renderPlan!.fps, videoUrl: exported.job.videoUrl, localVideo, narration, diagnostics: generated.job.diagnostics, checks: ['actual-image-input', 'chapter-coverage', 'real-microsoft-speech', 'continuous-audio', 'preview-without-mp4', 'download-renders-frozen-preview', 'current-export-reuse', 'range-download'] };
  await writeFile(path.join(directory, 'chapter-smoke-report.json'), JSON.stringify(report, null, 2));
  console.log('export verified:', JSON.stringify({ projectId: project.id, scenes: report.scenes, seconds: report.seconds, videoUrl: report.videoUrl }));
} finally {
  if (project && process.env.KEEP_SMOKE_PROJECT !== '1') await api(`/api/projects/${project.id}`, { method: 'DELETE' });
}
