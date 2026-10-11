import { createInstance } from 'i18next';
import { DEFAULT_UI_LOCALE, UI_LOCALES, type UiLocale } from './config';
import * as common from './messages/common';
import * as errors from './messages/errors';
import * as preview from './messages/preview';
import * as editor from './messages/editor';
import * as home from './messages/home';
import * as studio from './messages/studio';
import * as settings from './messages/settings';

export const resources = {
  'zh-CN': { common: common.zh, errors: errors.zh, preview: preview.zh, editor: editor.zh, home: home.zh, studio: studio.zh, settings: settings.zh },
  en: { common: common.en, errors: errors.en, preview: preview.en, editor: editor.en, home: home.en, studio: studio.en, settings: settings.en },
};

export function createUiI18n(locale: UiLocale) {
  const instance = createInstance();
  void instance.init({
    resources, lng: locale, fallbackLng: DEFAULT_UI_LOCALE,
    supportedLngs: [...UI_LOCALES], load: 'currentOnly',
    ns: Object.keys(resources['zh-CN']), defaultNS: 'common', fallbackNS: 'common',
    initAsync: false, interpolation: { escapeValue: false },
  });
  return instance;
}
