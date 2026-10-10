import { route } from '@/server/http';
import { cancelJob } from '@/server/store';
export const runtime = 'nodejs';
export const POST = route(async (_request, { params }) => Response.json({ job: await cancelJob((await params).id) }));
