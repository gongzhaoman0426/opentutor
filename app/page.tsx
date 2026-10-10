'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { ArrowDown, ArrowRight, ArrowUpRight, BookOpen, Check, Clock3, Copy, FileText, Film, Leaf, LoaderCircle, Plus, Search, Sparkles, Trash2, Waves } from 'lucide-react';
import type { Project } from '@/shared/schema';
import { ErrorBanner, SessionGate, useModalFocus } from '@/components/StudioShell';
import { CreateCourse } from '@/components/CreateCourse';
import { activeStatus, api, ApiError, errorMessage, formatDate, formatTime, jobLabels } from '@/components/api';

const chapterVideoCount = (project: Project) => Object.values(project.chapterVideos ?? {}).filter(video => video.renderPlan).length;
const hasPreview = (project: Project) => chapterVideoCount(project) > 0 || !!project.renderPlan;

type Health = { ready: boolean; checks: Record<string, { ready: boolean; error?: string }> };

export default function Home() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [health, setHealth] = useState<Health | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [needsSession, setNeedsSession] = useState(false);
  const [create, setCreate] = useState<'empty' | 'sample' | null>(null);
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState('all');
  const [deleteTarget, setDeleteTarget] = useState<Project | null>(null);
  const [actionBusy, setActionBusy] = useState<string | null>(null);
  const deleteModal = useModalFocus(() => { if (!actionBusy) setDeleteTarget(null); }, !!deleteTarget);
  const load = useCallback(async () => {
    setLoading(true); setError('');
    const results = await Promise.allSettled([api<{ projects: Project[] }>('/api/projects'), api<Health>('/api/health')]);
    if (results[0].status === 'fulfilled') { setProjects(results[0].value.projects); setNeedsSession(false); }
    else if (results[0].reason instanceof ApiError && results[0].reason.status === 401) setNeedsSession(true);
    else setError(errorMessage(results[0].reason));
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
    setActionBusy(project.id); setError('');
    try { const { project: copy } = await api<{ project: Project }>('/api/projects', { method: 'POST', body: JSON.stringify({ title: `${project.title.slice(0, 114)} · 副本`, markdown: project.markdown, ...(project.sourceMode === 'chapters' ? { chapters: project.chapters } : {}), settings: project.settings, assets: project.assets }) }); setProjects(p => [copy, ...p]); }
    catch (e) { setError(errorMessage(e)); } finally { setActionBusy(null); }
  };
  const remove = async () => {
    if (!deleteTarget) return; setActionBusy(deleteTarget.id);
    try { await api(`/api/projects/${deleteTarget.id}`, { method: 'DELETE' }); setProjects(p => p.filter(v => v.id !== deleteTarget.id)); setDeleteTarget(null); }
    catch (e) { setError(errorMessage(e)); } finally { setActionBusy(null); }
  };
  const filtered = projects.filter(p => p.title.toLowerCase().includes(search.toLowerCase()) && (filter === 'all' || (filter === 'ready' ? hasPreview(p) : activeStatus(p.latestJob?.status))));
  const missing = health ? Object.entries(health.checks).filter(([, value]) => !value.ready) : [];
  const names: Record<string, string> = { database: '数据库', redis: '任务队列', worker: '后台 Worker', codex: 'Codex', speech: '微软 TTS' };
  return <div className="course-home">
    <header className="workspace-topbar"><Link href="/" className="course-home-brand"><Leaf size={20} />OpenTutor</Link><div className="topbar-right"><span className={`connection-badge ${health?.ready ? '' : 'pending'}`}><span />{health?.ready ? '引擎已就绪' : health ? '服务待连接' : '正在连接'}</span><span className="user-avatar" aria-label="个人工作空间">我</span></div></header>
    <div className="dashboard-content"><div className="page-intro"><div><p className="eyebrow">YOUR VIDEO STUDIO</p><h1>我的项目</h1><p>产品介绍、信息汇报、故事叙述或知识讲解。从 Markdown 开始，每章生成一个视频。</p></div><div className="home-create-actions"><button className="button primary" onClick={() => setCreate('empty')}><Plus size={17} />创建项目</button></div></div>
    {error && <ErrorBanner message={error} onDismiss={() => setError('')} />}
    {missing.length > 0 && <div className="connection-notice"><span className="notice-icon"><Waves size={18} /></span><div><strong>工作室已打开，生成服务还在等待连接。</strong><p>{missing.map(([name, check]) => `${names[name] || name}${check.error ? `：${check.error}` : ''}`).join(' · ')}</p></div><button className="text-button" onClick={load}>重新检查</button></div>}
    <section className="courses-section"><div className="section-heading"><div><h2>项目列表 <span>{projects.length}</span></h2></div><div className="course-controls"><div className="filter-tabs" aria-label="项目筛选">{[['all', '全部'], ['ready', '可预览'], ['running', '生成中']].map(([value, label]) => <button key={value} onClick={() => setFilter(value)} className={filter === value ? 'active' : ''}>{label}</button>)}</div><label className="search-field"><Search size={15} /><input value={search} onChange={e => setSearch(e.target.value)} placeholder="搜索项目" aria-label="搜索项目" /></label></div></div>
      <div className="course-list-viewport">{loading ? <div className="loading-state"><LoaderCircle size={24} className="spin" /><span>正在打开你的工作室…</span></div> : filtered.length ? <div className="course-grid">{filtered.map((project, index) => <article className="course-card" key={project.id}>
        <Link href={`/projects/${project.id}`} className={`course-cover cover-${index % 3}`}><div className="cover-meta"><span>{project.settings.mode === 'full' ? '完整呈现' : '重点摘要'}</span><span>VIDEO {String(index + 1).padStart(2, '0')}</span></div><div className="cover-title">{project.title}</div><div className="cover-motif" aria-hidden="true">{index % 3 === 0 ? <><i /><i /><i /><ArrowUpRight size={55} /></> : index % 3 === 1 ? <><span>创</span><Leaf size={58} strokeWidth={0.9} /></> : <><span className="motif-circle" /><span className="motif-circle" /><span className="motif-circle" /></>}</div><span className="cover-open">进入项目<ArrowRight size={15} /></span></Link>
        <div className="course-card-body"><div className="course-status"><span className={`status-pill ${project.latestJob?.status === 'failed' ? 'failed' : activeStatus(project.latestJob?.status) ? 'running' : hasPreview(project) ? 'ready' : ''}`}>{activeStatus(project.latestJob?.status) ? <LoaderCircle size={11} className="spin" /> : hasPreview(project) ? <Check size={11} /> : <span className="status-dot" />}{project.latestJob?.status === 'failed' ? '任务失败' : activeStatus(project.latestJob?.status) ? jobLabels[project.latestJob!.status] : chapterVideoCount(project) ? Object.values(project.chapterVideos ?? {}).some(video => video.current) ? '可预览' : '待更新' : project.renderPlan ? '历史完整预览' : '草稿'}</span><span className="revision-label">v{project.revision}</span></div><Link href={`/projects/${project.id}`} className="course-name">{project.title}</Link><div className="course-meta"><span>{project.chapters?.length ?? 1} 个章节</span><span>·</span><span>{chapterVideoCount(project) ? `${chapterVideoCount(project)} 个章节视频` : project.renderPlan ? '历史完整视频' : '等待生成'}</span></div><div className="course-card-footer"><span><Clock3 size={12} />{formatDate(project.updatedAt)} 更新</span><div><button className="icon-button" title="复制项目文稿与设置" aria-label={`复制 ${project.title}`} disabled={actionBusy === project.id} onClick={() => duplicate(project)}><Copy size={14} /></button><button className="icon-button" title="删除项目" aria-label={`删除 ${project.title}`} disabled={actionBusy === project.id || activeStatus(project.latestJob?.status)} onClick={() => setDeleteTarget(project)}><Trash2 size={14} /></button></div></div></div>
      </article>)}<button className="new-course-card" onClick={() => setCreate('empty')}><span><Plus size={26} strokeWidth={1.4} /></span><strong>开始一个新项目</strong><p>导入文稿，让想法成为视频</p></button></div> : projects.length || search || filter !== 'all' ? <div className="empty-state compact"><Search size={25} /><h3>这里还没有匹配的项目</h3><p>试试其他关键词，或查看全部项目。</p><button className="text-button" onClick={() => { setFilter('all'); setSearch(''); }}>查看全部</button></div> : <div className="empty-state"><div className="empty-book"><BookOpen size={33} strokeWidth={1.2} /><span>+</span></div><h3>第一个视频，从这里开始。</h3><p>已有文稿就够了。上传 Markdown，<br />把产品、观点和故事变成清晰、生动的视频。</p><button className="button primary" onClick={() => setCreate('empty')}><Plus size={16} />创建我的第一个项目</button></div>}
    </div></section><footer className="dashboard-footer"><span><Leaf size={13} />认真讲好每一个想法。</span><span>Open source. Made for your ideas.</span></footer></div>
    {create && <CreateCourse onClose={() => setCreate(null)} />}
    {needsSession && <SessionGate onSuccess={load} />}
    {deleteTarget && <div className="modal-overlay"><section ref={deleteModal} className="modal-card confirm-modal" role="dialog" aria-modal="true" aria-labelledby="delete-title"><h2 id="delete-title">删除这个项目？</h2><p>「{deleteTarget.title}」及其项目记录将被删除。这个操作无法撤销。</p><div className="confirm-actions"><button className="button secondary" onClick={() => setDeleteTarget(null)} disabled={!!actionBusy}>保留项目</button><button className="button danger" onClick={remove} disabled={!!actionBusy}>{actionBusy ? '正在删除…' : '确认删除'}</button></div></section></div>}
  </div>;
}
