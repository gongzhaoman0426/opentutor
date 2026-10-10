'use client';

import { useEffect, useRef, useState } from 'react';
import { Check, LoaderCircle, Volume2 } from 'lucide-react';
import type { GenerationSettings, SpeechResult } from '@/shared/schema';
import { api, errorMessage } from './api';
import { VideoIntentFields } from './VideoIntentFields';

type Voice = { name: string; locale: string; gender: string; displayName: string };
const voiceName = (voice: Voice) => {
  const short = voice.name.split('-').slice(2).join('-').replace(/Neural$/, '');
  const chinese: Record<string, string> = { Xiaoxiao: '晓晓', Xiaoyi: '晓伊', Yunjian: '云健', Yunxi: '云希', Yunxia: '云夏', Yunyang: '云扬' };
  return chinese[short] || short || voice.displayName;
};
export function SettingsForm({ value, onChange, disabled = false, scope = 'all' }: { value: GenerationSettings; onChange: (next: GenerationSettings) => void; disabled?: boolean; scope?: 'all' | 'speech' }) {
  const [voices, setVoices] = useState<Voice[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [speech, setSpeech] = useState<SpeechResult | null>(null);
  const audio = useRef<HTMLAudioElement>(null);
  useEffect(() => { let alive = true; api<{ voices: Voice[] }>('/api/voices').then(result => { if (alive) setVoices(result.voices); }).catch(() => {}); return () => { alive = false; }; }, []);
  const set = <K extends keyof GenerationSettings>(key: K, next: GenerationSettings[K]) => { onChange({ ...value, [key]: next }); if (key === 'voice' || key === 'rate') setSpeech(null); };
  const preview = async () => {
    setBusy(true); setError(''); setSpeech(null);
    try { const result = await api<{ speech: SpeechResult }>('/api/voices/preview', { method: 'POST', body: JSON.stringify({ voice: value.voice, rate: value.rate }) }); setSpeech(result.speech); }
    catch (e) { setError(errorMessage(e)); } finally { setBusy(false); }
  };
  useEffect(() => { if (speech) audio.current?.play().catch(() => {}); }, [speech]);
  const relevant = voices.filter(v => v.locale === value.language);
  const currentListed = relevant.some(v => v.name === value.voice);
  return <div className="settings-form">
    {scope === 'all' && <>
    <VideoIntentFields value={value} onChange={onChange} disabled={disabled} />
    <label className="field">目标观众<input value={value.audience} maxLength={200} onChange={e => set('audience', e.target.value)} placeholder="例如：新用户、团队同事、普通观众" disabled={disabled} /></label>
    <label className="field">配音语言<select value={value.language} disabled={disabled} onChange={e => onChange({ ...value, language: e.target.value as GenerationSettings['language'], voice: e.target.value === 'zh-CN' ? 'zh-CN-XiaoxiaoNeural' : 'en-US-AriaNeural' })}><option value="zh-CN">中文（普通话）</option><option value="en-US">English</option></select></label>
    <fieldset className="mode-field"><legend>内容篇幅</legend><div className="segmented-control"><button type="button" aria-pressed={value.mode === 'full'} className={value.mode === 'full' ? 'selected' : ''} disabled={disabled} onClick={() => set('mode', 'full')}>完整呈现</button><button type="button" aria-pressed={value.mode === 'summary'} className={value.mode === 'summary' ? 'selected' : ''} disabled={disabled} onClick={() => set('mode', 'summary')}>重点摘要</button></div><p className="field-hint">{value.mode === 'full' ? '保留原文事实、情节、示例与限定条件。' : '压缩内容，突出主要信息。'}</p></fieldset>
    </>}
    <div className="field"><label htmlFor="voice-choice">微软免费配音 <span className="free-label">FREE</span></label><div className="voice-row"><select id="voice-choice" value={value.voice} disabled={disabled} onChange={e => { set('voice', e.target.value); setSpeech(null); }}>
      {!currentListed && <option value={value.voice}>{value.voice === 'zh-CN-XiaoxiaoNeural' ? '晓晓 · 自然女声' : value.voice === 'en-US-AriaNeural' ? 'Aria · English' : value.voice}</option>}
      {relevant.map(voice => <option key={voice.name} value={voice.name}>{voiceName(voice)} · {voice.gender === 'Female' ? '女声' : '男声'}</option>)}
    </select><button className="icon-button voice-preview" type="button" aria-label="试听当前音色" title="试听当前音色" onClick={preview} disabled={busy || disabled}>{busy ? <LoaderCircle size={17} className="spin" /> : <Volume2 size={17} />}</button></div>{speech && <audio ref={audio} controls src={speech.url} className="voice-audio" aria-label="音色试听" />}{error && <p className="inline-error" role="alert">{error}</p>}</div>
    <label className="field range-field">语速 <span>{value.rate === 0 ? '标准' : `${value.rate > 0 ? '+' : ''}${value.rate}%`}</span><input type="range" min={-50} max={100} step={5} value={value.rate} disabled={disabled} onChange={e => set('rate', Number(e.target.value))} /></label>
    {scope === 'all' && <><fieldset className="theme-field"><legend>画面风格</legend><div className="theme-options"><button type="button" disabled={disabled} className={`theme-option sage ${value.theme === 'sage' ? 'chosen' : ''}`} onClick={() => set('theme', 'sage')} aria-pressed={value.theme === 'sage'}><span className="theme-preview">Aa<span /></span><span>草木绿</span>{value.theme === 'sage' && <Check size={14} />}</button><button type="button" disabled={disabled} className={`theme-option ink ${value.theme === 'ink' ? 'chosen' : ''}`} onClick={() => set('theme', 'ink')} aria-pressed={value.theme === 'ink'}><span className="theme-preview">Aa<span /></span><span>墨色</span>{value.theme === 'ink' && <Check size={14} />}</button></div></fieldset>
    <label className="field">视频分辨率<select value={value.resolution} disabled={disabled} onChange={e => set('resolution', e.target.value as GenerationSettings['resolution'])}><option value="720p">1280 × 720 · 横屏</option><option value="1080p">1920 × 1080 · 横屏</option></select></label></>}
  </div>;
}
