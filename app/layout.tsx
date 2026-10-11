import type { Metadata } from 'next';
import { cookies } from 'next/headers';
import { I18nProvider } from '@/i18n/provider';
import { normalizeUiLocale, UI_LOCALE_COOKIE } from '@/i18n/config';
import * as common from '@/i18n/messages/common';
import 'katex/dist/katex.min.css';
import './globals.css';

export async function generateMetadata(): Promise<Metadata> {
  const locale = normalizeUiLocale((await cookies()).get(UI_LOCALE_COOKIE)?.value);
  const messages = locale === 'en' ? common.en : common.zh;
  return { title: messages.appTitle, description: messages.appDescription };
}

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const locale = normalizeUiLocale((await cookies()).get(UI_LOCALE_COOKIE)?.value);
  return <html lang={locale}><body><I18nProvider initialLocale={locale}>{children}</I18nProvider></body></html>;
}
