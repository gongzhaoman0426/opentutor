import { describe, expect, it } from 'vitest';
import { SettingsSchema, defaultSettings } from '../src/shared/schema';
import { availableLanguages, defaultVoiceForLanguage, languageLabel, voiceLabel, voiceLocale, voicePreviewText, type Voice } from '../src/shared/voices';
import { rememberChapterSettings } from '../src/shared/chapter-settings';
import { getChapterSourceKey } from '../src/shared/chapters';
import { directorCacheKey } from '../src/engine/pipeline';

const voice = (locale: string, name: string): Voice => ({ locale, name: `${locale}-${name}Neural`, gender: 'Female', displayName: name });
const catalogue = [voice('en-US', 'Jenny'), voice('ja-JP', 'Keita'), voice('zh-CN', 'Xiaoxiao'), voice('en-US', 'Aria'), voice('ja-JP', 'Nanami'), voice('iu-Latn-CA', 'Siqiniq'), voice('zh-CN-shaanxi', 'Xiaoni')];

describe('video language and Microsoft voices', () => {
  it.each(catalogue)('accepts catalogue locale $locale and recovers it from $name', (item) => {
    expect(SettingsSchema.parse({ language: item.locale, voice: item.name })).toMatchObject({ language: item.locale, voice: item.name });
    expect(voiceLocale(item.name)).toBe(item.locale);
  });
  it('keeps legacy defaults and rejects malformed locale and voice strings', () => {
    expect(SettingsSchema.parse({})).toEqual(defaultSettings);
    for (const language of ['', '../en-US', 'en_US', '日本語', 'en-US;curl']) expect(SettingsSchema.safeParse({ language }).success).toBe(false);
    for (const name of ['', '../en-US-AriaNeural', 'ja-JP-NameNeural;ls', 'zh-CN-Xiaoxiao']) {
      expect(SettingsSchema.safeParse({ voice: name }).success).toBe(false);
      expect(voiceLocale(name)).toBe('');
    }
  });
  it('derives unique language choices from available voices and only selects within the chosen locale', () => {
    const languages = availableLanguages(catalogue).map(item => item.locale);
    expect(languages.slice(0, 3)).toEqual(['zh-CN', 'en-US', 'ja-JP']);
    expect(new Set(languages)).toEqual(new Set(catalogue.map(item => item.locale)));
    expect(languages).toHaveLength(new Set(languages).size);
    expect(defaultVoiceForLanguage(catalogue, 'en-US', 'zh-CN-XiaoxiaoNeural')).toBe('en-US-AriaNeural');
    expect(defaultVoiceForLanguage(catalogue, 'en-US', 'en-US-JennyNeural')).toBe('en-US-JennyNeural');
    expect(defaultVoiceForLanguage(catalogue, 'ja-JP', 'en-US-AriaNeural')).toBe('ja-JP-NanamiNeural');
    expect(defaultVoiceForLanguage(catalogue, 'fr-FR')).toBe('');
    expect(languageLabel('zh-CN-shaanxi')).toContain('陕西');
    expect(languageLabel('iu-Cans-CA')).toContain('音节');
    expect(voiceLabel(catalogue.at(-1)!)).toBe('Xiaoni · 女声');
  });
  it('auditions in the voice language, with locally read digits for other catalogue languages', () => {
    expect(voicePreviewText('ja-JP-NanamiNeural')).toContain('動画');
    expect(voicePreviewText('en-GB-SoniaNeural')).toContain('Welcome');
    expect(voicePreviewText('zh-CN-shaanxi-XiaoniNeural')).toContain('欢迎');
    expect(voicePreviewText('zh-HK-HiuGaaiNeural')).toContain('歡迎嚟');
    expect(voicePreviewText('iu-Cans-CA-SiqiniqNeural')).toBe('1, 2, 3. 4, 5, 6.');
  });
  it('inherits language with its voice and invalidates generated chapter and director caches', () => {
    const chapters = [{ id: 'a', title: 'A', markdown: '正文' }, { id: 'b', title: 'B', markdown: '后续正文' }];
    const project = { settings: defaultSettings, markdown: '', chapters, assets: [] };
    const japanese = SettingsSchema.parse({ language: 'ja-JP', voice: 'ja-JP-NanamiNeural' });
    const changed = { ...project, ...rememberChapterSettings(project, 'a', japanese) };
    expect(changed.settings).toMatchObject(japanese);
    expect(changed.chapters[1].settings ?? changed.settings).toMatchObject(japanese);
    expect(getChapterSourceKey(changed, changed.chapters[0])).not.toBe(getChapterSourceKey(project, chapters[0]));
    const snapshot = { id: 'owner', title: '来源', ...project, revision: 1, lesson: null };
    const job = { kind: 'preview' as const, snapshot, sceneId: null, instruction: null };
    expect(directorCacheKey({ ...job, snapshot: { ...snapshot, settings: japanese } })).not.toBe(directorCacheKey(job));
  });
});
