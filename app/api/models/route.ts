import { route } from '@/server/http';
import { listCodexModels } from '@/server/models';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const GET = route(async () => Response.json(await listCodexModels()));
