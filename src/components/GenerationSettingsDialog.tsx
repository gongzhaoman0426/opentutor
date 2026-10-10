'use client';

import { useEffect, useRef, useState } from 'react';
import { Check, Layers3, LoaderCircle, SlidersHorizontal, Sparkles, Volume2, X } from 'lucide-react';
import { SettingsSchema, type GenerationSettings, type SpeechResult } from '@/shared/schema';
import { stylePresets } from '@/shared/visual-style';
import { ComponentGallery } from './ComponentGallery';
import { api, errorMessage } from './api';
import { ErrorBanner, useModalFocus } from './StudioShell';
import { VideoIntentFields } from './VideoIntentFields';

type Voice = { name: string; locale: string; gender: string; displayName: string };
type Model = { id: string; displayName: string; description?: string; isDefault?: boolean };
const voiceLabel = (voice: Voice) => {
  const short = voice.name.split('-').slice(2).join('-').replace(/Neural$/, '');
  const names: Record<string, string> = { Xiaoxiao: '晓晓', Xiaoyi: '晓伊', Yunjian: '云健', Yunxi: '云希', Yunxia: '云夏', Yunyang: '云扬' };
  return `${names[short] || short || voice.displayName} · ${voice.gender === 'Female' ? '女声' : '男声'} · ${voice.locale === 'zh-CN' ? '普通话' : voice.locale}`;
};

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
  const [auditioning, setAuditioning] = useState(false);
  const [speech, setSpeech] = useState<SpeechResult | null>(null);
  const audio = useRef<HTMLAudioElement>(null);
  const modal = useModalFocus(() => { if (!saving) onClose(); });
  useEffect(() => {
    let alive = true;
    Promise.allSettled([api<{ voices: Voice[] }>('/api/voices'), api<{ models: Model[]; warning?: string }>('/api/models')]).then(results => {
      if (!alive) return;
      const warnings: string[] = [];
      if (results[0].status === 'fulfilled') setVoices(results[0].value.voices.filter(voice => ['zh-CN', 'en-US'].includes(voice.locale)));
      else warnings.push(`音色列表暂时无法加载：${errorMessage(results[0].reason)}`);
      if (results[1].status === 'fulfilled') { setModels(results[1].value.models); if (results[1].value.warning) warnings.push(results[1].value.warning); }
      else warnings.push('模型列表暂时无法加载，可以继续使用服务端默认模型。');
      setWarning(warnings.join(' ')); setLoading(false);
    });
    return () => { alive = false; };
  }, []);
  useEffect(() => { if (speech) audio.current?.play().catch(() => {}); }, [speech]);
  const set = <K extends keyof GenerationSettings>(key: K, next: GenerationSettings[K]) => setValue(current => ({ ...current, [key]: next }));
  const audition = async () => {
    setAuditioning(true); setError(''); setSpeech(null);
    try { const result = await api<{ speech: SpeechResult }>('/api/voices/preview', { method: 'POST', body: JSON.stringify({ voice: value.voice, rate: value.rate }) }); setSpeech(result.speech); }
    catch (failure) { setError(errorMessage(failure)); } finally { setAuditioning(false); }
  };
  const apply = async (generate: boolean) => {
    setSaving(true); setError(''); audio.current?.pause();
    try { await onApply(value, generate); }
    catch (failure) { setError(errorMessage(failure)); }
    finally { setSaving(false); }
  };
  const defaultModel = models.find(model => model.isDefault);
  return <div className="modal-overlay generation-overlay"><section ref={modal} className="generation-dialog" role="dialog" aria-modal="true" aria-labelledby="generation-title">
    <header className="generation-dialog-header"><div><span className="generation-dialog-icon"><SlidersHorizontal size={20} /></span><div><h2 id="generation-title">这一章，怎么呈现？</h2><p>{chapterTitle} <span>· 独立生成一个视频</span></p></div></div><button className="icon-button" aria-label="关闭生成设置" disabled={saving} onClick={onClose}><X size={20} /></button></header>
    <div className="generation-tabs" role="tablist" aria-label="生成配置"><button role="tab" aria-selected={tab === 'settings'} aria-controls="generation-settings-panel" className={tab === 'settings' ? 'selected' : ''} onClick={() => setTab('settings')}><SlidersHorizontal size={15} />生成设置</button><button role="tab" aria-selected={tab === 'library'} aria-controls="generation-library-panel" className={tab === 'library' ? 'selected' : ''} onClick={() => { audio.current?.pause(); setTab('library'); }}><Layers3 size={15} />组件库</button></div>
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
          <div className="field"><label htmlFor="chapter-voice">微软免费配音 <span className="free-label">FREE</span></label><div className="voice-row"><select id="chapter-voice" value={value.voice} onChange={event => { const voice = voices.find(item => item.name === event.target.value); setValue(current => ({ ...current, voice: event.target.value, language: voice?.locale === 'en-US' ? 'en-US' : 'zh-CN' })); audio.current?.pause(); setSpeech(null); }}>{!voices.some(voice => voice.name === value.voice) && <option value={value.voice}>{value.voice === 'zh-CN-XiaoxiaoNeural' ? '晓晓 · 女声 · 普通话' : value.voice}</option>}{voices.map(voice => <option key={voice.name} value={voice.name}>{voiceLabel(voice)}</option>)}</select><button type="button" className="icon-button voice-preview" aria-label="试听当前音色" disabled={auditioning} onClick={audition}>{auditioning ? <LoaderCircle size={17} className="spin" /> : <Volume2 size={17} />}</button></div>{speech && <audio ref={audio} src={speech.url} controls aria-label="音色试听" className="voice-audio" />}</div>
          <label className="field generation-rate">语速 <span>{value.rate === 0 ? '标准' : `${value.rate > 0 ? '+' : ''}${value.rate}%`}</span><input aria-label="配音语速" type="range" min={-50} max={100} step={5} value={value.rate} onChange={event => { set('rate', Number(event.target.value)); audio.current?.pause(); setSpeech(null); }} /></label>
          <label className="field">AI 模型<select aria-label="AI 模型" value={value.model} onChange={event => set('model', event.target.value)}><option value="">{defaultModel ? `${defaultModel.displayName} · 服务端默认` : '服务端默认模型'}</option>{value.model && !models.some(model => model.id === value.model) && <option value={value.model}>{value.model} · 已保存</option>}{models.map(model => <option key={model.id} value={model.id}>{model.displayName}</option>)}</select><span className="field-hint">来自当前 Codex 的模型列表。</span></label>
          {loading && <p className="generation-catalog-status"><LoaderCircle size={12} className="spin" />正在获取音色与模型…</p>}{warning && <p className="generation-catalog-warning" role="status">{warning}</p>}
          <div className="generation-scope-note"><FilmNote /><p>这些设置只影响当前章节。<br />其他章节的视频与设置会保留。</p></div>
        </aside></div>
      </div>
      <div id="generation-library-panel" role="tabpanel" hidden={tab !== 'library'}>{tab === 'library' && <ComponentGallery theme={value.theme} onCreative={() => { set('creationMode', 'creative'); setTab('settings'); }} />}</div>
    </div>
    <footer className="generation-dialog-footer"><span>先生成可播放预览，下载时再渲染 MP4。</span><div><button type="button" className="button secondary" disabled={saving} onClick={() => apply(false)}>保存设置</button><button type="button" className="button primary" disabled={saving || busy || !canGenerate} onClick={() => apply(true)}>{saving ? <LoaderCircle size={15} className="spin" /> : <Sparkles size={15} />}{busy ? '有任务正在生成' : !canGenerate ? '先填写本章文稿' : '生成本章视频'}</button></div></footer>
  </section></div>;
}

function FilmNote() { return <Layers3 size={18} strokeWidth={1.5} />; }
