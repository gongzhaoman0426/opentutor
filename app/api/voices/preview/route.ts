import { z } from 'zod';
import { route, jsonBody } from '@/server/http';
import { previewVoice } from '@/engine/speech';
import { SettingsSchema } from '@/shared/schema';
export const runtime = 'nodejs';
const schema = z.object({ voice: SettingsSchema.shape.voice, rate: SettingsSchema.shape.rate.default(0), text: z.string().min(1).max(300).optional() });
export const POST = route(async request => { const input = schema.parse(await jsonBody(request)); return Response.json({ speech: await previewVoice(input.voice, input.rate, input.text, request.signal) }); });
