import { route, jsonBody } from '@/server/http';
import { listProviders, saveProvider } from '@/server/llm-store';
import { resetModelCatalog } from '@/server/models';
import { ProviderInputSchema, providerPresets } from '@/shared/llm';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const GET = route(async () => Response.json({ providers: await listProviders(), presets: providerPresets }));
export const POST = route(async request => {
  const provider = await saveProvider(ProviderInputSchema.parse(await jsonBody(request)));
  resetModelCatalog();
  return Response.json({ provider });
});
