'use client';

import { useEffect, useState } from 'react';
import { Check, LoaderCircle, Volume2 } from 'lucide-react';
import type { GenerationSettings } from '@/shared/schema';
import { availableLanguages, defaultVoiceForLanguage, languageLabel, voiceLabel, voiceLocale, type Voice } from '@/shared/voices';
import { api, errorMessage } from './api';
import { VideoIntentFields } from './VideoIntentFields';
import { useVoicePreview } from './useVoicePreview';

export function SettingsForm({ value, onChange, disabled = false, scope = 'all' }: { value: GenerationSettings; onChange: (next: GenerationSettings) => void; disabled?: boolean; scope?: 'all' | 'speech' }) {
  const [voices, setVoices] = useState<Voice[]>([]);
  const [loading, setLoading] = useState(true);
  const [warning, setWarning] = useState('');
  const audition = useVoicePreview(value);
  useEffect(() => {
    let alive = true;
    const controller = new AbortController();
    api<{ voices: Voice[] }>('/api/voices', { signal: controller.signal })
      .then(result => { if (alive) setVoices(result.voices); })
      .catch(failure => { if (alive) setWarning(`音色列表暂时无法加载：${errorMessage(failure)}`); })
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
  const languages = availableLanguages(voices);
  const relevant = voices.filter(v => v.locale === value.language);
  const currentListed = relevant.some(v => v.name === value.voice);
  const selectedVoiceLocale = voices.find(voice => voice.name === value.voice)?.locale ?? voiceLocale(value.voice);
  const matchingVoice = selectedVoiceLocale === value.language;
  return <div className="settings-form">
    {scope === 'all' && <>
    <VideoIntentFields value={value} onChange={onChange} disabled={disabled} />
    <label className="field">目标观众<input value={value.audience} maxLength={200} onChange={e => set('audience', e.target.value)} placeholder="例如：新用户、团队同事、普通观众" disabled={disabled} /></label>
    <fieldset className="mode-field"><legend>内容篇幅</legend><div className="segmented-control"><button type="button" aria-pressed={value.mode === 'full'} className={value.mode === 'full' ? 'selected' : ''} disabled={disabled} onClick={() => set('mode', 'full')}>完整呈现</button><button type="button" aria-pressed={value.mode === 'summary'} className={value.mode === 'summary' ? 'selected' : ''} disabled={disabled} onClick={() => set('mode', 'summary')}>重点摘要</button></div><p className="field-hint">{value.mode === 'full' ? '保留原文事实、情节、示例与限定条件。' : '压缩内容，突出主要信息。'}</p></fieldset>
    </>}
    <div className="field"><label htmlFor="settings-language">视频语言</label><select id="settings-language" value={value.language} disabled={disabled || !languages.length} onChange={event => setLanguage(event.target.value)} aria-describedby="settings-language-hint">
      {!languages.some(language => language.locale === value.language) && <option value={value.language}>{languageLabel(value.language)} · 已保存</option>}
      {languages.map(language => <option key={language.locale} value={language.locale}>{language.label}</option>)}
    </select><span id="settings-language-hint" className="field-hint">用于画面文字与旁白；原始引用图片保留原文。</span></div>
    <div className="field"><label htmlFor="voice-choice">微软免费配音 <span className="free-label">FREE</span></label><div className="voice-row"><select id="voice-choice" value={matchingVoice ? value.voice : ''} disabled={disabled || !relevant.length} onChange={e => set('voice', e.target.value)}>
      {!matchingVoice && <option value="" disabled>请选择该语言音色</option>}
      {matchingVoice && !currentListed && <option value={value.voice}>{value.voice} · 已保存</option>}
      {relevant.map(voice => <option key={voice.name} value={voice.name}>{voiceLabel(voice)}</option>)}
    </select><button className="icon-button voice-preview" type="button" aria-label="试听当前音色" title="试听当前音色" onClick={audition.preview} disabled={audition.busy || disabled || !matchingVoice}>{audition.busy ? <LoaderCircle size={17} className="spin" /> : <Volume2 size={17} />}</button></div>{!matchingVoice && <span className="field-hint">已保存音色与视频语言不一致，请选择对应音色。</span>}{audition.speech && <audio ref={audition.audio} controls src={audition.speech.url} className="voice-audio" aria-label="音色试听" />}{audition.error && <p className="inline-error" role="alert">{audition.error}</p>}</div>
    {loading && <p className="field-hint" role="status">正在获取音色…</p>}{warning && <p className="generation-catalog-warning" role="status">{warning}</p>}
    <label className="field range-field">语速 <span>{value.rate === 0 ? '标准' : `${value.rate > 0 ? '+' : ''}${value.rate}%`}</span><input type="range" min={-50} max={100} step={5} value={value.rate} disabled={disabled} onChange={e => set('rate', Number(e.target.value))} /></label>
    {scope === 'all' && <><fieldset className="theme-field"><legend>画面风格</legend><div className="theme-options"><button type="button" disabled={disabled} className={`theme-option sage ${value.theme === 'sage' ? 'chosen' : ''}`} onClick={() => set('theme', 'sage')} aria-pressed={value.theme === 'sage'}><span className="theme-preview">Aa<span /></span><span>草木绿</span>{value.theme === 'sage' && <Check size={14} />}</button><button type="button" disabled={disabled} className={`theme-option ink ${value.theme === 'ink' ? 'chosen' : ''}`} onClick={() => set('theme', 'ink')} aria-pressed={value.theme === 'ink'}><span className="theme-preview">Aa<span /></span><span>墨色</span>{value.theme === 'ink' && <Check size={14} />}</button></div></fieldset>
    <label className="field">视频分辨率<select value={value.resolution} disabled={disabled} onChange={e => set('resolution', e.target.value as GenerationSettings['resolution'])}><option value="720p">1280 × 720 · 横屏</option><option value="1080p">1920 × 1080 · 横屏</option></select></label></>}
  </div>;
}
