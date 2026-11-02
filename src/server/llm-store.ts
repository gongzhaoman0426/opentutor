import { randomUUID } from 'node:crypto';
import { getPool, initDb } from './db';
import { AppError, notFound } from './errors';
import { decryptSecret, encryptSecret, keyHint } from './secrets';
import { LlmSettingsSchema, ProviderOptionsSchema, defaultLlmSettings, providerPresets, type LlmSettings, type ProviderInput, type ProviderKind, type ProviderOptions, type PublicProvider } from '../shared/llm';

/** Provider including its decrypted key. Server-only: never serialize this to a response or a job snapshot. */
export interface SecretProvider { id: string; name: string; kind: ProviderKind; baseUrl: string; apiKey: string; options: ProviderOptions }
interface Row { id: string; name: string; kind: ProviderKind; base_url: string; api_key_enc: string | null; key_hint: string; options: unknown; updated_at: Date }

const publicProvider = (row: Row): PublicProvider => ({ id: row.id, name: row.name, kind: row.kind, baseUrl: row.base_url, hasKey: Boolean(row.api_key_enc), keyHint: row.api_key_enc ? row.key_hint : '', options: ProviderOptionsSchema.parse({ ...providerPresets[row.kind]?.options, ...(row.options as object) }), updatedAt: row.updated_at.toISOString() });

export async function listProviders(): Promise<PublicProvider[]> {
  await initDb();
  return (await getPool().query<Row>('SELECT * FROM llm_providers ORDER BY created_at')).rows.map(publicProvider);
}

export async function saveProvider(input: ProviderInput): Promise<PublicProvider> {
  await initDb();
  const pool = getPool();
  const id = input.id ?? randomUUID();
  const existing = input.id ? (await pool.query<Row>('SELECT * FROM llm_providers WHERE id=$1', [id])).rows[0] : undefined;
  if (input.id && !existing) notFound('供应商不存在');
  let encrypted = existing?.api_key_enc ?? null;
  let hint = existing?.key_hint ?? '';
  if (input.clearKey) { encrypted = null; hint = ''; }
  if (input.apiKey) { encrypted = encryptSecret(input.apiKey); hint = keyHint(input.apiKey); }
  const result = await pool.query<Row>(
    `INSERT INTO llm_providers(id,name,kind,base_url,api_key_enc,key_hint,options) VALUES($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT (id) DO UPDATE SET name=$2, kind=$3, base_url=$4, api_key_enc=$5, key_hint=$6, options=$7, updated_at=now() RETURNING *`,
    [id, input.name, input.kind, input.baseUrl, encrypted, hint, JSON.stringify(input.options)]);
  return publicProvider(result.rows[0]);
}

export async function deleteProvider(id: string): Promise<void> {
  await initDb();
  const result = await getPool().query('DELETE FROM llm_providers WHERE id=$1', [id]);
  if (!result.rowCount) notFound('供应商不存在');
  const settings = await getLlmSettings();
  const next: LlmSettings = { ...settings, text: settings.text?.providerId === id ? null : settings.text, vision: settings.vision?.providerId === id ? null : settings.vision };
  if (JSON.stringify(next) !== JSON.stringify(settings)) await saveLlmSettings(next);
}

export async function getSecretProvider(id: string): Promise<SecretProvider> {
  await initDb();
  const row = (await getPool().query<Row>('SELECT * FROM llm_providers WHERE id=$1', [id])).rows[0];
  if (!row) throw new AppError(400, 'PROVIDER_MISSING', '所选供应商已被删除，请在“模型设置”里重新选择');
  if (!row.api_key_enc) throw new AppError(400, 'PROVIDER_KEY_MISSING', `供应商“${row.name}”尚未填写 API Key`);
  const view = publicProvider(row);
  return { id: row.id, name: row.name, kind: row.kind, baseUrl: row.base_url, apiKey: decryptSecret(row.api_key_enc), options: view.options };
}

export async function getLlmSettings(): Promise<LlmSettings> {
  await initDb();
  const row = (await getPool().query('SELECT data FROM llm_settings WHERE id=$1', ['global'])).rows[0];
  const parsed = LlmSettingsSchema.safeParse(row?.data ?? {});
  return parsed.success ? parsed.data : defaultLlmSettings;
}

export async function saveLlmSettings(settings: LlmSettings): Promise<LlmSettings> {
  await initDb();
  const value = LlmSettingsSchema.parse(settings);
  for (const role of [value.text, value.vision]) if (role) {
    const found = await getPool().query('SELECT 1 FROM llm_providers WHERE id=$1', [role.providerId]);
    if (!found.rowCount) throw new AppError(422, 'PROVIDER_MISSING', '所选供应商不存在');
  }
  await getPool().query(`INSERT INTO llm_settings(id,data) VALUES('global',$1) ON CONFLICT (id) DO UPDATE SET data=$1, updated_at=now()`, [JSON.stringify(value)]);
  return value;
}
