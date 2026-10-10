/**
 * Read a saved export snapshot and compare short frame ranges without publishing
 * artifacts or updating jobs. Example (run after user exports have completed):
 * npx tsx --env-file-if-exists=.env scripts/benchmark-export.ts --job <uuid> \
 *   --start 14353 --frames 600 --concurrency 2,5 --gl swangle,default
 * Add --dry-run to inspect the cases without opening Chromium or writing files.
 */
import { bundle } from '@remotion/bundler';
import { makeCancelSignal, renderMedia, selectComposition, type RenderMediaProgress } from '@remotion/renderer';
import { createReadStream } from 'node:fs';
import { mkdir, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { parseArgs } from 'node:util';
import { closeDb, getPool } from '../src/server/db';
import { parseRange } from '../src/server/artifacts';
import type { JobRecord } from '../src/shared/schema';
import { replaceAssetUrls } from '../src/video/timeline';

const { values } = parseArgs({ options: {
  job: { type: 'string' }, start: { type: 'string', default: '0' },
  frames: { type: 'string', default: '300' }, concurrency: { type: 'string', default: '2,5' },
  gl: { type: 'string', default: 'swangle,default' }, repeats: { type: 'string', default: '1' },
  output: { type: 'string' }, 'dry-run': { type: 'boolean', default: false },
} });

function integer(value: string | undefined, label: string, min: number, max: number) {
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < min || result > max) throw new Error(`${label} must be ${min}–${max}`);
  return result;
}

async function assertNoExportRunning() {
  const active = await getPool().query("SELECT id FROM jobs WHERE data->>'kind' = 'export' AND data->>'status' IN ('queued', 'running', 'cancelling')");
  if (active.rowCount) throw new Error('An export is queued or running. Wait for it to finish before benchmarking.');
}

async function main() {
  if (!values.job || !/^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i.test(values.job)) throw new Error('--job must be a saved job UUID');
  const start = integer(values.start, '--start', 0, Number.MAX_SAFE_INTEGER);
  const frameCount = integer(values.frames, '--frames', 1, 1200);
  const repeats = integer(values.repeats, '--repeats', 1, 5);
  const concurrency = values.concurrency!.split(',').map(value => integer(value, '--concurrency', 1, os.availableParallelism()));
  const glValues = values.gl!.split(',').map(value => {
    if (value !== 'default' && value !== 'swangle') throw new Error('--gl supports default,swangle');
    return value;
  });
  const result = await getPool().query<{ data: JobRecord }>('SELECT data FROM jobs WHERE id=$1', [values.job]);
  const job = result.rows[0]?.data;
  const plan = job?.snapshot.renderPlan;
  if (!job || !plan) throw new Error('The saved job has no render plan');
  if (plan.previewMode === 'draft' || plan.previewMode === 'partial' || plan.scenes.some(scene => scene.utterances.some(clip => clip.estimated || !clip.url))) throw new Error('Only fully voiced render plans can be benchmarked');
  const end = start + frameCount - 1;
  if (end >= plan.totalFrames) throw new Error('Frame range exceeds the saved render plan');
  const cases = Array.from({ length: repeats }, (_, repeat) => glValues.flatMap(gl => concurrency.map(threads => ({ repeat: repeat + 1, gl, concurrency: threads })))).flat();
  const output = path.resolve(values.output || `.data/verification/export-benchmark-${new Date().toISOString().replace(/[:.]/g, '-')}`);
  const report = {
    jobId: job.id, inputRevision: job.inputRevision, createdAt: new Date().toISOString(),
    machine: { platform: process.platform, arch: process.arch, cpus: os.availableParallelism(), totalMemoryGiB: os.totalmem() / 1024 ** 3 },
    source: { width: plan.width, height: plan.height, fps: plan.fps, totalFrames: plan.totalFrames, frameRange: [start, end], frameCount },
    bundleMs: 0, cases,
    results: [] as Array<Record<string, unknown>>,
  };
  console.log(JSON.stringify({ ...report, output }, null, 2));
  if (values['dry-run']) return;
  await assertNoExportRunning();

  // Read artifact rows directly: artifactRecord() also initializes/migrates the DB.
  const assets = job.snapshot.assets;
  const urls = [...assets.map(asset => asset.url), ...plan.scenes.flatMap(scene => scene.utterances.map(clip => clip.url)), ...(plan.narrationAudio ? [plan.narrationAudio.url] : [])];
  const files = new Map<string, { path: string; mime: string; size: number }>();
  const artifactRoot = await realpath(path.resolve(process.env.OPENTUTOR_DATA_DIR || process.env.DATA_DIR || '.data', 'artifacts'));
  for (const url of new Set(urls)) {
    const id = url.split('/').at(-1)!;
    const file = (await getPool().query<{ path: string; mime: string }>('SELECT path,mime FROM artifacts WHERE id=$1 AND (project_id=$2 OR project_id IS NULL)', [id, job.projectId])).rows[0];
    if (!file) throw new Error(`Missing artifact ${id}`);
    const resolved = await realpath(file.path);
    if (!resolved.startsWith(`${artifactRoot}${path.sep}`)) throw new Error('Artifact is outside the artifact directory');
    files.set(id, { path: resolved, mime: file.mime, size: (await stat(resolved)).size });
  }
  const server = createServer((req, res) => {
    const file = files.get(req.url?.split('?')[0].slice(1) || '');
    if (!file) { res.writeHead(404).end(); return; }
    try {
      const range = parseRange(req.headers.range || null, file.size);
      const first = range?.start ?? 0, last = range?.end ?? file.size - 1;
      res.writeHead(range ? 206 : 200, { 'Content-Type': file.mime, 'Content-Length': last - first + 1, 'Accept-Ranges': 'bytes', 'Access-Control-Allow-Origin': '*', ...(range ? { 'Content-Range': `bytes ${first}-${last}/${file.size}` } : {}) });
      const stream = createReadStream(file.path, { start: first, end: last });
      stream.on('error', () => res.destroy());
      res.on('close', () => stream.destroy());
      stream.pipe(res);
    } catch { res.writeHead(416, { 'Content-Range': `bytes */${file.size}` }).end(); }
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  let serveUrl: string | undefined;
  const cancel = makeCancelSignal();
  let interrupted = false;
  const abort = () => { interrupted = true; cancel.cancel(); };
  process.once('SIGINT', abort);
  process.once('SIGTERM', abort);
  try {
    await mkdir(output, { recursive: true });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Media server did not start');
    const inputProps = replaceAssetUrls(plan, assets, url => `http://127.0.0.1:${address.port}/${url.split('/').at(-1)}`);
    const bundling = performance.now();
    serveUrl = await bundle({ entryPoint: path.resolve('src/video/entry.tsx') });
    report.bundleMs = performance.now() - bundling;
    for (const entry of cases) {
      if (interrupted) break;
      await assertNoExportRunning();
      const label = `${entry.gl}-c${entry.concurrency}-r${entry.repeat}`;
      const chromiumOptions = { gl: entry.gl === 'default' ? null : 'swangle' as const };
      const outputLocation = path.join(output, `${label}.mp4`);
      const started = performance.now();
      const samples: Array<RenderMediaProgress & { elapsedMs: number }> = [];
      let lastSample = -Infinity;
      let finalProgress: RenderMediaProgress | undefined;
      try {
        const composition = await selectComposition({ serveUrl, id: 'OpenTutorLesson', inputProps, chromiumOptions });
        const compositionMs = performance.now() - started;
        await renderMedia({
          serveUrl, composition, inputProps, chromiumOptions, frameRange: [start, end],
          codec: 'h264', pixelFormat: 'yuv420p', outputLocation, concurrency: entry.concurrency,
          cancelSignal: cancel.cancelSignal,
          onProgress: progress => {
            finalProgress = progress;
            const elapsedMs = performance.now() - started;
            if (elapsedMs - lastSample < 2000 && progress.progress !== 1) return;
            lastSample = elapsedMs;
            samples.push({ ...progress, elapsedMs });
            console.log(JSON.stringify({ label, elapsedMs: Math.round(elapsedMs), renderedFrames: progress.renderedFrames, weightedProgress: progress.progress }));
          },
        });
        const elapsedMs = performance.now() - started;
        const bytes = (await stat(outputLocation)).size;
        report.results.push({ ...entry, status: 'succeeded', elapsedMs, compositionMs, renderAndEncodeMs: elapsedMs - compositionMs, effectiveFramesPerSecond: frameCount / (elapsedMs / 1000), bytes, outputLocation, finalProgress, samples });
      } catch (error) {
        report.results.push({ ...entry, status: 'failed', elapsedMs: performance.now() - started, error: error instanceof Error ? error.message : String(error), finalProgress, samples });
      }
      await writeFile(path.join(output, 'results.json'), JSON.stringify(report, null, 2));
    }
  } finally {
    process.removeListener('SIGINT', abort);
    process.removeListener('SIGTERM', abort);
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    if (serveUrl) await rm(serveUrl, { recursive: true, force: true });
  }
  if (interrupted || report.results.some(result => result.status === 'failed')) process.exitCode = 1;
  console.log(JSON.stringify({ report: path.join(output, 'results.json'), results: report.results.map(({ samples, ...result }) => result) }, null, 2));
}

main().catch(error => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; }).finally(closeDb);
