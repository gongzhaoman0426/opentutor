import { route } from '@/server/http';
import { AppError } from '@/server/errors';
import { importMarkdownArchive } from '@/server/markdown-import';
import { MARKDOWN_IMPORT_LIMITS } from '@/shared/markdown-import';

export const runtime = 'nodejs';

export const POST = route(async request => {
  const limit = MARKDOWN_IMPORT_LIMITS.requestBytes;
  if (Number(request.headers.get('content-length') || 0) > limit) throw new AppError(413, 'MARKDOWN_ZIP_SIZE', 'ZIP 压缩包不能超过 25 MiB');
  const reader = request.body?.getReader();
  if (!reader) throw new AppError(400, 'MARKDOWN_ZIP_REQUIRED', '请选择 Markdown ZIP 压缩包');
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { value, done } = await reader.read(); if (done) break;
    size += value.length;
    if (size > limit) { await reader.cancel(); throw new AppError(413, 'MARKDOWN_ZIP_SIZE', 'ZIP 压缩包不能超过 25 MiB'); }
    chunks.push(value);
  }
  let data: FormData;
  try { data = await new Request(request.url, { method: 'POST', headers: { 'content-type': request.headers.get('content-type') || '' }, body: Buffer.concat(chunks) }).formData(); }
  catch { throw new AppError(400, 'INVALID_UPLOAD', '需要 multipart/form-data 文件上传'); }
  const files = data.getAll('file');
  if (files.length !== 1 || !(files[0] instanceof File)) throw new AppError(400, 'MARKDOWN_ZIP_REQUIRED', '请选择一个 Markdown ZIP 压缩包');
  const file = files[0];
  if (!/\.zip$/i.test(file.name)) throw new AppError(415, 'MARKDOWN_ZIP_REQUIRED', '请上传 .zip 格式的压缩包');
  return Response.json(await importMarkdownArchive(new Uint8Array(await file.arrayBuffer())), { status: 201 });
});
