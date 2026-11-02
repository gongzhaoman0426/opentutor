import { route, jsonBody } from '@/server/http';
import { getSecretProvider } from '@/server/llm-store';
import { testModel, listProviderModels, type CallConfig } from '@/engine/llm';
import { AppError } from '@/server/errors';
import { TestRequestSchema } from '@/shared/llm';
import { getPool, initDb } from '@/server/db';
import { decryptSecret } from '@/server/secrets';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Tests a saved provider, or an unsaved draft (reusing the stored key when the draft leaves it blank). */
export const POST = route(async request => {
  const body = TestRequestSchema.parse(await jsonBody(request));
  let provider;
  if (body.draft) {
    let apiKey = body.draft.apiKey || '';
    if (!apiKey && (body.draft.id || body.providerId)) {
      await initDb();
      const row = (await getPool().query('SELECT api_key_enc FROM llm_providers WHERE id=$1', [body.draft.id || body.providerId])).rows[0];
      if (row?.api_key_enc) apiKey = decryptSecret(row.api_key_enc);
    }
    if (!apiKey) throw new AppError(422, 'KEY_REQUIRED', '请先填写 API Key');
    provider = { id: body.draft.id || 'draft', name: body.draft.name, kind: body.draft.kind, baseUrl: body.draft.baseUrl, apiKey, options: body.draft.options };
  } else provider = await getSecretProvider(body.providerId!);
  const call: CallConfig = { provider, model: body.model };
  try { return Response.json(await testModel(call, body.vision)); }
  catch (error) {
    const models = await listProviderModels(provider).catch(() => null);
    return Response.json({ ok: false, error: error instanceof Error ? error.message : '测试失败', models: models?.source === 'remote' ? models.models.slice(0, 8).map(model => model.id) : [] }, { status: 200 });
  }
});
