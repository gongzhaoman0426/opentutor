import { route, jsonBody } from '@/server/http';
import { getLlmSettings, saveLlmSettings } from '@/server/llm-store';
import { resetModelCatalog } from '@/server/models';
import { LlmSettingsSchema } from '@/shared/llm';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const GET = route(async () => Response.json({ settings: await getLlmSettings() }));
export const PUT = route(async request => {
  const settings = await saveLlmSettings(LlmSettingsSchema.parse(await jsonBody(request)));
  resetModelCatalog();
  return Response.json({ settings });
});
