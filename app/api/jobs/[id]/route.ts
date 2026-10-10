import { route } from '@/server/http';
import { getJob } from '@/server/store';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const GET = route(async (_request, { params }) => Response.json({ job: await getJob((await params).id) }));
