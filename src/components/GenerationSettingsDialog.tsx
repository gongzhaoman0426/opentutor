'use client';

import { useEffect, useState } from 'react';
import { Check, Layers3, LoaderCircle, SlidersHorizontal, Sparkles, Volume2, X } from 'lucide-react';
import { SettingsSchema, type GenerationSettings } from '@/shared/schema';
import { availableLanguages, defaultVoiceForLanguage, languageLabel, voiceLabel, voiceLocale, type Voice } from '@/shared/voices';
import { stylePresets } from '@/shared/visual-style';
import { ComponentGallery } from './ComponentGallery';
import { api, errorMessage } from './api';
import { ErrorBanner, useModalFocus } from './StudioShell';
import { VideoIntentFields } from './VideoIntentFields';
import { useVoicePreview } from './useVoicePreview';

type Model = { id: string; displayName: string; description?: string; isDefault?: boolean };

export function GenerationSettingsDialog({ chapterTitle, initial, busy, canGenerate, initialLibrary = false, onClose, onApply }: {
  chapterTitle: string; initial: GenerationSettings; busy: boolean; canGenerate: boolean; initialLibrary?: boolean;
  onClose: () => void; onApply: (settings: GenerationSettings, generate: boolean) => Promise<void>;
}) {
  const [value, setValue] = useState(() => SettingsSchema.parse(initial));
  const [tab, setTab] = useState<'settings' | 'library'>(initialLibrary ? 'library' : 'settings');
  const [voices, setVoices] = useState<Voice[]>([]);
  const [models, setModels] = useState<Model[]>([]);
  const [loading, setLoading] = useState(true);
  const [warning, setWarning] = useState('');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const audition = useVoicePreview(value);
  const close = () => { audition.cancel(); onClose(); };
  const modal = useModalFocus(() => { if (!saving) close(); });
  useEffect(() => {
    let alive = true;
    const controller = new AbortController();
    const warnings: string[] = [];
    const warn = (message: string) => { warnings.push(message); setWarning(warnings.join(' ')); };
    const voicesRequest = api<{ voices: Voice[] }>('/api/voices', { signal: controller.signal })
      .then(result => { if (alive) setVoices(result.voices); })
      .catch(failure => { if (alive) warn(`音色列表暂时无法加载：${errorMessage(failure)}`); });
    const modelsRequest = api<{ models: Model[]; warning?: string }>('/api/models', { signal: controller.signal })
      .then(result => { if (alive) { setModels(result.models); if (result.warning) warn(result.warning); } })
      .catch(() => { if (alive) warn('模型列表暂时无法加载，可以继续使用服务端默认模型。'); });
    Promise.allSettled([voicesRequest, modelsRequest]).then(() => { if (alive) setLoading(false); });
    return () => { alive = false; controller.abort(); };
  }, []);
  const set = <K extends keyof GenerationSettings>(key: K, next: GenerationSettings[K]) => {
    if (key === 'language' || key === 'voice' || key === 'rate') audition.cancel();
    setValue(current => ({ ...current, [key]: next }));
  };
  const setLanguage = (language: string) => {
    if (language === value.language) return;
    const voice = defaultVoiceForLanguage(voices, language, value.voice);
    if (!voice) return;
    audition.cancel();
    setValue(current => ({ ...current, language: language as GenerationSettings['language'], voice }));
  };
  const apply = async (generate: boolean) => {
    setSaving(true); setError(''); audition.cancel();
    try { await onApply(value, generate); }
    catch (failure) { setError(errorMessage(failure)); }
    finally { setSaving(false); }
  };
  const defaultModel = models.find(model => model.isDefault);
  const languages = availableLanguages(voices);
  const relevantVoices = voices.filter(voice => voice.locale === value.language);
  const selectedVoiceLocale = voices.find(voice => voice.name === value.voice)?.locale ?? voiceLocale(value.voice);
  const matchingVoice = selectedVoiceLocale === value.language;
  return <div className="modal-overlay generation-overlay"><section ref={modal} className="generation-dialog" role="dialog" aria-modal="true" aria-labelledby="generation-title">
    <header className="generation-dialog-header"><div><span className="generation-dialog-icon"><SlidersHorizontal size={20} /></span><div><h2 id="generation-title">这一章，怎么呈现？</h2><p>{chapterTitle} <span>· 独立生成一个视频</span></p></div></div><button className="icon-button" aria-label="关闭生成设置" disabled={saving} onClick={close}><X size={20} /></button></header>
    <div className="generation-tabs" role="tablist" aria-label="生成配置"><button role="tab" aria-selected={tab === 'settings'} aria-controls="generation-settings-panel" className={tab === 'settings' ? 'selected' : ''} onClick={() => setTab('settings')}><SlidersHorizontal size={15} />生成设置</button><button role="tab" aria-selected={tab === 'library'} aria-controls="generation-library-panel" className={tab === 'library' ? 'selected' : ''} onClick={() => { audition.cancel(); setTab('library'); }}><Layers3 size={15} />组件库</button></div>
    <div className="generation-dialog-scroll">
      {error && <ErrorBanner message={error} onDismiss={() => setError('')} />}
      <div id="generation-settings-panel" role="tabpanel" hidden={tab !== 'settings'}>
        <div className="generation-settings-grid"><div className="generation-creative-settings">
          <VideoIntentFields value={value} onChange={setValue} disabled={saving} />
          <fieldset className="generation-fieldset"><legend>画面模板</legend><div className="generation-style-presets">{stylePresets.map(preset => <button type="button" key={preset.id} aria-pressed={value.theme === preset.id} className={`generation-style-preset ${value.theme === preset.id ? 'selected' : ''}`} onClick={() => setValue(current => ({ ...current, theme: preset.id }))}><span className="generation-template-art" style={{ background: preset.palette.background, color: preset.palette.text }}><i style={{ background: preset.palette.accent }} /><b>Aa</b><em style={{ background: preset.palette.surface }} /></span><strong>{preset.name}</strong><small>{preset.description}</small>{value.theme === preset.id && <Check size={13} />}</button>)}</div></fieldset>
          <label className="field generation-style-prompt">用一句话描述画面风格<textarea aria-label="风格描述" rows={2} maxLength={1000} placeholder="例如：深蓝背景、明亮白字、少量橙色强调，画面简洁。" value={value.stylePrompt} onChange={event => set('stylePrompt', event.target.value)} /><span className="field-hint">用于本章的配色、视觉风格与图形设计。</span></label>
          <fieldset className="generation-fieldset"><legend>生成方式</legend><div className="generation-mode-options"><button type="button" className={value.creationMode === 'stable' ? 'selected' : ''} aria-pressed={value.creationMode === 'stable'} onClick={() => set('creationMode', 'stable')}><span><Check size={16} /><strong>稳定模式</strong></span><small>使用预设视频组件，画面结构更可控。</small></button><button type="button" className={value.creationMode === 'creative' ? 'selected' : ''} aria-pressed={value.creationMode === 'creative'} onClick={() => set('creationMode', 'creative')}><span><Sparkles size={16} /><strong>创作模式</strong></span><small>AI 可编写动态图形组件，表达更自由。</small></button></div></fieldset>

        </div><aside className="generation-technical-settings">
          <label className="field">目标观众<input aria-label="目标观众" value={value.audience} maxLength={200} placeholder="例如：新用户、团队同事、普通观众" onChange={event => set('audience', event.target.value)} /></label>
          <label className="field">视频分辨率<select aria-label="视频分辨率" value={value.resolution} onChange={event => set('resolution', event.target.value as GenerationSettings['resolution'])}><option value="720p">720p · 1280 × 720</option><option value="1080p">1080p · 1920 × 1080</option></select></label>
          <div className="field"><label htmlFor="chapter-language">视频语言</label><select id="chapter-language" value={value.language} disabled={saving || !languages.length} onChange={event => setLanguage(event.target.value)} aria-describedby="chapter-language-hint">
            {!languages.some(language => language.locale === value.language) && <option value={value.language}>{languageLabel(value.language)} · 已保存</option>}
            {languages.map(language => <option key={language.locale} value={language.locale}>{language.label}</option>)}
          </select><span id="chapter-language-hint" className="field-hint">用于画面文字与旁白；原始引用图片保留原文。</span></div>
          <div className="field"><label htmlFor="chapter-voice">微软免费配音 <span className="free-label">FREE</span></label><div className="voice-row"><select id="chapter-voice" value={matchingVoice ? value.voice : ''} disabled={saving || !relevantVoices.length} onChange={event => set('voice', event.target.value)}>
            {!matchingVoice && <option value="" disabled>请选择该语言音色</option>}
            {matchingVoice && !relevantVoices.some(voice => voice.name === value.voice) && <option value={value.voice}>{value.voice} · 已保存</option>}
            {relevantVoices.map(voice => <option key={voice.name} value={voice.name}>{voiceLabel(voice)}</option>)}
          </select><button type="button" className="icon-button voice-preview" aria-label="试听当前音色" disabled={audition.busy || saving || !matchingVoice} onClick={audition.preview}>{audition.busy ? <LoaderCircle size={17} className="spin" /> : <Volume2 size={17} />}</button></div>{!matchingVoice && <span className="field-hint">已保存音色与视频语言不一致，请选择对应音色。</span>}{audition.speech && <audio ref={audition.audio} src={audition.speech.url} controls aria-label="音色试听" className="voice-audio" />}{audition.error && <p className="inline-error" role="alert">{audition.error}</p>}</div>
          <label className="field generation-rate">语速 <span>{value.rate === 0 ? '标准' : `${value.rate > 0 ? '+' : ''}${value.rate}%`}</span><input aria-label="配音语速" type="range" min={-50} max={100} step={5} value={value.rate} disabled={saving} onChange={event => set('rate', Number(event.target.value))} /></label>
          <label className="field">AI 模型<select aria-label="AI 模型" value={value.model} onChange={event => set('model', event.target.value)}><option value="">{defaultModel ? `${defaultModel.displayName} · 服务端默认` : '服务端默认模型'}</option>{value.model && !models.some(model => model.id === value.model) && <option value={value.model}>{value.model} · 已保存</option>}{models.map(model => <option key={model.id} value={model.id}>{model.displayName}</option>)}</select><span className="field-hint">来自当前 Codex 的模型列表。</span></label>
          {loading && <p className="generation-catalog-status"><LoaderCircle size={12} className="spin" />正在获取音色与模型…</p>}{warning && <p className="generation-catalog-warning" role="status">{warning}</p>}
          <div className="generation-scope-note"><FilmNote /><p>保存后，后续未配置的章节会自动沿用。<br />其他已有视频或独立设置的章节保留原参数。</p></div>
        </aside></div>
      </div>
      <div id="generation-library-panel" role="tabpanel" hidden={tab !== 'library'}>{tab === 'library' && <ComponentGallery theme={value.theme} onCreative={() => { set('creationMode', 'creative'); setTab('settings'); }} />}</div>
    </div>
    <footer className="generation-dialog-footer"><span>先生成可播放预览，下载时再渲染 MP4。</span><div><button type="button" className="button secondary" disabled={saving} onClick={() => apply(false)}>保存设置</button><button type="button" className="button primary" disabled={saving || busy || !canGenerate || !matchingVoice} onClick={() => apply(true)}>{saving ? <LoaderCircle size={15} className="spin" /> : <Sparkles size={15} />}{busy ? '有任务正在生成' : !canGenerate ? '先填写本章文稿' : '生成本章视频'}</button></div></footer>
  </section></div>;
}

function FilmNote() { return <Layers3 size={18} strokeWidth={1.5} />; }
