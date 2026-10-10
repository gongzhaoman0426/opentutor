import { bundle } from '@remotion/bundler';
import { makeCancelSignal, renderMedia, selectComposition } from '@remotion/renderer';
import { createServer, type Server } from 'node:http';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import type { Asset, RenderPlan } from '../shared/schema';
import type { RenderProgress } from '../shared/render-progress';
import { replaceAssetUrls } from './timeline';
import { renderChromiumOptions, renderConcurrency } from './render-config';
export { buildRenderPlan, toSrt } from './timeline';

let bundlePromise: Promise<string> | undefined;
export async function renderVideo(plan: RenderPlan, assets: Asset[], outputPath: string, signal: AbortSignal, onProgress?: (value: number, detail?: RenderProgress) => void): Promise<void> {
  signal.throwIfAborted();
  if (plan.previewMode === 'draft' || plan.previewMode === 'partial' || plan.scenes.some(s => s.utterances.some(u => u.estimated || !u.url))) throw new Error('草稿或部分配音仅用于工作台预览，请先完成配音再渲染成片。');
  const startedAt = Date.now();
  const concurrency = renderConcurrency();
  const chromiumOptions = renderChromiumOptions();
  onProgress?.(0, { phase: 'preparing', renderedFrames: 0, totalFrames: plan.totalFrames, elapsedMs: 0 });
  const { artifactRecord, parseRange } = await import('../server/artifacts');
  const files = new Map<string, { path: string; mime: string }>();
  for (const url of new Set([...assets.map(a => a.url), ...plan.scenes.flatMap(s => s.utterances.map(u => u.url)), ...(plan.narrationAudio ? [plan.narrationAudio.url] : [])])) {
    const id = url.split('/').at(-1) ?? '';
    const artifact = await artifactRecord(id);
    files.set(id, { path: artifact.path, mime: artifact.mime });
  }
  const server = createServer(async (req, res) => {
    const id = req.url?.split('?')[0].slice(1) ?? '';
    const file = files.get(id);
    if (!file) { res.writeHead(404).end(); return; }
    try {
      const info = await stat(file.path);
      const range = parseRange(req.headers.range ?? null, info.size);
      const start = range?.start ?? 0;
      const end = range?.end ?? info.size - 1;
      if (start > end || start >= info.size) { res.writeHead(416, { 'Content-Range': `bytes */${info.size}` }).end(); return; }
      res.writeHead(range ? 206 : 200, { 'Content-Type': file.mime, 'Content-Length': end - start + 1, 'Accept-Ranges': 'bytes', 'Access-Control-Allow-Origin': '*', ...(range ? { 'Content-Range': `bytes ${start}-${end}/${info.size}` } : {}) });
      createReadStream(file.path, { start, end }).pipe(res);
    } catch { res.writeHead(500).end(); }
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('媒体服务启动失败');
  const props = replaceAssetUrls(plan, assets, url => `http://127.0.0.1:${address.port}/${url.split('/').at(-1)}`);
  const cancel = makeCancelSignal();
  const abort = () => cancel.cancel();
  signal.addEventListener('abort', abort, { once: true });
  try {
    bundlePromise ??= bundle({ entryPoint: path.resolve('src/video/entry.tsx'), onProgress: () => signal.throwIfAborted() }).catch(error => { bundlePromise = undefined; throw error; });
    const serveUrl = await bundlePromise;
    signal.throwIfAborted();
    const composition = await selectComposition({ serveUrl, id: 'OpenTutorLesson', inputProps: props, chromiumOptions });
    const renderStartedAt = Date.now();
    await renderMedia({
      serveUrl, composition, inputProps: props, codec: 'h264', outputLocation: outputPath,
      pixelFormat: 'yuv420p', concurrency, cancelSignal: cancel.cancelSignal,
      onProgress: p => {
        const renderElapsedMs = p.renderedDoneIn ?? Date.now() - renderStartedAt;
        onProgress?.(p.progress, {
          phase: p.renderedFrames < plan.totalFrames ? 'rendering' : p.stitchStage,
          renderedFrames: p.renderedFrames, totalFrames: plan.totalFrames, elapsedMs: Date.now() - startedAt,
          ...(p.renderedFrames > 0 && renderElapsedMs > 0 ? { framesPerSecond: p.renderedFrames * 1000 / renderElapsedMs } : {}),
        });
      },
      chromiumOptions,
    });
    signal.throwIfAborted();
  } finally {
    signal.removeEventListener('abort', abort);
    await closeServer(server);
  }
}
function closeServer(server: Server): Promise<void> {
  server.closeAllConnections();
  return new Promise(resolve => server.close(() => resolve()));
}
