'use client';

import Link from 'next/link';
import { ArrowUpRight, BookOpen, ChevronRight, Feather, FolderOpen, Plus, Settings2, Sprout } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { api, errorMessage } from './api';

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
  return <div className={`studio-shell ${editor ? 'editor-shell' : ''} ${className}`}>
    <aside className="main-sidebar">
      <Link href="/" className="brand" aria-label="OpenTutor 首页"><span className="brand-icon"><Sprout size={25} strokeWidth={1.65} /></span><span>OpenTutor<span className="brand-subtitle">让想法成为视频</span></span></Link>
      <div className="workspace-label">我的工作空间 <span className="tiny-pill">个人</span></div>
      <nav aria-label="主导航">
        <Link href="/" className="nav-item active"><FolderOpen size={18} />视频工作室<ChevronRight size={14} className="nav-chevron" /></Link>
        {onCreate && <button className="nav-item" onClick={onCreate}><Plus size={18} />创建新项目</button>}
        <a href="https://github.com/openai/codex" target="_blank" rel="noreferrer" className="nav-item"><BookOpen size={18} />Codex 引擎<ArrowUpRight size={13} className="nav-chevron" /></a>
      </nav>
      <div className="sidebar-note"><Feather size={24} strokeWidth={1.2} /><p>你专注内容。<br />让我们把它讲清楚。</p><span>从一份文稿，开始一个视频。</span></div>
      <div className="sidebar-footer"><span className="engine-dot" />开源视频创作工作室<span className="sidebar-version">v0.1</span></div>
    </aside>
    <main className="workspace-main">{children}</main>
  </div>;
}

export function ErrorBanner({ message, onDismiss }: { message: string; onDismiss?: () => void }) {
  return <div className="error-banner" role="alert"><span>{message}</span>{onDismiss && <button onClick={onDismiss} aria-label="关闭错误提示">×</button>}</div>;
}

export function SessionGate({ onSuccess }: { onSuccess: () => void }) {
  const modalRef = useModalFocus();
  const [token, setToken] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async (event: React.FormEvent) => {
    event.preventDefault(); setBusy(true); setError('');
    try { await api('/api/session', { method: 'POST', body: JSON.stringify({ token }) }); onSuccess(); }
    catch (e) { setError(errorMessage(e)); } finally { setBusy(false); }
  };
  return <div className="modal-overlay"><section ref={modalRef} className="modal-card session-card" role="dialog" aria-modal="true" aria-labelledby="session-title"><Settings2 size={28} /><h2 id="session-title">连接你的工作室</h2><p className="muted">此工作室已设置访问令牌，请输入管理员提供的令牌。</p><form onSubmit={submit}><label className="field-label" htmlFor="access-token">访问令牌</label><input id="access-token" type="password" autoFocus autoComplete="current-password" value={token} onChange={e => setToken(e.target.value)} required />{error && <ErrorBanner message={error} />}<button className="button primary full-width" disabled={busy}>{busy ? '正在连接…' : '进入工作室'}</button></form></section></div>;
}
