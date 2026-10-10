import { route } from '@/server/http';
import { uploadImage } from '@/server/artifacts';
import { AppError } from '@/server/errors';
export const runtime = 'nodejs';
export const POST = route(async request => {
  const limit = 16 * 1024 * 1024;
  if (Number(request.headers.get('content-length') || 0) > limit) throw new AppError(413, 'FILE_TOO_LARGE', '图片最大 15 MB');
  // Bound chunked bodies before multipart parsing, too.
  const reader = request.body?.getReader(); if (!reader) throw new AppError(400, 'MISSING_FILE', '请选择图片');
  const chunks: Uint8Array[] = []; let length = 0;
  for (;;) { const { value, done } = await reader.read(); if (done) break; length += value.length; if (length > limit) { await reader.cancel(); throw new AppError(413, 'FILE_TOO_LARGE', '图片最大 15 MB'); } chunks.push(value); }
  let data: FormData;
  try { data = await new Request(request.url, { method: 'POST', headers: { 'content-type': request.headers.get('content-type') || '' }, body: Buffer.concat(chunks) }).formData(); }
  catch { throw new AppError(400, 'INVALID_UPLOAD', '需要 multipart/form-data 文件上传'); }
  const file = data.get('file');
  if (!(file instanceof File)) throw new AppError(400, 'MISSING_FILE', '请选择图片');
  return Response.json({ asset: await uploadImage(new Uint8Array(await file.arrayBuffer()), file.name) }, { status: 201 });
});
