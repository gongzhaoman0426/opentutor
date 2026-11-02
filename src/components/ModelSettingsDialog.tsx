'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Check, Cpu, Eye, KeyRound, LoaderCircle, Pencil, Plus, Trash2, X, Zap } from 'lucide-react';
import { providerPresets, type LlmSettings, type ModelListing, type ProviderKind, type ProviderOptions, type PublicProvider } from '@/shared/llm';
import { api, errorMessage } from './api';
import { ErrorBanner, useModalFocus } from './StudioShell';

type Draft = { id?: string; name: string; kind: ProviderKind; baseUrl: string; apiKey: string; options: ProviderOptions; testModel: string };
type TestResult = { ok: boolean; message: string };
const kinds: ProviderKind[] = ['glm', 'deepseek', 'openai', 'custom'];
const emptySettings: LlmSettings = { text: null, vision: null, textSupportsImages: false };
const host = (url: string) => { try { return new URL(url).host; } catch { return url; } };

function draftFor(kind: ProviderKind, provider?: PublicProvider): Draft {
  const preset = providerPresets[kind];
  return provider
    ? { id: provider.id, name: provider.name, kind: provider.kind, baseUrl: provider.baseUrl, apiKey: '', options: provider.options, testModel: preset.textModels[0] ?? '' }
    : { name: preset.label, kind, baseUrl: preset.baseUrl, apiKey: '', options: preset.options, testModel: preset.textModels[0] ?? '' };
}

export function ModelSettingsDialog({ onClose, onChanged }: { onClose: () => void; onChanged?: () => void }) {
  const modal = useModalFocus(onClose);
  const [providers, setProviders] = useState<PublicProvider[]>([]);
  const [settings, setSettings] = useState<LlmSettings>(emptySettings);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [tests, setTests] = useState<Record<string, TestResult>>({});
  const [catalogs, setCatalogs] = useState<Record<string, string[]>>({});

  const load = useCallback(async () => {
    const [list, current] = await Promise.all([api<{ providers: PublicProvider[] }>('/api/providers'), api<{ settings: LlmSettings }>('/api/llm-settings')]);
    setProviders(list.providers); setSettings(current.settings);
  }, []);
  useEffect(() => { load().catch(failure => setError(errorMessage(failure))).finally(() => setLoading(false)); }, [load]);

  // Suggest model names for whichever provider a role points at.
  const providerIds = [settings.text?.providerId, settings.vision?.providerId].filter(Boolean).join(',');
  useEffect(() => {
    for (const id of providerIds.split(',').filter(Boolean)) {
      if (catalogs[id]) continue;
      api<ModelListing>(`/api/providers/${id}/models`).then(listing => setCatalogs(current => ({ ...current, [id]: listing.models.map(model => model.id) }))).catch(() => setCatalogs(current => ({ ...current, [id]: [] })));
    }
  }, [providerIds, catalogs]);

  const clearDraftTest = () => setTests(current => { const { draft: _draft, ...rest } = current; return rest; });
  const run = async (name: string, action: () => Promise<void>) => {
    setBusy(name); setError(''); setNotice('');
    try { await action(); } catch (failure) { setError(errorMessage(failure)); } finally { setBusy(''); }
  };
  const draftBody = (value: Draft) => ({ id: value.id, name: value.name, kind: value.kind, baseUrl: value.baseUrl, apiKey: value.apiKey || undefined, options: value.options });

  const saveDraft = () => run('save', async () => {
    if (!draft) return;
    const { provider } = await api<{ provider: PublicProvider }>('/api/providers', { method: 'POST', body: JSON.stringify(draftBody(draft)) });
    setCatalogs(current => { const { [provider.id]: _removed, ...rest } = current; return rest; });
    await load(); setDraft(null); setNotice(`已保存“${provider.name}”`); onChanged?.();
  });
  const removeProvider = (provider: PublicProvider) => run(`delete-${provider.id}`, async () => {
    if (!window.confirm(`删除供应商“${provider.name}”？使用它的模型选择会被清空。`)) return;
    await api(`/api/providers/${provider.id}`, { method: 'DELETE' });
    await load(); onChanged?.();
  });
  const testDraft = () => run('test-draft', async () => {
    if (!draft) return;
    const result = await api<{ ok: boolean; mode?: string; latencyMs?: number; error?: string }>('/api/providers/test', { method: 'POST', body: JSON.stringify({ providerId: draft.id, draft: draftBody(draft), model: draft.testModel || 'gpt-4.1', vision: false }) });
    setTests(current => ({ ...current, draft: { ok: result.ok, message: result.ok ? `连接成功 · ${result.latencyMs} ms · 结构化输出：${result.mode}` : result.error || '测试失败' } }));
  });
  const testRole = (role: 'text' | 'vision') => run(`test-${role}`, async () => {
    const value = settings[role]; if (!value) return;
    const result = await api<{ ok: boolean; mode?: string; latencyMs?: number; error?: string }>('/api/providers/test', { method: 'POST', body: JSON.stringify({ providerId: value.providerId, model: value.model, vision: role === 'vision' }) });
    setTests(current => ({ ...current, [role]: { ok: result.ok, message: result.ok ? `${role === 'vision' ? '看图正常' : '连接正常'} · ${result.latencyMs} ms · ${result.mode}` : result.error || '测试失败' } }));
  });
  const saveSettings = () => run('settings', async () => {
    const { settings: saved } = await api<{ settings: LlmSettings }>('/api/llm-settings', { method: 'PUT', body: JSON.stringify(settings) });
    setSettings(saved); setNotice('模型选择已保存，新任务会立即使用。'); onChanged?.();
  });

  const setRole = (role: 'text' | 'vision', patch: Partial<{ providerId: string; model: string }>) => setSettings(current => {
    const existing = current[role] ?? { providerId: providers[0]?.id ?? '', model: '' };
    const providerChanged = patch.providerId !== undefined && patch.providerId !== existing.providerId;
    const next = { ...existing, ...patch };
    if (providerChanged) {
      const provider = providers.find(item => item.id === next.providerId);
      const preset = provider ? providerPresets[provider.kind] : undefined;
      next.model = (role === 'vision' ? preset?.visionModels[0] : preset?.textModels[0]) ?? '';
    }
    return { ...current, [role]: next };
  });
  const keyed = useMemo(() => providers.filter(provider => provider.hasKey), [providers]);
  const roleEditor = (role: 'text' | 'vision') => {
    const value = settings[role];
    const listId = `models-${role}`;
    return <div className="model-role">
      <div className="model-role-row">
        <label className="field">供应商<select aria-label={`${role === 'text' ? '文本' : '图片理解'}模型供应商`} value={value?.providerId ?? ''} onChange={event => event.target.value ? setRole(role, { providerId: event.target.value }) : setSettings(current => ({ ...current, [role]: null }))}>
          <option value="">{role === 'text' ? '请选择…' : '不单独配置'}</option>{keyed.map(provider => <option key={provider.id} value={provider.id}>{provider.name}</option>)}
        </select></label>
        <label className="field">模型名<input aria-label={`${role === 'text' ? '文本' : '图片理解'}模型名`} list={listId} value={value?.model ?? ''} disabled={!value} placeholder="例如 glm-4.6 / deepseek-chat" onChange={event => setRole(role, { model: event.target.value.trim() })} />
          <datalist id={listId}>{(catalogs[value?.providerId ?? ''] ?? []).map(id => <option key={id} value={id} />)}</datalist></label>
        <button type="button" className="button secondary small" disabled={!value?.model || Boolean(busy)} onClick={() => testRole(role)}>{busy === `test-${role}` ? <LoaderCircle size={14} className="spin" /> : role === 'vision' ? <Eye size={14} /> : <Zap size={14} />}测试</button>
      </div>
      {tests[role] && <p className={`model-test ${tests[role].ok ? 'ok' : 'bad'}`} role="status">{tests[role].ok ? <Check size={13} /> : <X size={13} />}{tests[role].message}</p>}
    </div>;
  };

  return <div className="modal-overlay generation-overlay"><section ref={modal} className="generation-dialog model-settings" role="dialog" aria-modal="true" aria-labelledby="model-settings-title">
    <header className="generation-dialog-header"><div><span className="generation-dialog-icon"><Cpu size={20} /></span><div><h2 id="model-settings-title">模型设置</h2><p>使用任意 OpenAI 兼容接口 <span>· API Key 加密保存在数据库，不会回传到浏览器</span></p></div></div><button className="icon-button" aria-label="关闭模型设置" onClick={onClose}><X size={20} /></button></header>
    <div className="generation-dialog-scroll">
      {error && <ErrorBanner message={error} onDismiss={() => setError('')} />}
      {notice && <p className="model-notice" role="status"><Check size={13} />{notice}</p>}
      {loading ? <p className="generation-catalog-status"><LoaderCircle size={12} className="spin" />正在读取…</p> : <>
        <section className="model-section">
          <div className="model-section-head"><h3>① 供应商与 API Key</h3>
            <div className="model-preset-buttons">{kinds.map(kind => <button key={kind} type="button" className="button subtle small" disabled={Boolean(draft)} onClick={() => { clearDraftTest(); setDraft(draftFor(kind)); }}><Plus size={13} />{providerPresets[kind].label}</button>)}</div></div>
          {!providers.length && !draft && <p className="field-hint">还没有供应商。点上方按钮添加 GLM 或 DeepSeek，只需要 API Key。</p>}
          <ul className="model-provider-list">{providers.map(provider => <li key={provider.id}>
            <div><strong>{provider.name}</strong><span>{providerPresets[provider.kind].label} · {host(provider.baseUrl)}</span></div>
            <span className={`model-key ${provider.hasKey ? 'ok' : 'bad'}`}><KeyRound size={12} />{provider.hasKey ? provider.keyHint : '未填写 Key'}</span>
            <button type="button" className="icon-button" aria-label={`编辑${provider.name}`} disabled={Boolean(draft)} onClick={() => { clearDraftTest(); setDraft(draftFor(provider.kind, provider)); }}><Pencil size={15} /></button>
            <button type="button" className="icon-button" aria-label={`删除${provider.name}`} disabled={Boolean(busy)} onClick={() => removeProvider(provider)}><Trash2 size={15} /></button>
          </li>)}</ul>
          {draft && <form className="model-draft" onSubmit={event => { event.preventDefault(); void saveDraft(); }}>
            <p className="field-hint">{providerPresets[draft.kind].note}</p>
            <div className="model-grid">
              <label className="field">名称<input aria-label="供应商名称" required maxLength={60} value={draft.name} onChange={event => setDraft({ ...draft, name: event.target.value })} /></label>
              <label className="field">接口地址（Base URL）<input aria-label="接口地址" required value={draft.baseUrl} placeholder="https://…/v1" onChange={event => setDraft({ ...draft, baseUrl: event.target.value })} /></label>
              <label className="field model-wide">API Key<input aria-label="API Key" type="password" autoComplete="off" value={draft.apiKey} placeholder={draft.id ? '已保存；留空表示不修改' : '粘贴你的 API Key'} onChange={event => setDraft({ ...draft, apiKey: event.target.value })} /></label>
              <label className="field">测试用模型<input aria-label="测试用模型" list="models-draft" value={draft.testModel} onChange={event => setDraft({ ...draft, testModel: event.target.value })} /><datalist id="models-draft">{[...providerPresets[draft.kind].textModels, ...providerPresets[draft.kind].visionModels].map(id => <option key={id} value={id} />)}</datalist></label>
              <details className="model-advanced model-wide"><summary>高级</summary><div className="model-grid">
                <label className="field">结构化输出<select aria-label="结构化输出方式" value={draft.options.jsonMode} onChange={event => setDraft({ ...draft, options: { ...draft.options, jsonMode: event.target.value as ProviderOptions['jsonMode'] } })}><option value="json_schema">json_schema（严格 Schema）</option><option value="json_object">json_object（仅保证 JSON）</option><option value="prompt">仅提示词约束</option></select><span className="field-hint">接口不支持时会自动降级。</span></label>
                <label className="field">单次最大输出 tokens<input aria-label="最大输出 tokens" type="number" min={256} max={131072} value={draft.options.maxTokens} onChange={event => setDraft({ ...draft, options: { ...draft.options, maxTokens: Number(event.target.value) || 8192 } })} /><span className="field-hint">被截断时章节会自动拆小重试。</span></label>
              </div></details>
            </div>
            {tests.draft && <p className={`model-test ${tests.draft.ok ? 'ok' : 'bad'}`} role="status">{tests.draft.ok ? <Check size={13} /> : <X size={13} />}{tests.draft.message}</p>}
            <div className="model-draft-actions"><button type="button" className="button secondary small" disabled={Boolean(busy)} onClick={() => setDraft(null)}>取消</button><button type="button" className="button secondary small" disabled={Boolean(busy) || (!draft.apiKey && !draft.id)} onClick={() => void testDraft()}>{busy === 'test-draft' ? <LoaderCircle size={14} className="spin" /> : <Zap size={14} />}测试连接</button><button type="submit" className="button primary small" disabled={Boolean(busy)}>{busy === 'save' ? <LoaderCircle size={14} className="spin" /> : <Check size={14} />}保存供应商</button></div>
          </form>}
        </section>
        <section className="model-section">
          <h3>② 生成模型（编排、讲稿、画面代码）</h3>
          {roleEditor('text')}
          <label className="model-check"><input type="checkbox" checked={settings.textSupportsImages} onChange={event => setSettings(current => ({ ...current, textSupportsImages: event.target.checked }))} />该模型本身支持图片输入（如 GPT-4.1、GLM-4.6V），无需另配图片理解模型</label>
        </section>
        <section className="model-section">
          <h3>③ 图片理解模型 <span className="field-optional">章节含图片且上面的模型不能看图时才需要</span></h3>
          {roleEditor('vision')}
          <p className="field-hint">DeepSeek 不接收图片，推荐搭配 GLM-4.6V。图片会先被理解成文字描述，再交给生成模型编排。</p>
        </section>
      </>}
    </div>
    <footer className="generation-dialog-footer"><span>修改后立即对新任务生效；已有缓存按模型自动区分。</span><div><button type="button" className="button secondary" onClick={onClose}>关闭</button><button type="button" className="button primary" disabled={Boolean(busy) || loading || !settings.text} onClick={() => void saveSettings()}>{busy === 'settings' ? <LoaderCircle size={15} className="spin" /> : <Check size={15} />}保存模型选择</button></div></footer>
  </section></div>;
}
