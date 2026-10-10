import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { artifactRecord, parseRange } from './artifacts';
import { AppError } from './errors';

export async function serveArtifact(request: Request, id: string, download = false) {
  const artifact = await artifactRecord(id); const info = await stat(artifact.path);
  const headers = new Headers({ 'Content-Type': artifact.mime, 'Accept-Ranges': 'bytes', 'Cache-Control': 'private, max-age=3600', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; sandbox", 'Content-Disposition': `${download || new URL(request.url).searchParams.has('download') ? 'attachment' : 'inline'}; filename*=UTF-8''${encodeURIComponent(artifact.name)}` });
  let range;
  try { range = parseRange(request.headers.get('range'), info.size); }
  catch (error) { if (error instanceof AppError && error.status === 416) return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${info.size}` } }); throw error; }
  const start = range?.start || 0; const end = range?.end ?? info.size - 1;
  headers.set('Content-Length', String(Math.max(0, end - start + 1)));
  if (range) headers.set('Content-Range', `bytes ${start}-${end}/${info.size}`);
  if (!info.size) return new Response(null, { headers });
  const file = createReadStream(artifact.path, { start, end });
  request.signal.addEventListener('abort', () => file.destroy(), { once: true });
  return new Response(Readable.toWeb(file) as ReadableStream<Uint8Array>, { status: range ? 206 : 200, headers });
}
