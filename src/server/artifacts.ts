import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { copyFile, stat, writeFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { getPool, initDb } from './db';
import { validId } from './store';
import { AppError, notFound } from './errors';

export function dataDirectory() { return path.resolve(/* turbopackIgnore: true */ process.env.OPENTUTOR_DATA_DIR || process.env.DATA_DIR || '.data'); }
export function cacheDirectory(name = 'cache') {
  if (!/^[a-zA-Z0-9_-]+$/.test(name)) throw new Error('Invalid cache name');
  const directory = path.join(/* turbopackIgnore: true */ dataDirectory(), name); mkdirSync(/* turbopackIgnore: true */ directory, { recursive: true }); return directory;
}
export interface StoredArtifact { id: string; url: string; path: string; mime: string; name: string; projectId: string | null }
export async function publishFile(source: string, mime: string, name = 'artifact', ownerProjectId?: string): Promise<StoredArtifact> {
  await initDb();
  const id = randomUUID(); const destination = path.join(/* turbopackIgnore: true */ cacheDirectory('artifacts'), id);
  await copyFile(/* turbopackIgnore: true */ source, destination);
  await getPool().query('INSERT INTO artifacts(id,path,mime,name,project_id) VALUES($1,$2,$3,$4,$5)', [id, destination, mime, name.slice(0, 200), ownerProjectId || null]);
  return { id, url: `/api/artifacts/${id}`, path: destination, mime, name: name.slice(0, 200), projectId: ownerProjectId || null };
}
export async function artifactRecord(id: string): Promise<StoredArtifact> {
  if (!validId(id)) notFound('文件不存在');
  await initDb();
  const result = await getPool().query('SELECT * FROM artifacts WHERE id=$1', [id]);
  if (!result.rowCount) notFound('文件不存在');
  const record = result.rows[0];
  const resolved = await realpath(/* turbopackIgnore: true */ record.path).catch(() => notFound('文件已丢失，请重新生成'));
  const root = await realpath(/* turbopackIgnore: true */ cacheDirectory('artifacts'));
  if (!resolved.startsWith(`${root}${path.sep}`)) throw new AppError(403, 'INVALID_ARTIFACT', '文件路径无效');
  return { id, url: `/api/artifacts/${id}`, path: resolved, mime: record.mime, name: record.name, projectId: record.project_id };
}
export async function artifactPath(id: string) { return (await artifactRecord(id)).path; }
export function detectImageMime(bytes: Uint8Array): 'image/png' | 'image/jpeg' | 'image/webp' | null {
  const b = Buffer.from(bytes);
  if (b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return 'image/png';
  if (b.length >= 3 && b[0] === 255 && b[1] === 216 && b[2] === 255) return 'image/jpeg';
  if (b.length >= 12 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}
export async function uploadImage(bytes: Uint8Array, name: string) {
  if (!bytes.length || bytes.length > 15 * 1024 * 1024) throw new AppError(413, 'FILE_TOO_LARGE', '图片大小应为 1 B 到 15 MB');
  const mime = detectImageMime(bytes);
  if (!mime) throw new AppError(415, 'UNSUPPORTED_FILE', '仅支持 PNG、JPEG、WebP 图片，不接受 SVG 或网页');
  const dimensions = await sharp(bytes, { limitInputPixels: 40000000, animated: false }).metadata().catch(() => { throw new AppError(415, 'INVALID_IMAGE', '图片无法读取，请重新导出为 PNG、JPEG 或 WebP'); });
  if (!dimensions.width || !dimensions.height || (dimensions.pages ?? 1) > 1) throw new AppError(415, 'INVALID_IMAGE', '请使用有效的静态图片');
  const temporary = path.join(cacheDirectory('uploads'), randomUUID()); await writeFile(temporary, bytes);
  const artifact = await publishFile(temporary, mime, path.basename(name).slice(0, 200));
  const { unlink } = await import('node:fs/promises'); await unlink(temporary).catch(() => {});
  const rotated = dimensions.orientation && dimensions.orientation >= 5;
  return { id: artifact.id, name: artifact.name, mime, url: artifact.url, hash: createHash('sha256').update(bytes).digest('hex'), width: rotated ? dimensions.height : dimensions.width, height: rotated ? dimensions.width : dimensions.height };
}
export interface ByteRange { start: number; end: number }
export function parseRange(header: string | null, size: number): ByteRange | null {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header);
  if (!match || !size || (!match[1] && !match[2])) throw new AppError(416, 'INVALID_RANGE', '文件范围无效');
  let start: number, end: number;
  if (!match[1]) { const count = Number(match[2]); if (!Number.isSafeInteger(count) || count < 1) throw new AppError(416, 'INVALID_RANGE', '文件范围无效'); start = Math.max(0, size - count); end = size - 1; }
  else { start = Number(match[1]); end = match[2] ? Math.min(Number(match[2]), size - 1) : size - 1; }
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start >= size || end < start) throw new AppError(416, 'INVALID_RANGE', '文件范围无效');
  return { start, end };
}
export async function artifactSize(id: string) { return stat(await artifactPath(id)); }
