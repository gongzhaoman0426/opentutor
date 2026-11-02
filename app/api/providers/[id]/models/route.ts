import { route } from '@/server/http';
import { getSecretProvider } from '@/server/llm-store';
import { listProviderModels } from '@/engine/llm';
import { validId } from '@/server/store';
import { notFound } from '@/server/errors';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const GET = route(async (_request, context) => {
  const { id } = await context.params;
  if (!validId(id)) notFound('供应商不存在');
  return Response.json(await listProviderModels(await getSecretProvider(id)));
});
