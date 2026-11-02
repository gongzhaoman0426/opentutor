import { listProviderModels } from '../engine/llm';
import { getLlmSettings, getSecretProvider } from './llm-store';
import type { ModelListing } from '../shared/llm';

export interface ModelCatalog extends ModelListing { fetchedAt: string | null }
let cache: { key: string; value: ModelCatalog; expires: number } | undefined;

/** Models of the active text provider, for the per-chapter "AI 模型" selector. */
export async function listActiveModels(): Promise<ModelCatalog> {
  const settings = await getLlmSettings();
  if (!settings.text) return { models: [], source: 'none', warning: '尚未配置模型：请先打开“模型设置”。', fetchedAt: null };
  const key = `${settings.text.providerId}|${settings.text.model}`;
  if (cache?.key === key && cache.expires > Date.now()) return cache.value;
  const listing = await listProviderModels(await getSecretProvider(settings.text.providerId));
  const models = listing.models.some(model => model.id === settings.text!.model) ? listing.models : [{ id: settings.text.model, displayName: settings.text.model }, ...listing.models];
  const value: ModelCatalog = { ...listing, models: models.map(model => ({ ...model, isDefault: model.id === settings.text!.model })), fetchedAt: new Date().toISOString() };
  cache = { key, value, expires: Date.now() + 120_000 };
  return value;
}
export function resetModelCatalog() { cache = undefined; }
