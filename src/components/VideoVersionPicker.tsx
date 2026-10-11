'use client';

import { History, LoaderCircle } from 'lucide-react';
import type { VideoVersionSummary } from '@/shared/schema';
import { languageLabel } from '@/shared/voices';
import { useI18n } from '@/i18n/provider';
import type { UiLocale } from '@/i18n/config';

function generationTime(value: string, locale: UiLocale) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat(locale, { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).format(date);
}
export function VideoVersionPicker({ versions, selectedId, selected, generating, pendingPreview, loading, onSelect }: { versions: VideoVersionSummary[]; selectedId: string; selected?: VideoVersionSummary; generating: boolean; pendingPreview: boolean; loading: boolean; onSelect: (id: string) => void }) {
  const { t, locale } = useI18n('preview');
  const latest = versions.find(version => version.current) ?? versions[0];
  const settings = selected?.settings;
  return <div className="video-version-picker">
    <div className="video-version-select-row"><label><History size={14} /><span>{t('versions')}</span><select aria-label={t('versions')} value={selectedId} onChange={event => onSelect(event.target.value)} disabled={loading && !versions.length}><option value="latest">{generating ? t('latestGenerating') : pendingPreview ? t('latestPartial') : latest ? t('latestVersion', { version: latest.version }) : t('latestPreview')}</option>{versions.map(version => <option key={version.id} value={version.id}>v{version.version} · {generationTime(version.createdAt, locale)}</option>)}</select></label>{loading && <LoaderCircle size={14} className="spin" aria-label={t('loadingVersions')} />}</div>
    {selected && !(pendingPreview && selectedId === 'latest') ? <div className="video-version-meta"><time dateTime={selected.createdAt}>{t('generatedAt', { time: generationTime(selected.createdAt, locale) })}</time>{settings && <span className="video-version-settings" aria-label={t('versionSettings')} title={`${languageLabel(settings.language, locale)} · ${settings.voice} · ${settings.resolution} · ${settings.creationMode === 'creative' ? t('creative') : t('stable')}`}>{languageLabel(settings.language, locale)} · {settings.voice.split('-').at(-1)?.replace(/Neural$/, '')} · {settings.resolution}</span>}</div> : <p className="video-version-meta">{pendingPreview && selectedId === 'latest' ? t('incompleteNote') : loading ? t('loadingChapterVersions') : versions.length ? t('chooseVersionNote') : t('emptyVersions')}</p>}
  </div>;
}
