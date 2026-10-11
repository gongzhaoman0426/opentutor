import { describe, expect, it } from 'vitest';
import { createUiI18n, resources } from '../src/i18n/resources';
import { normalizeUiLocale } from '../src/i18n/config';
import { formatRenderProgress } from '../src/shared/render-progress';
import { languageLabel, voiceLabel, availableLanguages } from '../src/shared/voices';
import { splitMarkdownChapters } from '../src/shared/chapters';
import { ApiError, errorMessage } from '../src/components/api';

function flatten(value: object, prefix = ''): Record<string, string> {
  return Object.fromEntries(Object.entries(value).flatMap(([key, item]) => typeof item === 'string' ? [[`${prefix}${key}`, item]] : Object.entries(flatten(item, `${prefix}${key}.`))));
}
const placeholders = (value: string) => [...value.matchAll(/{{\s*([^},]+)(?:,[^}]+)?\s*}}/g)].map(match => match[1].trim()).sort();

describe('UI internationalization', () => {
  it('ships matching translation keys and interpolation variables in both languages', () => {
    const zh = flatten(resources['zh-CN']); const en = flatten(resources.en);
    expect(Object.keys(en).sort()).toEqual(Object.keys(zh).sort());
    for (const [key, value] of Object.entries(zh)) {
      expect(en[key], key).toBeTruthy();
      expect(placeholders(en[key]), key).toEqual(placeholders(value));
    }
  });
  it('initializes synchronously and isolates languages between SSR trees', () => {
    const zh = createUiI18n('zh-CN'); const en = createUiI18n('en');
    expect(zh.isInitialized).toBe(true); expect(en.isInitialized).toBe(true);
    expect(zh.t('appTitle')).toBe('OpenTutor · 视频创作工作室');
    expect(en.t('appTitle')).toBe('OpenTutor · Video Studio');
    void en.changeLanguage('zh-CN');
    expect(zh.language).toBe('zh-CN');
    void zh.changeLanguage('en');
    expect(en.language).toBe('zh-CN');
    expect(normalizeUiLocale('fr')).toBe('zh-CN');
  });
  it('handles English plurals and preserves user data in interpolation', () => {
    const en = createUiI18n('en');
    expect(en.t('home:chapterCount', { count: 1 })).toBe('1 chapter');
    expect(en.t('home:chapterCount', { count: 2 })).toBe('2 chapters');
    expect(en.t('home:deleteWarning', { title: '<标题 & demo>' })).toContain('<标题 & demo>');
  });
  it('localizes voice display without changing voice IDs, locale filtering or samples', () => {
    const voices = [{ name: 'zh-CN-XiaoxiaoNeural', locale: 'zh-CN', gender: 'Female', displayName: 'Microsoft Xiaoxiao' }, { name: 'en-US-AriaNeural', locale: 'en-US', gender: 'Female', displayName: 'Aria' }];
    expect(languageLabel('zh-CN', 'en')).toBe('Chinese (Mandarin)');
    expect(languageLabel('zh-CN-shaanxi', 'en')).toBe('Chinese (Shaanxi Mandarin)');
    expect(voiceLabel(voices[0], 'en')).toBe('Xiaoxiao · Female');
    expect(voiceLabel(voices[0])).toBe('晓晓 · 女声');
    expect(availableLanguages(voices, 'en').map(value => value.locale)).toEqual(availableLanguages(voices).map(value => value.locale));
  });
  it('localizes progress and structured API failures while keeping unknown diagnostic detail', () => {
    expect(formatRenderProgress({ phase: 'rendering', renderedFrames: 1000, totalFrames: 29000, elapsedMs: 154000, framesPerSecond: 6.49 }, { locale: 'en' })).toBe('Rendering frames · 1,000/29,000 frames · 6.5 fps · Elapsed 2m 34s');
    const failure = new ApiError('请选择与视频语言匹配的音色。', 422, 'VOICE_LANGUAGE_MISMATCH');
    expect(errorMessage(failure, 'en')).toBe('Choose a voice that matches the video language.');
    expect(errorMessage(failure, 'zh-CN')).toBe(failure.message);
    expect(errorMessage(new Error('ffmpeg: diagnostic 1'), 'en')).toBe('ffmpeg: diagnostic 1');
  });
  it('localizes only fallback names during an explicit import, preserving source text and existing titles', () => {
    const labels = { imported: 'Imported text', introduction: 'Introduction', untitled: 'Untitled chapter' };
    const source = '中文原稿';
    expect(splitMarkdownChapters(source, labels)[0]).toMatchObject({ title: 'Imported text', markdown: source });
    expect(splitMarkdownChapters(source)[0].title).toBe('导入素材');
    expect(splitMarkdownChapters('# 原标题\n\n内容', labels)[0].title).toBe('原标题');
  });
});
