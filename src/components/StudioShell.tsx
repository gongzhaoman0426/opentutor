'use client';

import Link from 'next/link';
import { ArrowUpRight, BookOpen, ChevronRight, Feather, FolderOpen, Plus, Settings2, Sprout } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { api, errorMessage } from './api';
import { useI18n } from '@/i18n/provider';
import { LanguageSwitcher } from '@/i18n/LanguageSwitcher';

export function useModalFocus(onClose?: () => void, enabled = true) {
  const root = useRef<HTMLElement>(null);
  const close = useRef(onClose);
  useEffect(() => { close.current = onClose; }, [onClose]);
  useEffect(() => {
    if (!enabled || !root.current) return;
    const previous = document.activeElement as HTMLElement | null;
    const oldOverflow = document.body.style.overflow; document.body.style.overflow = 'hidden';
    const focusable = () => Array.from(root.current?.querySelectorAll<HTMLElement>('button:not(:disabled), a[href], input:not(:disabled):not([type="hidden"]), textarea:not(:disabled), select:not(:disabled), [tabindex="0"]') ?? []).filter(element => element.getClientRects().length > 0);
    if (!root.current.contains(document.activeElement)) focusable()[0]?.focus();
    const keyboard = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && close.current) { event.preventDefault(); close.current(); }
      if (event.key !== 'Tab') return;
      const items = focusable(); const first = items[0]; const last = items[items.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    };
    document.addEventListener('keydown', keyboard);
    return () => { document.removeEventListener('keydown', keyboard); document.body.style.overflow = oldOverflow; if (previous && document.contains(previous)) previous.focus(); };
  }, [enabled]);
  return root;
}

export function StudioShell({ children, onCreate, editor = false, className = '' }: { children: React.ReactNode; onCreate?: () => void; editor?: boolean; className?: string }) {
  const { t } = useI18n('studio');
  return <div className={`studio-shell ${editor ? 'editor-shell' : ''} ${className}`}>
    <aside className="main-sidebar">
      <Link href="/" className="brand" aria-label={t('homeLink')}><span className="brand-icon"><Sprout size={25} strokeWidth={1.65} /></span><span>OpenTutor<span className="brand-subtitle">{t('brandSubtitle')}</span></span></Link>
      <div className="workspace-label">{t('workspace')} <span className="tiny-pill">{t('personal')}</span></div>
      <nav aria-label={t('navigation')}>
        <Link href="/" className="nav-item active"><FolderOpen size={18} />{t('videoStudio')}<ChevronRight size={14} className="nav-chevron" /></Link>
        {onCreate && <button className="nav-item" onClick={onCreate}><Plus size={18} />{t('createProject')}</button>}
        <a href="https://github.com/openai/codex" target="_blank" rel="noreferrer" className="nav-item"><BookOpen size={18} />{t('codexEngine')}<ArrowUpRight size={13} className="nav-chevron" /></a>
      </nav>
      <div className="sidebar-note"><Feather size={24} strokeWidth={1.2} /><p>{t('noteFocus')}<br />{t('noteClarity')}</p><span>{t('noteStart')}</span></div>
      <div className="sidebar-footer"><span className="engine-dot" />{t('footer')}<span className="sidebar-version">v0.1</span></div>
    </aside>
    <main className="workspace-main">{children}</main>
  </div>;
}

export function ErrorBanner({ message, onDismiss }: { message: string; onDismiss?: () => void }) {
  const { t } = useI18n('studio');
  return <div className="error-banner" role="alert"><span>{message}</span>{onDismiss && <button onClick={onDismiss} aria-label={t('dismissError')}>×</button>}</div>;
}

export function SessionGate({ onSuccess }: { onSuccess: () => void }) {
  const { t, locale } = useI18n('studio');
  const modalRef = useModalFocus();
  const [token, setToken] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (event: React.FormEvent) => {
    event.preventDefault(); setBusy(true); setError(null);
    try { await api('/api/session', { method: 'POST', body: JSON.stringify({ token }) }); onSuccess(); }
    catch (e) { setError(e); } finally { setBusy(false); }
  };
  return <div className="modal-overlay"><section ref={modalRef} className="modal-card session-card" role="dialog" aria-modal="true" aria-labelledby="session-title"><div className="session-header"><Settings2 size={28} /><LanguageSwitcher /></div><h2 id="session-title">{t('sessionTitle')}</h2><p className="muted">{t('sessionHint')}</p><form onSubmit={submit}><label className="field-label" htmlFor="access-token">{t('accessToken')}</label><input id="access-token" type="password" autoFocus autoComplete="current-password" value={token} onChange={e => setToken(e.target.value)} required />{error ? <ErrorBanner message={errorMessage(error, locale)} /> : null}<button className="button primary full-width" disabled={busy}>{t(busy ? 'connecting' : 'enterStudio')}</button></form></section></div>;
}
