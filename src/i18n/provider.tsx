'use client';

import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { I18nextProvider, useTranslation } from 'react-i18next';
import type { TOptions } from 'i18next';
import { createUiI18n } from './resources';
import { normalizeUiLocale, UI_LOCALE_COOKIE, type UiLocale } from './config';

export function I18nProvider({ initialLocale, children }: { initialLocale: UiLocale; children: ReactNode }) {
  // One instance per React tree: concurrent SSR requests must not share language.
  const [instance] = useState(() => createUiI18n(initialLocale));
  useEffect(() => {
    const syncDocument = () => {
      document.documentElement.lang = normalizeUiLocale(instance.resolvedLanguage);
      document.title = instance.t('appTitle', { ns: 'common' });
      document.querySelector('meta[name="description"]')?.setAttribute('content', instance.t('appDescription', { ns: 'common' }));
    };
    syncDocument();
    instance.on('languageChanged', syncDocument);
    return () => { instance.off('languageChanged', syncDocument); };
  }, [instance]);
  return <I18nextProvider i18n={instance}>{children}</I18nextProvider>;
}

export function useI18n(namespace = 'common') {
  const { i18n } = useTranslation(namespace);
  // Stable callbacks let editors keep their autosave/polling lifecycle intact.
  const t = useCallback((key: string, options?: TOptions): string => String(i18n.t(key, { ns: namespace, ...options })), [i18n, namespace]);
  const setLocale = useCallback((value: UiLocale) => {
    const next = normalizeUiLocale(value);
    document.cookie = `${UI_LOCALE_COOKIE}=${next}; Path=/; Max-Age=31536000; SameSite=Lax${location.protocol === 'https:' ? '; Secure' : ''}`;
    void i18n.changeLanguage(next);
  }, [i18n]);
  return { t, locale: normalizeUiLocale(i18n.resolvedLanguage), setLocale };
}
