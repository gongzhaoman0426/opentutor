import { z } from 'zod';
import { jsonBody, errorResponse } from '@/server/http';
import { verifyOrigin, sessionCookie } from '@/server/auth';
export const runtime = 'nodejs';
export async function POST(request: Request) {
  try { verifyOrigin(request); const input = z.object({ token: z.string().min(1).max(4096) }).parse(await jsonBody(request, 8192)); return Response.json({ authenticated: true }, { headers: { 'Set-Cookie': sessionCookie(input.token, new URL(request.url).protocol === 'https:') } }); }
  catch (error) { return errorResponse(error); }
}
export async function DELETE(request: Request) {
  try { verifyOrigin(request); return Response.json({ authenticated: false }, { headers: { 'Set-Cookie': 'opentutor_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0' } }); }
  catch (error) { return errorResponse(error); }
}
