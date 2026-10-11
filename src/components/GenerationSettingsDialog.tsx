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
import { useI18n } from '@/i18n/provider';

type Model = { id: string; displayName: string; description?: string; isDefault?: boolean };
type CatalogWarning = { kind: 'voices' | 'models'; error: unknown } | { kind: 'refresh' };

export function GenerationSettingsDialog({ chapterTitle, initial, busy, canGenerate, initialLibrary = false, onClose, onApply }: {
  chapterTitle: string; initial: GenerationSettings; busy: boolean; canGenerate: boolean; initialLibrary?: boolean;
  onClose: () => void; onApply: (settings: GenerationSettings, generate: boolean) => Promise<void>;
}) {
  const { t, locale } = useI18n('settings');
  const [value, setValue] = useState(() => SettingsSchema.parse(initial));
  const [tab, setTab] = useState<'settings' | 'library'>(initialLibrary ? 'library' : 'settings');
  const [voices, setVoices] = useState<Voice[]>([]);
  const [models, setModels] = useState<Model[]>([]);
  const [loading, setLoading] = useState(true);
  const [warnings, setWarnings] = useState<CatalogWarning[]>([]);
  const [error, setError] = useState<unknown>(null);
  const [saving, setSaving] = useState(false);
  const audition = useVoicePreview(value);
  const close = () => { audition.cancel(); onClose(); };
  const modal = useModalFocus(() => { if (!saving) close(); });
  useEffect(() => {
    let alive = true;
    const controller = new AbortController();
    const warn = (warning: CatalogWarning) => setWarnings(current => [...current, warning]);
    const voicesRequest = api<{ voices: Voice[] }>('/api/voices', { signal: controller.signal })
      .then(result => { if (alive) setVoices(result.voices); })
      .catch(failure => { if (alive) warn({ kind: 'voices', error: failure }); });
    const modelsRequest = api<{ models: Model[]; warning?: string }>('/api/models', { signal: controller.signal })
      .then(result => { if (alive) { setModels(result.models); if (result.warning) warn({ kind: 'refresh' }); } })
      .catch(failure => { if (alive) warn({ kind: 'models', error: failure }); });
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
    setSaving(true); setError(null); audition.cancel();
    try { await onApply(value, generate); }
    catch (failure) { setError(failure); }
    finally { setSaving(false); }
  };
  const defaultModel = models.find(model => model.isDefault);
  const languages = availableLanguages(voices, locale);
  const warning = warnings.map(item => item.kind === 'refresh' ? t('modelsRefreshWarning') : t(item.kind === 'voices' ? 'voicesUnavailable' : 'modelsUnavailable', { error: errorMessage(item.error, locale) })).join(' ');
  const relevantVoices = voices.filter(voice => voice.locale === value.language);
  const selectedVoiceLocale = voices.find(voice => voice.name === value.voice)?.locale ?? voiceLocale(value.voice);
  const matchingVoice = selectedVoiceLocale === value.language;
  return <div className="modal-overlay generation-overlay"><section ref={modal} className="generation-dialog" role="dialog" aria-modal="true" aria-labelledby="generation-title">
    <header className="generation-dialog-header"><div><span className="generation-dialog-icon"><SlidersHorizontal size={20} /></span><div><h2 id="generation-title">{t('title')}</h2><p>{chapterTitle} <span>{t('chapterVideo')}</span></p></div></div><button className="icon-button" aria-label={t('close')} disabled={saving} onClick={close}><X size={20} /></button></header>
    <div className="generation-tabs" role="tablist" aria-label={t('configuration')}><button role="tab" aria-selected={tab === 'settings'} aria-controls="generation-settings-panel" className={tab === 'settings' ? 'selected' : ''} onClick={() => setTab('settings')}><SlidersHorizontal size={15} />{t('settingsTab')}</button><button role="tab" aria-selected={tab === 'library'} aria-controls="generation-library-panel" className={tab === 'library' ? 'selected' : ''} onClick={() => { audition.cancel(); setTab('library'); }}><Layers3 size={15} />{t('libraryTab')}</button></div>
    <div className="generation-dialog-scroll">
      {!!error && <ErrorBanner message={errorMessage(error, locale)} onDismiss={() => setError(null)} />}
      <div id="generation-settings-panel" role="tabpanel" hidden={tab !== 'settings'}>
        <div className="generation-settings-grid"><div className="generation-creative-settings">
          <VideoIntentFields value={value} onChange={setValue} disabled={saving} />
          <fieldset className="generation-fieldset"><legend>{t('templates')}</legend><div className="generation-style-presets">{stylePresets.map(preset => <button type="button" key={preset.id} aria-pressed={value.theme === preset.id} className={`generation-style-preset ${value.theme === preset.id ? 'selected' : ''}`} onClick={() => setValue(current => ({ ...current, theme: preset.id }))}><span className="generation-template-art" style={{ background: preset.palette.background, color: preset.palette.text }}><i style={{ background: preset.palette.accent }} /><b>Aa</b><em style={{ background: preset.palette.surface }} /></span><strong>{t(`themes.${preset.id}.name`)}</strong><small>{t(`themes.${preset.id}.description`)}</small>{value.theme === preset.id && <Check size={13} />}</button>)}</div></fieldset>
          <label className="field generation-style-prompt">{t('styleSentence')}<textarea aria-label={t('styleDescription')} rows={2} maxLength={1000} placeholder={t('stylePlaceholder')} value={value.stylePrompt} onChange={event => set('stylePrompt', event.target.value)} /><span className="field-hint">{t('styleHint')}</span></label>
          <fieldset className="generation-fieldset"><legend>{t('generationMode')}</legend><div className="generation-mode-options"><button type="button" className={value.creationMode === 'stable' ? 'selected' : ''} aria-pressed={value.creationMode === 'stable'} onClick={() => set('creationMode', 'stable')}><span><Check size={16} /><strong>{t('stable')}</strong></span><small>{t('stableHint')}</small></button><button type="button" className={value.creationMode === 'creative' ? 'selected' : ''} aria-pressed={value.creationMode === 'creative'} onClick={() => set('creationMode', 'creative')}><span><Sparkles size={16} /><strong>{t('creative')}</strong></span><small>{t('creativeHint')}</small></button></div></fieldset>

        </div><aside className="generation-technical-settings">
          <label className="field">{t('audience')}<input aria-label={t('audience')} value={value.audience} maxLength={200} placeholder={t('audiencePlaceholder')} onChange={event => set('audience', event.target.value)} /></label>
          <label className="field">{t('resolution')}<select aria-label={t('resolution')} value={value.resolution} onChange={event => set('resolution', event.target.value as GenerationSettings['resolution'])}><option value="720p">720p · 1280 × 720</option><option value="1080p">1080p · 1920 × 1080</option></select></label>
          <div className="field"><label htmlFor="chapter-language">{t('language')}</label><select id="chapter-language" value={value.language} disabled={saving || !languages.length} onChange={event => setLanguage(event.target.value)} aria-describedby="chapter-language-hint">
            {!languages.some(language => language.locale === value.language) && <option value={value.language}>{t('saved', { name: languageLabel(value.language, locale) })}</option>}
            {languages.map(language => <option key={language.locale} value={language.locale}>{language.label}</option>)}
          </select><span id="chapter-language-hint" className="field-hint">{t('languageHint')}</span></div>
          <div className="field"><label htmlFor="chapter-voice">{t('voice')}{' '}<span className="free-label">{t('free')}</span></label><div className="voice-row"><select id="chapter-voice" value={matchingVoice ? value.voice : ''} disabled={saving || !relevantVoices.length} onChange={event => set('voice', event.target.value)}>
            {!matchingVoice && <option value="" disabled>{t('chooseVoice')}</option>}
            {matchingVoice && !relevantVoices.some(voice => voice.name === value.voice) && <option value={value.voice}>{t('saved', { name: value.voice })}</option>}
            {relevantVoices.map(voice => <option key={voice.name} value={voice.name}>{voiceLabel(voice, locale)}</option>)}
          </select><button type="button" className="icon-button voice-preview" aria-label={t('audition')} disabled={audition.busy || saving || !matchingVoice} onClick={audition.preview}>{audition.busy ? <LoaderCircle size={17} className="spin" /> : <Volume2 size={17} />}</button></div>{!matchingVoice && <span className="field-hint">{t('voiceMismatch')}</span>}{audition.speech && <audio ref={audition.audio} src={audition.speech.url} controls aria-label={t('voicePreview')} className="voice-audio" />}{audition.error && <p className="inline-error" role="alert">{audition.error}</p>}</div>
          <label className="field generation-rate">{t('rate')}<span>{value.rate === 0 ? t('standard') : `${value.rate > 0 ? '+' : ''}${value.rate}%`}</span><input aria-label={t('narrationRate')} type="range" min={-50} max={100} step={5} value={value.rate} disabled={saving} onChange={event => set('rate', Number(event.target.value))} /></label>
          <label className="field">{t('model')}<select aria-label={t('model')} value={value.model} onChange={event => set('model', event.target.value)}><option value="">{defaultModel ? t('serverDefault', { name: defaultModel.displayName }) : t('defaultModel')}</option>{value.model && !models.some(model => model.id === value.model) && <option value={value.model}>{t('saved', { name: value.model })}</option>}{models.map(model => <option key={model.id} value={model.id}>{model.displayName}</option>)}</select><span className="field-hint">{t('modelHint')}</span></label>
          {loading && <p className="generation-catalog-status"><LoaderCircle size={12} className="spin" />{t('loadingCatalog')}</p>}{warning && <p className="generation-catalog-warning" role="status">{warning}</p>}
          <div className="generation-scope-note"><FilmNote /><p>{t('scopeHint')}<br />{t('scopePreserved')}</p></div>
        </aside></div>
      </div>
      <div id="generation-library-panel" role="tabpanel" hidden={tab !== 'library'}>{tab === 'library' && <ComponentGallery theme={value.theme} onCreative={() => { set('creationMode', 'creative'); setTab('settings'); }} />}</div>
    </div>
    <footer className="generation-dialog-footer"><span>{t('previewFirst')}</span><div><button type="button" className="button secondary" disabled={saving} onClick={() => apply(false)}>{t('save')}</button><button type="button" className="button primary" disabled={saving || busy || !canGenerate || !matchingVoice} onClick={() => apply(true)}>{saving ? <LoaderCircle size={15} className="spin" /> : <Sparkles size={15} />}{t(busy ? 'generating' : !canGenerate ? 'writeFirst' : 'generate')}</button></div></footer>
  </section></div>;
}

function FilmNote() { return <Layers3 size={18} strokeWidth={1.5} />; }
