import { route } from '@/server/http';
import { getJobResult } from '@/server/store';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const GET = route(async (_request, { params }) => Response.json(await getJobResult((await params).id)));
