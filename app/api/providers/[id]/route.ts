import { route } from '@/server/http';
import { deleteProvider } from '@/server/llm-store';
import { resetModelCatalog } from '@/server/models';
import { validId } from '@/server/store';
import { notFound } from '@/server/errors';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const DELETE = route(async (_request, context) => {
  const { id } = await context.params;
  if (!validId(id)) notFound('供应商不存在');
  await deleteProvider(id);
  resetModelCatalog();
  return Response.json({ ok: true });
});
