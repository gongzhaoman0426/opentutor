import { createInstance, type TOptions } from 'i18next';
import { normalizeUiLocale, type UiLocale } from './config';
import * as common from './messages/common';
import * as errors from './messages/errors';

// Pure formatters also run in the worker. These instances are never switched;
// request language is explicit and cannot leak into another request.
const translators = Object.fromEntries((['zh-CN', 'en'] as const).map(locale => {
  const instance = createInstance();
  void instance.init({ resources: { 'zh-CN': { common: common.zh, errors: errors.zh }, en: { common: common.en, errors: errors.en } }, lng: locale, fallbackLng: 'zh-CN', defaultNS: 'common', initAsync: false, interpolation: { escapeValue: false } });
  return [locale, instance];
})) as Record<UiLocale, ReturnType<typeof createInstance>>;

export function translateUi(locale: UiLocale, key: string, options?: TOptions): string {
  return String(translators[normalizeUiLocale(locale)].t(key, options));
}
