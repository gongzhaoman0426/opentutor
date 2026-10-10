'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { ArrowRight, LoaderCircle, X } from 'lucide-react';
import type { Project } from '@/shared/schema';
import { api, errorMessage } from './api';
import { ErrorBanner, useModalFocus } from './StudioShell';

export function CreateCourse({ onClose }: { onClose: () => void; useSample?: boolean }) {
  const router = useRouter();
  const [title, setTitle] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const modal = useModalFocus(() => { if (!busy) onClose(); });
  const create = async (event: React.FormEvent) => {
    event.preventDefault(); setBusy(true); setError('');
    try { const { project } = await api<{ project: Project }>('/api/projects', { method: 'POST', body: JSON.stringify({ title: title.trim() }) }); router.push(`/projects/${project.id}`); }
    catch (failure) { setError(errorMessage(failure)); setBusy(false); }
  };
  return <div className="modal-overlay" onMouseDown={event => { if (event.target === event.currentTarget && !busy) onClose(); }}><section ref={modal} className="modal-card simple-create" role="dialog" aria-modal="true" aria-labelledby="create-title"><div className="simple-create-heading"><div><span className="eyebrow">NEW PROJECT</span><h2 id="create-title">创建项目</h2></div><button className="icon-button" aria-label="关闭创建项目" onClick={onClose} disabled={busy}><X size={19} /></button></div><p>先起一个名字，再按章节编写文稿。</p><form onSubmit={create}><label className="field">项目名称<input autoFocus required maxLength={120} value={title} onChange={event => setTitle(event.target.value)} placeholder="例如：新产品发布 / 月度简报 / 城市故事" /></label>{error && <ErrorBanner message={error} />}<button className="button primary full-width" disabled={busy || !title.trim()}>{busy ? <LoaderCircle size={15} className="spin" /> : <ArrowRight size={15} />}{busy ? '正在创建…' : '开始编写'}</button></form></section></div>;
}
