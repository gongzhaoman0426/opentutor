'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { ArrowRight, ArrowUpRight, BookOpen, Check, Clock3, Copy, Leaf, LoaderCircle, Plus, Search, Trash2, Waves } from 'lucide-react';
import type { Project } from '@/shared/schema';
import { ErrorBanner, SessionGate, useModalFocus } from '@/components/StudioShell';
import { CreateCourse } from '@/components/CreateCourse';
import { activeStatus, api, ApiError, errorMessage, formatDate } from '@/components/api';
import { useI18n } from '@/i18n/provider';
import { LanguageSwitcher } from '@/i18n/LanguageSwitcher';

const chapterVideoCount = (project: Project) => Object.values(project.chapterVideos ?? {}).filter(video => video.renderPlan).length;
const hasPreview = (project: Project) => chapterVideoCount(project) > 0 || !!project.renderPlan;

type Health = { ready: boolean; checks: Record<string, { ready: boolean; error?: string }> };

export default function Home() {
  const { t, locale } = useI18n('home');
  const [projects, setProjects] = useState<Project[]>([]);
  const [health, setHealth] = useState<Health | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [needsSession, setNeedsSession] = useState(false);
  const [create, setCreate] = useState<'empty' | 'sample' | null>(null);
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState('all');
  const [deleteTarget, setDeleteTarget] = useState<Project | null>(null);
  const [actionBusy, setActionBusy] = useState<string | null>(null);
  const deleteModal = useModalFocus(() => { if (!actionBusy) setDeleteTarget(null); }, !!deleteTarget);
  const load = useCallback(async () => {
    setLoading(true); setError(null);
    const results = await Promise.allSettled([api<{ projects: Project[] }>('/api/projects'), api<Health>('/api/health')]);
    if (results[0].status === 'fulfilled') { setProjects(results[0].value.projects); setNeedsSession(false); }
    else if (results[0].reason instanceof ApiError && results[0].reason.status === 401) setNeedsSession(true);
    else setError(results[0].reason);
    if (results[1].status === 'fulfilled') setHealth(results[1].value);
    setLoading(false);
  }, []);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    if (!projects.some(p => activeStatus(p.latestJob?.status))) return;
    const interval = setInterval(() => { api<{ projects: Project[] }>('/api/projects').then(({ projects: next }) => setProjects(next)).catch(() => {}); }, 4000);
    return () => clearInterval(interval);
  }, [projects]);
  const duplicate = async (project: Project) => {
    setActionBusy(project.id); setError(null);
    const suffix = t('copySuffix');
    try { const { project: copy } = await api<{ project: Project }>('/api/projects', { method: 'POST', body: JSON.stringify({ title: `${project.title.slice(0, 120 - suffix.length)}${suffix}`, markdown: project.markdown, ...(project.sourceMode === 'chapters' ? { chapters: project.chapters } : {}), settings: project.settings, assets: project.assets }) }); setProjects(p => [copy, ...p]); }
    catch (e) { setError(e); } finally { setActionBusy(null); }
  };
  const remove = async () => {
    if (!deleteTarget) return; setActionBusy(deleteTarget.id);
    try { await api(`/api/projects/${deleteTarget.id}`, { method: 'DELETE' }); setProjects(p => p.filter(v => v.id !== deleteTarget.id)); setDeleteTarget(null); }
    catch (e) { setError(e); } finally { setActionBusy(null); }
  };
  const filtered = projects.filter(p => p.title.toLowerCase().includes(search.toLowerCase()) && (filter === 'all' || (filter === 'ready' ? hasPreview(p) : activeStatus(p.latestJob?.status))));
  const missing = health ? Object.entries(health.checks).filter(([, value]) => !value.ready) : [];
  const names: Record<string, string> = { database: t('healthDatabase'), redis: t('healthRedis'), worker: t('healthWorker'), codex: t('healthCodex'), speech: t('healthSpeech') };
  return <div className="course-home">
    <header className="workspace-topbar"><Link href="/" className="course-home-brand"><Leaf size={20} />OpenTutor</Link><div className="topbar-right"><LanguageSwitcher /><span className={`connection-badge ${health?.ready ? '' : 'pending'}`}><span />{health?.ready ? t('engineReady') : health ? t('servicesPending') : t('connecting')}</span><span className="user-avatar" aria-label={t('personalWorkspace')}>{t('avatar')}</span></div></header>
    <div className="dashboard-content"><div className="page-intro"><div><p className="eyebrow">{t('eyebrow')}</p><h1>{t('title')}</h1><p>{t('introduction')}</p></div><div className="home-create-actions"><button className="button primary" onClick={() => setCreate('empty')}><Plus size={17} />{t('createProject')}</button></div></div>
    {error ? <ErrorBanner message={errorMessage(error, locale)} onDismiss={() => setError(null)} /> : null}
    {missing.length > 0 && <div className="connection-notice"><span className="notice-icon"><Waves size={18} /></span><div><strong>{t('servicesNotice')}</strong><p>{missing.map(([name, check]) => `${names[name] || name}${check.error ? `: ${errorMessage(new Error(check.error), locale)}` : ''}`).join(' · ')}</p></div><button className="text-button" onClick={load}>{t('recheck')}</button></div>}
    <section className="courses-section"><div className="section-heading"><div><h2>{t('projectList')} <span>{projects.length}</span></h2></div><div className="course-controls"><div className="filter-tabs" aria-label={t('filterLabel')}>{[['all', 'filterAll'], ['ready', 'filterReady'], ['running', 'filterRunning']].map(([value, label]) => <button key={value} onClick={() => setFilter(value)} className={filter === value ? 'active' : ''}>{t(label)}</button>)}</div><label className="search-field"><Search size={15} /><input value={search} onChange={e => setSearch(e.target.value)} placeholder={t('search')} aria-label={t('search')} /></label></div></div>
      <div className="course-list-viewport">{loading ? <div className="loading-state"><LoaderCircle size={24} className="spin" /><span>{t('loading')}</span></div> : filtered.length ? <div className="course-grid">{filtered.map((project, index) => <article className="course-card" key={project.id}>
        <Link href={`/projects/${project.id}`} className={`course-cover cover-${index % 3}`}><div className="cover-meta"><span>{t(project.settings.mode === 'full' ? 'fullMode' : 'summaryMode')}</span><span>{t('videoNumber', { number: String(index + 1).padStart(2, '0') })}</span></div><div className="cover-title">{project.title}</div><div className="cover-motif" aria-hidden="true">{index % 3 === 0 ? <><i /><i /><i /><ArrowUpRight size={55} /></> : index % 3 === 1 ? <><span>{t('motif')}</span><Leaf size={58} strokeWidth={0.9} /></> : <><span className="motif-circle" /><span className="motif-circle" /><span className="motif-circle" /></>}</div><span className="cover-open">{t('openProject')}<ArrowRight size={15} /></span></Link>
        <div className="course-card-body"><div className="course-status"><span className={`status-pill ${project.latestJob?.status === 'failed' ? 'failed' : activeStatus(project.latestJob?.status) ? 'running' : hasPreview(project) ? 'ready' : ''}`}>{activeStatus(project.latestJob?.status) ? <LoaderCircle size={11} className="spin" /> : hasPreview(project) ? <Check size={11} /> : <span className="status-dot" />}{project.latestJob?.status === 'failed' ? t('taskFailed') : activeStatus(project.latestJob?.status) ? t(`common:jobStatuses.${project.latestJob!.status}`) : chapterVideoCount(project) ? t(Object.values(project.chapterVideos ?? {}).some(video => video.current) ? 'previewReady' : 'needsUpdate') : t(project.renderPlan ? 'historicalPreview' : 'draft')}</span><span className="revision-label">{t('draftRevision', { revision: project.revision })}</span></div><Link href={`/projects/${project.id}`} className="course-name">{project.title}</Link><div className="course-meta"><span>{t('chapterCount', { count: project.chapters?.length ?? 1 })}</span><span>·</span><span>{chapterVideoCount(project) ? t('videoCount', { count: chapterVideoCount(project) }) : t(project.renderPlan ? 'historicalVideo' : 'waitingToGenerate')}</span></div><div className="course-card-footer"><span><Clock3 size={12} />{t('updated', { date: formatDate(project.updatedAt, locale) })}</span><div><button className="icon-button" title={t('copyTitle')} aria-label={t('copyProject', { title: project.title })} disabled={actionBusy === project.id} onClick={() => duplicate(project)}><Copy size={14} /></button><button className="icon-button" title={t('deleteTitle')} aria-label={t('deleteProject', { title: project.title })} disabled={actionBusy === project.id || activeStatus(project.latestJob?.status)} onClick={() => setDeleteTarget(project)}><Trash2 size={14} /></button></div></div></div>
      </article>)}<button className="new-course-card" onClick={() => setCreate('empty')}><span><Plus size={26} strokeWidth={1.4} /></span><strong>{t('newProject')}</strong><p>{t('newProjectHint')}</p></button></div> : projects.length || search || filter !== 'all' ? <div className="empty-state compact"><Search size={25} /><h3>{t('noMatches')}</h3><p>{t('noMatchesHint')}</p><button className="text-button" onClick={() => { setFilter('all'); setSearch(''); }}>{t('showAll')}</button></div> : <div className="empty-state"><div className="empty-book"><BookOpen size={33} strokeWidth={1.2} /><span>+</span></div><h3>{t('firstVideo')}</h3><p>{t('firstVideoHint')}<br />{t('firstVideoDetail')}</p><button className="button primary" onClick={() => setCreate('empty')}><Plus size={16} />{t('firstProject')}</button></div>}
    </div></section><footer className="dashboard-footer"><span><Leaf size={13} />{t('footer')}</span><span>{t('openSource')}</span></footer></div>
    {create && <CreateCourse onClose={() => setCreate(null)} />}
    {needsSession && <SessionGate onSuccess={load} />}
    {deleteTarget && <div className="modal-overlay"><section ref={deleteModal} className="modal-card confirm-modal" role="dialog" aria-modal="true" aria-labelledby="delete-title"><h2 id="delete-title">{t('deleteHeading')}</h2><p>{t('deleteWarning', { title: deleteTarget.title })}</p><div className="confirm-actions"><button className="button secondary" onClick={() => setDeleteTarget(null)} disabled={!!actionBusy}>{t('keepProject')}</button><button className="button danger" onClick={remove} disabled={!!actionBusy}>{t(actionBusy ? 'deleting' : 'confirmDelete')}</button></div></section></div>}
  </div>;
}
