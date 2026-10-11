'use client';

import { Languages } from 'lucide-react';
import { useI18n } from './provider';
import { normalizeUiLocale } from './config';

export function LanguageSwitcher() {
  const { t, locale, setLocale } = useI18n();
  return <label className="ui-language-switcher" title={t('interfaceLanguage')}>
    <Languages size={15} aria-hidden="true" />
    <select aria-label={t('interfaceLanguage')} value={locale} onChange={event => setLocale(normalizeUiLocale(event.target.value))}>
      <option value="zh-CN" lang="zh-CN">中文</option>
      <option value="en" lang="en">English</option>
    </select>
  </label>;
}
