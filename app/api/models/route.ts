import { route } from '@/server/http';
import { listActiveModels } from '@/server/models';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const GET = route(async () => Response.json(await listActiveModels()));
