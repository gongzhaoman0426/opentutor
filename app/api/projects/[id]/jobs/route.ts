import { route, jsonBody } from '@/server/http';
import { submitJob } from '@/server/store';
export const runtime = 'nodejs';
export const POST = route(async (request, { params }) => Response.json({ job: await submitJob((await params).id, await jsonBody(request), request.headers.get('idempotency-key') || undefined) }, { status: 202 }));
