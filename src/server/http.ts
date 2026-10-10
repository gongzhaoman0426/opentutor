import { ZodError } from 'zod';
import { authenticate } from './auth';
import { AppError } from './errors';

export type RouteContext = { params: Promise<Record<string, string>> };
export async function jsonBody(request: Request, limit = 1024 * 1024): Promise<unknown> {
  if (Number(request.headers.get('content-length') || 0) > limit) throw new AppError(413, 'BODY_TOO_LARGE', '请求内容过大');
  const reader = request.body?.getReader();
  if (!reader) throw new AppError(400, 'INVALID_JSON', '需要 JSON 请求内容');
  const chunks: Uint8Array[] = []; let length = 0;
  for (;;) {
    const { value, done } = await reader.read(); if (done) break;
    length += value.length;
    if (length > limit) { await reader.cancel(); throw new AppError(413, 'BODY_TOO_LARGE', '请求内容过大'); }
    chunks.push(value);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new AppError(400, 'INVALID_JSON', 'JSON 内容无效'); }
}
export function errorResponse(error: unknown) {
  if (error instanceof AppError) return Response.json({ error: { code: error.code, message: error.message } }, { status: error.status });
  if (error instanceof ZodError) return Response.json({ error: { code: 'VALIDATION_ERROR', message: '请检查输入格式', details: error.issues.map(i => ({ path: i.path.join('.'), message: i.message })) } }, { status: 422 });
  console.error('[OpenTutor] API failed:', error instanceof Error ? error.name : 'UnknownError');
  return Response.json({ error: { code: 'SERVICE_UNAVAILABLE', message: '服务暂时不可用，请检查数据库和 Worker 后重试' } }, { status: 503 });
}
export function route(handler: (request: Request, context: RouteContext) => Promise<Response>) {
  return async (request: Request, context: RouteContext) => {
    try { authenticate(request); return await handler(request, context); }
    catch (error) { return errorResponse(error); }
  };
}
