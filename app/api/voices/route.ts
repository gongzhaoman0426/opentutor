import { route } from '@/server/http';
import { listVoices } from '@/engine/speech';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const GET = route(async request => Response.json({ voices: await listVoices(request.signal) }));
