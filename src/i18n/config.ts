export const UI_LOCALES = ['zh-CN', 'en'] as const;
export type UiLocale = typeof UI_LOCALES[number];
export const DEFAULT_UI_LOCALE: UiLocale = 'zh-CN';
export const UI_LOCALE_COOKIE = 'opentutor-ui-locale';

export function normalizeUiLocale(value: unknown): UiLocale {
  return value === 'en' ? 'en' : DEFAULT_UI_LOCALE;
}
