'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { ArrowRight, LoaderCircle, X } from 'lucide-react';
import type { Project } from '@/shared/schema';
import { createEmptyChapter } from '@/shared/chapters';
import { useI18n } from '@/i18n/provider';
import { api, errorMessage } from './api';
import { ErrorBanner, useModalFocus } from './StudioShell';

export function CreateCourse({ onClose }: { onClose: () => void; useSample?: boolean }) {
  const { t, locale } = useI18n('editor');
  const router = useRouter();
  const [title, setTitle] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const modal = useModalFocus(() => { if (!busy) onClose(); });
  const create = async (event: React.FormEvent) => {
    event.preventDefault(); setBusy(true); setError(null);
    try { const { project } = await api<{ project: Project }>('/api/projects', { method: 'POST', body: JSON.stringify({ title: title.trim(), chapters: [createEmptyChapter(t('defaultChapterName', { number: 1 }))] }) }); router.push(`/projects/${project.id}`); }
    catch (failure) { setError(failure); setBusy(false); }
  };
  const errorText = error ? errorMessage(error, locale) : '';
  return <div className="modal-overlay" onMouseDown={event => { if (event.target === event.currentTarget && !busy) onClose(); }}><section ref={modal} className="modal-card simple-create" role="dialog" aria-modal="true" aria-labelledby="create-title"><div className="simple-create-heading"><div><span className="eyebrow">{t('createEyebrow')}</span><h2 id="create-title">{t('createTitle')}</h2></div><button className="icon-button" aria-label={t('closeCreate')} onClick={onClose} disabled={busy}><X size={19} /></button></div><p>{t('createDescription')}</p><form onSubmit={create}><label className="field">{t('projectName')}<input autoFocus required maxLength={120} value={title} onChange={event => setTitle(event.target.value)} placeholder={t('projectPlaceholder')} /></label>{errorText && <ErrorBanner message={errorText} />}<button className="button primary full-width" disabled={busy || !title.trim()}>{busy ? <LoaderCircle size={15} className="spin" /> : <ArrowRight size={15} />}{busy ? t('creating') : t('startWriting')}</button></form></section></div>;
}
