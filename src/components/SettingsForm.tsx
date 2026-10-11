'use client';

import { useEffect, useState } from 'react';
import { Check, LoaderCircle, Volume2 } from 'lucide-react';
import type { GenerationSettings } from '@/shared/schema';
import { availableLanguages, defaultVoiceForLanguage, languageLabel, voiceLabel, voiceLocale, type Voice } from '@/shared/voices';
import { api, errorMessage } from './api';
import { VideoIntentFields } from './VideoIntentFields';
import { useVoicePreview } from './useVoicePreview';
import { useI18n } from '@/i18n/provider';

export function SettingsForm({ value, onChange, disabled = false, scope = 'all' }: { value: GenerationSettings; onChange: (next: GenerationSettings) => void; disabled?: boolean; scope?: 'all' | 'speech' }) {
  const { t, locale } = useI18n('settings');
  const [voices, setVoices] = useState<Voice[]>([]);
  const [loading, setLoading] = useState(true);
  const [warning, setWarning] = useState<unknown>(null);
  const audition = useVoicePreview(value);
  useEffect(() => {
    let alive = true;
    const controller = new AbortController();
    api<{ voices: Voice[] }>('/api/voices', { signal: controller.signal })
      .then(result => { if (alive) setVoices(result.voices); })
      .catch(failure => { if (alive) setWarning(failure); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; controller.abort(); };
  }, []);
  const set = <K extends keyof GenerationSettings>(key: K, next: GenerationSettings[K]) => {
    if (key === 'language' || key === 'voice' || key === 'rate') audition.cancel();
    onChange({ ...value, [key]: next });
  };
  const setLanguage = (language: string) => {
    if (language === value.language) return;
    const voice = defaultVoiceForLanguage(voices, language, value.voice);
    if (!voice) return;
    audition.cancel();
    onChange({ ...value, language: language as GenerationSettings['language'], voice });
  };
  const languages = availableLanguages(voices, locale);
  const relevant = voices.filter(v => v.locale === value.language);
  const currentListed = relevant.some(v => v.name === value.voice);
  const selectedVoiceLocale = voices.find(voice => voice.name === value.voice)?.locale ?? voiceLocale(value.voice);
  const matchingVoice = selectedVoiceLocale === value.language;
  return <div className="settings-form">
    {scope === 'all' && <>
    <VideoIntentFields value={value} onChange={onChange} disabled={disabled} />
    <label className="field">{t('audience')}<input value={value.audience} maxLength={200} onChange={e => set('audience', e.target.value)} placeholder={t('audiencePlaceholder')} disabled={disabled} /></label>
    <fieldset className="mode-field"><legend>{t('contentLength')}</legend><div className="segmented-control"><button type="button" aria-pressed={value.mode === 'full'} className={value.mode === 'full' ? 'selected' : ''} disabled={disabled} onClick={() => set('mode', 'full')}>{t('full')}</button><button type="button" aria-pressed={value.mode === 'summary'} className={value.mode === 'summary' ? 'selected' : ''} disabled={disabled} onClick={() => set('mode', 'summary')}>{t('summary')}</button></div><p className="field-hint">{t(value.mode === 'full' ? 'fullHint' : 'summaryHint')}</p></fieldset>
    </>}
    <div className="field"><label htmlFor="settings-language">{t('language')}</label><select id="settings-language" value={value.language} disabled={disabled || !languages.length} onChange={event => setLanguage(event.target.value)} aria-describedby="settings-language-hint">
      {!languages.some(language => language.locale === value.language) && <option value={value.language}>{t('saved', { name: languageLabel(value.language, locale) })}</option>}
      {languages.map(language => <option key={language.locale} value={language.locale}>{language.label}</option>)}
    </select><span id="settings-language-hint" className="field-hint">{t('languageHint')}</span></div>
    <div className="field"><label htmlFor="voice-choice">{t('voice')}{' '}<span className="free-label">{t('free')}</span></label><div className="voice-row"><select id="voice-choice" value={matchingVoice ? value.voice : ''} disabled={disabled || !relevant.length} onChange={e => set('voice', e.target.value)}>
      {!matchingVoice && <option value="" disabled>{t('chooseVoice')}</option>}
      {matchingVoice && !currentListed && <option value={value.voice}>{t('saved', { name: value.voice })}</option>}
      {relevant.map(voice => <option key={voice.name} value={voice.name}>{voiceLabel(voice, locale)}</option>)}
    </select><button className="icon-button voice-preview" type="button" aria-label={t('audition')} title={t('audition')} onClick={audition.preview} disabled={audition.busy || disabled || !matchingVoice}>{audition.busy ? <LoaderCircle size={17} className="spin" /> : <Volume2 size={17} />}</button></div>{!matchingVoice && <span className="field-hint">{t('voiceMismatch')}</span>}{audition.speech && <audio ref={audition.audio} controls src={audition.speech.url} className="voice-audio" aria-label={t('voicePreview')} />}{audition.error && <p className="inline-error" role="alert">{audition.error}</p>}</div>
    {loading && <p className="field-hint" role="status">{t('loadingVoices')}</p>}{!!warning && <p className="generation-catalog-warning" role="status">{t('voicesUnavailable', { error: errorMessage(warning, locale) })}</p>}
    <label className="field range-field">{t('rate')}<span>{value.rate === 0 ? t('standard') : `${value.rate > 0 ? '+' : ''}${value.rate}%`}</span><input type="range" min={-50} max={100} step={5} value={value.rate} disabled={disabled} onChange={e => set('rate', Number(e.target.value))} /></label>
    {scope === 'all' && <><fieldset className="theme-field"><legend>{t('visualStyle')}</legend><div className="theme-options"><button type="button" disabled={disabled} className={`theme-option sage ${value.theme === 'sage' ? 'chosen' : ''}`} onClick={() => set('theme', 'sage')} aria-pressed={value.theme === 'sage'}><span className="theme-preview">Aa<span /></span><span>{t('sageColor')}</span>{value.theme === 'sage' && <Check size={14} />}</button><button type="button" disabled={disabled} className={`theme-option ink ${value.theme === 'ink' ? 'chosen' : ''}`} onClick={() => set('theme', 'ink')} aria-pressed={value.theme === 'ink'}><span className="theme-preview">Aa<span /></span><span>{t('inkColor')}</span>{value.theme === 'ink' && <Check size={14} />}</button></div></fieldset>
    <label className="field">{t('resolution')}<select value={value.resolution} disabled={disabled} onChange={e => set('resolution', e.target.value as GenerationSettings['resolution'])}><option value="720p">{t('landscape', { resolution: '1280 × 720' })}</option><option value="1080p">{t('landscape', { resolution: '1920 × 1080' })}</option></select></label></>}
  </div>;
}
