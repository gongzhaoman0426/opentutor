'use client';

import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import { type PlayerRef } from '@remotion/player';
import { AlertCircle, ArrowDown, ArrowLeft, ArrowUp, Check, ChevronDown, ChevronLeft, Download, FileText, Film, ImagePlus, List, LoaderCircle, Plus, RefreshCw, Save, Settings2, Layers3, Sparkles, Trash2, Upload, X } from 'lucide-react';
import type { Asset, Chapter, GenerationSettings, JobRecord, Project, ProjectSnapshot, RenderPlan } from '@/shared/schema';
import { createEmptyChapter, getChapterSourceKey, getProjectChapters, isChapterVideoCurrent, joinChapterMarkdown, splitMarkdownChapters } from '@/shared/chapters';
import { activeStatus, api, ApiError, errorMessage } from './api';
import { useI18n } from '@/i18n/provider';
import { LanguageSwitcher } from '@/i18n/LanguageSwitcher';
import type { zh as editorMessages } from '@/i18n/messages/editor';
import { ErrorBanner, SessionGate, useModalFocus } from './StudioShell';
import { ChapterMarkdownPreview } from './ChapterMarkdownPreview';
import { CreationPreview } from './CreationPreview';
import { HistoricalCoursePreview } from './HistoricalCoursePreview';
import { GenerationSettingsDialog } from './GenerationSettingsDialog';
import { formatRenderProgress } from '@/shared/render-progress';
import { mergeProtectedChapterSettings, rememberChapterSettings } from '@/shared/chapter-settings';
import { useVideoVersions } from './useVideoVersions';
import { VideoVersionPicker } from './VideoVersionPicker';

type Draft = ProjectSnapshot & { chapters: Chapter[] };
type EditorNotice = { key: keyof typeof editorMessages; values?: Record<string, string | number> };
class EditorIssue extends Error { constructor(readonly key: keyof typeof editorMessages) { super(key); } }
type Cursor = { chapterId: string; start: number; end: number; markdown: string };
const toDraft = (project: Project): Draft => ({ id: project.id, title: project.title, markdown: project.markdown, chapters: getProjectChapters(project), settings: project.settings, assets: project.assets, revision: project.revision, lesson: project.lesson, sourceMode: project.sourceMode });
const identity = (draft: Draft) => JSON.stringify({ title: draft.title, chapters: draft.chapters, assets: draft.assets, settings: draft.settings, lesson: draft.lesson });
const stages: Record<string, keyof typeof editorMessages> = { vision: 'stageImages', images: 'stageImages', overview: 'stageOverview', queued: 'stageQueued', starting: 'stageStarting', parse: 'stageParse', codex: 'stagePlanning', planning: 'stagePlanning', validate: 'stageValidate', speech: 'stageSpeech', timeline: 'stageTimeline', render: 'stageRender', rendering: 'stageRender', completed: 'stageCompleted', cancelling: 'stageCancelling' };
function download(url: string) { const anchor = document.createElement('a'); anchor.href = `${url}${url.includes('?') ? '&' : '?'}download=1`; anchor.download = ''; document.body.appendChild(anchor); anchor.click(); anchor.remove(); }

export function CourseEditor({ id }: { id: string }) {
  const { t, locale } = useI18n('editor');
  const [project, setProject] = useState<Project | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [baseIdentity, setBaseIdentity] = useState('');
  const [chapterId, setChapterId] = useState('');
  const [previewTab, setPreviewTab] = useState<'markdown' | 'video'>('markdown');
  const [chaptersOpen, setChaptersOpen] = useState(true);
  const [imagesOpen, setImagesOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [message, setMessage] = useState<EditorNotice | null>(null);
  const [conflict, setConflict] = useState<Project | null>(null);
  const [needsSession, setNeedsSession] = useState(false);
  const [job, setJob] = useState<JobRecord | null>(null);
  const [versionExportJobs, setVersionExportJobs] = useState<Record<string, JobRecord>>({});
  const [resumeVersionExport, setResumeVersionExport] = useState('');
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [settingsChapter, setSettingsChapter] = useState<{ id: string; library: boolean } | null>(null);
  const [deleteChapter, setDeleteChapter] = useState<Chapter | null>(null);
  const [importText, setImportText] = useState<string | null>(null);
  const player = useRef<PlayerRef>(null);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const imageInput = useRef<HTMLInputElement>(null);
  const markdownInput = useRef<HTMLInputElement>(null);
  const draftRef = useRef<Draft | null>(null);
  const serverRef = useRef<Project | null>(null);
  const baseRef = useRef('');
  const dirtyRef = useRef(false);
  const editEpoch = useRef(0);
  const savePromise = useRef<Promise<Project | null> | null>(null);
  const blockedSave = useRef(false);
  const selectedChapter = useRef('');
  const insertion = useRef<Cursor | null>(null);
  const downloadJobs = useRef(new Set<string>());
  // A frozen version may reuse a normal export, its source generation job, or
  // another version's identical artifact. Keep that UI association separate.
  const versionJobTargets = useRef(new Map<string, Set<string>>());
  const submittingKind = useRef<'preview' | 'export' | null>(null);
  const downloaded = useRef(new Set<string>());
  const stablePreview = useRef<{ signature: string; plan: RenderPlan; assets: Asset[] } | null>(null);
  const modal = useModalFocus(() => { setDeleteChapter(null); setImportText(null); }, !!deleteChapter || importText !== null);
  const dirty = !!draft && identity(draft) !== baseIdentity;
  dirtyRef.current = dirty;
  selectedChapter.current = chapterId;

  const adopt = useCallback((next: Project) => {
    const value = toDraft(next); draftRef.current = value; baseRef.current = identity(value); dirtyRef.current = false;
    serverRef.current = next; setProject(next); setDraft(value); setBaseIdentity(baseRef.current); setConflict(null); blockedSave.current = false;
    setChapterId(current => value.chapters.some(chapter => chapter.id === current) ? current : value.chapters[0].id);
    setJob(current => next.latestJob ?? (current?.projectId === next.id && activeStatus(current.status) ? current : null));
  }, []);
  const change = useCallback((update: (value: Draft) => Draft) => {
    if (!draftRef.current) return;
    const next = update(draftRef.current); editEpoch.current++; draftRef.current = next; dirtyRef.current = identity(next) !== baseRef.current; setDraft(next); setMessage(null);
  }, []);
  const rebaseDerivedRevision = useCallback((next: Project) => {
    if (!draftRef.current || identity(toDraft(next)) !== baseRef.current) return false;
    const local = { ...draftRef.current, revision: next.revision, sourceMode: next.sourceMode };
    draftRef.current = local; serverRef.current = next; setDraft(local); setProject(next); setConflict(null); blockedSave.current = false; setError(null);
    return true;
  }, []);
  const reload = useCallback(async (initial = false) => {
    try {
      let next: Project;
      for (;;) {
        if (!initial) while (savePromise.current) await savePromise.current;
        const response = await api<{ project: Project }>(`/api/projects/${id}`);
        if (!initial && savePromise.current) { while (savePromise.current) await savePromise.current; continue; }
        next = response.project; break;
      }
      setNeedsSession(false);
      if (serverRef.current && next.revision < serverRef.current.revision) return;
      if (initial || !dirtyRef.current) adopt(next);
      else { serverRef.current = next; setProject(next); if (next.revision !== draftRef.current?.revision && !rebaseDerivedRevision(next)) { blockedSave.current = true; setConflict(next); } }
    } catch (failure) { if (failure instanceof ApiError && failure.status === 401) setNeedsSession(true); else setError(failure); }
    finally { setLoading(false); }
  }, [id, adopt, rebaseDerivedRevision]);
  useEffect(() => {
    downloadJobs.current = new Set(); versionJobTargets.current = new Map();
    setVersionExportJobs({}); setResumeVersionExport('');
    const stored = sessionStorage.getItem(`opentutor-download-${id}`);
    if (stored) { try { const parsed: unknown = JSON.parse(stored); downloadJobs.current = new Set(Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === 'string') : typeof parsed === 'string' ? [parsed] : []); } catch { downloadJobs.current = new Set([stored]); } }
    try {
      const targets: unknown = JSON.parse(sessionStorage.getItem(`opentutor-download-versions-${id}`) || '{}');
      if (targets && typeof targets === 'object' && !Array.isArray(targets)) for (const [jobId, values] of Object.entries(targets)) if (downloadJobs.current.has(jobId) && Array.isArray(values)) versionJobTargets.current.set(jobId, new Set(values.filter((value): value is string => typeof value === 'string')));
    } catch { /* Earlier sessions only stored job IDs. */ }
    void reload(true);
  }, [id, reload]);

  const save = useCallback(async (): Promise<Project | null> => {
    if (savePromise.current) { const result = await savePromise.current; if (!result || blockedSave.current) return null; return save(); }
    const current = draftRef.current;
    if (!current || blockedSave.current) return null;
    if (identity(current) === baseRef.current) return serverRef.current;
    if (!current.title.trim() || current.chapters.some(chapter => !chapter.title.trim())) { setError(new EditorIssue('missingNames')); return null; }
    const epoch = editEpoch.current; const input = { ...current, expectedRevision: current.revision, title: current.title.trim(), markdown: joinChapterMarkdown(current.chapters) };
    setSaving(true);
    const request = (async () => {
      try {
        const { project: next } = await api<{ project: Project }>(`/api/projects/${id}`, { method: 'PATCH', body: JSON.stringify(input) });
        setError(null); serverRef.current = next; setProject(next); const saved = toDraft(next); baseRef.current = identity(saved); setBaseIdentity(baseRef.current);
        if (epoch === editEpoch.current) { draftRef.current = saved; dirtyRef.current = false; setDraft(saved); }
        else if (draftRef.current) {
          const local = draftRef.current;
          const chapters = mergeProtectedChapterSettings(local.chapters, current.chapters, saved.chapters);
          const chaptersChanged = JSON.stringify(chapters) !== JSON.stringify(saved.chapters);
          const pending = { ...local, chapters, revision: next.revision, sourceMode: saved.sourceMode, lesson: chaptersChanged ? null : saved.lesson, assets: local.assets.map(asset => saved.assets.find(value => value.id === asset.id) ?? asset) };
          draftRef.current = pending; dirtyRef.current = identity(pending) !== baseRef.current; setDraft(pending);
        }
        setJob(value => next.latestJob ?? (value && activeStatus(value.status) ? value : null));
        return next;
      } catch (failure) {
        setError(failure);
        if (failure instanceof ApiError && failure.status === 409) { blockedSave.current = true; try { const { project: next } = await api<{ project: Project }>(`/api/projects/${id}`); if (rebaseDerivedRevision(next)) return next; serverRef.current = next; setProject(next); setConflict(next); } catch {} }
        return null;
      } finally { savePromise.current = null; setSaving(false); }
    })();
    savePromise.current = request; const result = await request;
    if (result && dirtyRef.current && !blockedSave.current) return save();
    return result;
  }, [id, rebaseDerivedRevision]);
  useEffect(() => {
    if (!dirty || conflict) return;
    const timer = setTimeout(() => { void save(); }, 800); return () => clearTimeout(timer);
  }, [dirty, draft, conflict, save]);
  useEffect(() => { const prevent = (event: BeforeUnloadEvent) => { if (dirtyRef.current) { event.preventDefault(); event.returnValue = ''; } }; window.addEventListener('beforeunload', prevent); return () => window.removeEventListener('beforeunload', prevent); }, []);

  const rememberDownloads = useCallback(() => {
    if (downloadJobs.current.size) {
      sessionStorage.setItem(`opentutor-download-${id}`, JSON.stringify([...downloadJobs.current]));
      sessionStorage.setItem(`opentutor-download-versions-${id}`, JSON.stringify(Object.fromEntries([...versionJobTargets.current].filter(([jobId]) => downloadJobs.current.has(jobId)).map(([jobId, targets]) => [jobId, [...targets]]))));
    } else { sessionStorage.removeItem(`opentutor-download-${id}`); sessionStorage.removeItem(`opentutor-download-versions-${id}`); }
  }, [id]);
  const completeDownload = useCallback((next: JobRecord) => {
    if (!downloadJobs.current.has(next.id) || downloaded.current.has(next.id)) return;
    if (next.status === 'succeeded' && next.videoUrl) {
      downloaded.current.add(next.id); downloadJobs.current.delete(next.id); rememberDownloads(); download(next.videoUrl);
      setMessage({ key: 'chapterDownloadReady', values: { title: draftRef.current?.chapters.find(chapter => chapter.id === next.chapterId)?.title || next.snapshot.title } });
    } else if (['failed', 'cancelled'].includes(next.status)) { downloadJobs.current.delete(next.id); rememberDownloads(); }
  }, [rememberDownloads]);
  useEffect(() => { for (const next of [...Object.values(project?.chapterJobs ?? {}), ...(job ? [job] : [])]) completeDownload(next); }, [job, project?.chapterJobs, completeDownload]);
  const trackedJobs = new Map<string, JobRecord>();
  for (const next of Object.values(project?.chapterJobs ?? {})) if (activeStatus(next.status)) trackedJobs.set(next.id, next);
  if (job && activeStatus(job.status)) trackedJobs.set(job.id, job);
  for (const next of Object.values(versionExportJobs)) if (activeStatus(next.status)) trackedJobs.set(next.id, next);
  const watchedJobIds = [...new Set([...trackedJobs.keys(), ...downloadJobs.current, ...(resumeVersionExport && !versionExportJobs[resumeVersionExport] ? [resumeVersionExport] : [])])].sort().join(',');
  useEffect(() => {
    if (!watchedJobIds) return;
    let alive = true;
    const ended = new Set<string>();
    const update = (next: JobRecord) => {
      if (!alive) return;
      if (next.videoVersionId || versionJobTargets.current.has(next.id)) setVersionExportJobs(current => ({ ...current, [next.id]: next }));
      else {
        setJob(current => current?.id === next.id ? next : current);
        setProject(current => current ? { ...current, chapterJobs: next.chapterId ? { ...current.chapterJobs, [next.chapterId]: next } : current.chapterJobs, latestJob: current.latestJob?.id === next.id ? next : current.latestJob } : current);
      }
      completeDownload(next);
      if (!activeStatus(next.status) && !ended.has(next.id)) { ended.add(next.id); void reload(); }
    };
    const ids = watchedJobIds.split(',');
    const sources = ids.map(jobId => { const source = new EventSource(`/api/jobs/${jobId}/events`); source.onmessage = event => { try { const data = JSON.parse(event.data); if (data.job) update(data.job); } catch {} }; return source; });
    const poll = setInterval(() => { for (const jobId of ids) api<{ job: JobRecord }>(`/api/jobs/${jobId}`).then(result => update(result.job)).catch(() => {}); }, 2000);
    return () => { alive = false; for (const source of sources) source.close(); clearInterval(poll); };
  }, [watchedJobIds, reload, completeDownload]);

  const chapter = draft?.chapters.find(value => value.id === chapterId) ?? draft?.chapters[0];
  const chapterOutput = chapter ? project?.chapterVideos?.[chapter.id] : null;
  const sourceKey = draft && chapter ? getChapterSourceKey(draft, chapter) : '';
  const ownJob = job?.chapterId === chapter?.id ? job : chapter ? project?.chapterJobs?.[chapter.id] ?? null : null;
  const versionRefreshKey = `${chapterOutput?.updatedAt ?? ''}:${ownJob?.id ?? ''}:${ownJob?.status ?? ''}:${Object.values(versionExportJobs).filter(value => !activeStatus(value.status)).map(value => `${value.id}:${value.status}`).join(',')}`;
  const versions = useVideoVersions(id, chapter?.id ?? '', versionRefreshKey);
  useEffect(() => {
    const selected = versions.selected;
    const jobId = selected && !selected.videoUrl ? selected.exportJobId : null;
    if (selected && jobId) { const targets = versionJobTargets.current.get(jobId) ?? new Set<string>(); targets.add(selected.id); versionJobTargets.current.set(jobId, targets); }
    setResumeVersionExport(jobId ?? '');
  }, [versions.selected?.exportJobId, versions.selected?.id, versions.selected?.videoUrl]);
  const selectedExportJobId = versions.selected ? [...versionJobTargets.current].reverse().find(([jobId, targets]) => targets.has(versions.selected!.id) && versionExportJobs[jobId])?.[0] || versions.selected.exportJobId : null;
  const selectedExportJob = selectedExportJobId ? versionExportJobs[selectedExportJobId] ?? null : versions.selected ? Object.values(versionExportJobs).filter(value => value.videoVersionId === versions.selected!.id).sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0] ?? null : null;
  const legacyJob = job && !job.chapterId && activeStatus(job.status) ? job : null;
  const busy = activeStatus(ownJob?.status) || !!legacyJob;
  const backgroundJob = [...trackedJobs.values()].find(next => next.chapterId !== chapter?.id) ?? null;
  const statusJob = activeStatus(selectedExportJob?.status) ? selectedExportJob : busy ? activeStatus(ownJob?.status) ? ownJob : legacyJob : [...trackedJobs.values()].find(next => versionExportJobs[next.id] && next.chapterId === chapter?.id) ?? backgroundJob;
  const detailJob = selectedExportJob ?? ownJob ?? statusJob;
  const activeProgress = statusJob?.stage === 'render' && statusJob.renderProgress ? formatRenderProgress(statusJob.renderProgress, { locale }) : null;
  const matchesChapterVideo = !!project && !!draft && !!chapter && isChapterVideoCurrent({ ...project, chapters: draft.chapters, markdown: draft.markdown, settings: draft.settings, assets: draft.assets }, chapter.id);
  const currentPreview = matchesChapterVideo && !conflict;
  const submit = async (kind: 'preview' | 'export', targetId = selectedChapter.current) => {
    if (busy || submitting || uploading) return; submittingKind.current = kind; setSubmitting(true); setError(null); setMessage(null);
    try {
      const saved = dirtyRef.current || savePromise.current ? await save() : serverRef.current;
      if (!saved) return;
      const target = getProjectChapters(saved).find(value => value.id === targetId);
      if (!target || !target.markdown.trim()) throw new EditorIssue('writeChapterFirst');
      const output = saved.chapterVideos?.[targetId];
      if (kind === 'export' && isChapterVideoCurrent(saved, targetId) && output?.latestExport) { download(output.latestExport.videoUrl); setMessage({ key: 'chapterDownloaded', values: { title: target.title } }); return; }
      const { job: next } = await api<{ job: JobRecord }>(`/api/projects/${id}/jobs`, { method: 'POST', headers: { 'Idempotency-Key': crypto.randomUUID() }, body: JSON.stringify({ kind, chapterId: targetId, expectedRevision: saved.revision }) });
      setJob(next); if (next.chapterId) setProject(current => current ? { ...current, chapterJobs: { ...current.chapterJobs, [next.chapterId!]: next } } : current); if (kind === 'preview') { if (selectedChapter.current === targetId) { player.current?.pause(); versions.choose('latest'); setPreviewTab('video'); } } else { downloadJobs.current.add(next.id); rememberDownloads(); completeDownload(next); }
    } catch (failure) { setError(failure); } finally { submittingKind.current = null; setSubmitting(false); }
  };
  const cancel = async () => { if (!statusJob) return; try { const result = await api<{ job: JobRecord }>(`/api/jobs/${statusJob.id}/cancel`, { method: 'POST' }); if (result.job.videoVersionId || versionJobTargets.current.has(result.job.id)) setVersionExportJobs(current => ({ ...current, [result.job.id]: result.job })); else { setJob(current => current?.id === result.job.id ? result.job : current); if (result.job.chapterId) setProject(current => current ? { ...current, chapterJobs: { ...current.chapterJobs, [result.job.chapterId!]: result.job } } : current); } } catch (failure) { setError(failure); } };

  const applySettings = async (settings: GenerationSettings, generate: boolean) => {
    const targetId = settingsChapter?.id;
    if (!targetId) return;
    change(value => ({ ...value, ...rememberChapterSettings({ ...project, ...value }, targetId, settings) }));
    const saved = await save();
    if (!saved) throw new Error(t('settingsNotSaved'));
    setSettingsChapter(null);
    if (generate) await submit('preview', targetId);
  };
  const editChapter = (update: Partial<Chapter>) => change(value => ({ ...value, lesson: null, chapters: value.chapters.map(item => item.id === chapter?.id ? { ...item, ...update } : item) }));
  const chooseChapter = (nextId: string) => { player.current?.pause(); setChapterId(nextId); setMessage(null); };
  const moveChapter = (direction: number) => change(value => { const chapters = [...value.chapters]; const index = chapters.findIndex(item => item.id === chapterId); const target = index + direction; if (target < 0 || target >= chapters.length) return value; [chapters[index], chapters[target]] = [chapters[target], chapters[index]]; return { ...value, lesson: null, chapters }; });
  const addChapter = () => { const next = createEmptyChapter(t('defaultChapterName', { number: Number(draft?.chapters.length ?? 0) + 1 })); change(value => ({ ...value, lesson: null, chapters: [...value.chapters, next] })); setChapterId(next.id); };
  const rememberCursor = () => { const current = draftRef.current?.chapters.find(value => value.id === selectedChapter.current); if (current) insertion.current = { chapterId: current.id, start: textarea.current?.selectionStart ?? current.markdown.length, end: textarea.current?.selectionEnd ?? current.markdown.length, markdown: current.markdown }; };
  const insertAsset = (asset: Asset, cursor = insertion.current) => {
    if (!cursor) { rememberCursor(); cursor = insertion.current; } if (!cursor) return;
    const target = cursor.chapterId; const alt = asset.name.replace(/\.[^.]+$/, '').replace(/[\[\]\\\r\n]/g, ''); const text = `\n\n![${alt}](asset://${asset.id})\n\n`;
    change(value => {
      const current = value.chapters.find(item => item.id === target); if (!current) { setMessage({ key: 'assetUploadedChapterRemoved' }); return { ...value, assets: value.assets.some(item => item.id === asset.id) ? value.assets : [...value.assets, asset] }; }
      const changed = current.markdown !== cursor!.markdown; const sameChapter = selectedChapter.current === target;
      const start = changed ? sameChapter ? textarea.current?.selectionStart ?? current.markdown.length : current.markdown.length : cursor!.start;
      const end = changed ? sameChapter ? textarea.current?.selectionEnd ?? start : start : cursor!.end;
      const markdown = current.markdown.slice(0, start) + text + current.markdown.slice(end);
      insertion.current = { chapterId: target, start: start + text.length, end: start + text.length, markdown };
      return { ...value, lesson: null, assets: value.assets.some(item => item.id === asset.id) ? value.assets : [...value.assets, asset], chapters: value.chapters.map(item => item.id === target ? { ...item, markdown } : item) };
    });
    setImagesOpen(false); requestAnimationFrame(() => { if (selectedChapter.current === target) { textarea.current?.focus(); const at = insertion.current?.start ?? 0; textarea.current?.setSelectionRange(at, at); } });
  };
  const upload = async (files: File[]) => {
    if (!files.length) return; rememberCursor(); let cursor = insertion.current; setUploading(true); setError(null);
    try { for (const file of files) { if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type) || file.size > 15 * 1024 * 1024) throw new EditorIssue('invalidImageUpload'); const form = new FormData(); form.append('file', file); const { asset } = await api<{ asset: Asset }>('/api/assets', { method: 'POST', body: form }); insertAsset(asset, cursor); if (insertion.current?.chapterId === cursor?.chapterId) cursor = insertion.current; } }
    catch (failure) { setError(failure); } finally { setUploading(false); }
  };
  const importMarkdown = async (file?: File) => { if (!file) return; if (file.size > 2_000_000 || !/\.(md|markdown|txt)$/i.test(file.name)) { setError(new EditorIssue('invalidMarkdownFile')); return; } const text = await file.text(); if (text.length > 300000) { setError(new EditorIssue('scriptTooLong')); return; } if (draftRef.current?.chapters.some(value => value.markdown.trim())) setImportText(text); else applyImport(text); };
  const applyImport = (text: string) => { const chapters = splitMarkdownChapters(text, { untitled: t('untitledChapter'), imported: t('importedChapter'), introduction: t('introductionChapter') }); change(value => ({ ...value, chapters, lesson: null, markdown: text })); setChapterId(chapters[0].id); setImportText(null); };

  // A completed job is a frozen history entry even when concurrent edits kept
  // it from replacing the published video (outputRevision can remain null).
  const incremental = ownJob?.status !== 'succeeded' && ownJob?.preview?.renderPlan && (!chapterOutput || ownJob.updatedAt >= chapterOutput.updatedAt) ? ownJob.preview : null;
  const showIncremental = versions.selectedId === 'latest' && !!incremental;
  const historical = versions.selectedId !== 'latest';
  const visiblePlan = showIncremental ? incremental!.renderPlan : versions.selected ? versions.detail?.renderPlan ?? null : historical ? null : chapterOutput?.renderPlan ?? null;
  const visibleAssets = showIncremental ? ownJob!.snapshot.assets : versions.selected ? versions.detail?.assets ?? [] : chapterOutput?.previewAssets ?? [];
  if (visiblePlan) { const signature = JSON.stringify({ plan: visiblePlan, assets: visibleAssets }); if (signature !== stablePreview.current?.signature) stablePreview.current = { signature, plan: visiblePlan, assets: visibleAssets }; }
  else stablePreview.current = null;
  const preview = stablePreview.current;
  const effectiveSourceKey = showIncremental ? ownJob?.snapshot.chapterSourceKey : chapterOutput?.sourceKey;
  const stale = Boolean(preview && !historical && (effectiveSourceKey !== sourceKey || !showIncremental && !matchesChapterVideo));
  const previewKey = showIncremental ? `generating:${ownJob!.id}` : versions.detail ? `version:${versions.detail.id}` : `legacy:${chapterOutput?.previewRevision}`;
  const selectedVersionUrl = selectedExportJob?.status === 'succeeded' ? selectedExportJob.videoUrl : versions.selected?.videoUrl;
  const legacyDownloadUrl = !versions.selected && !historical ? chapterOutput?.latestExport?.videoUrl : null;
  const exportingSelected = activeStatus(selectedExportJob?.status);
  const canDownload = !showIncremental && !submitting && !exportingSelected && (versions.selected ? !!versions.detail : !versions.listLoading && !versions.error && !historical && (!!legacyDownloadUrl || currentPreview && !busy));
  const downloadSelected = async () => {
    if (!canDownload || !chapter) return;
    const target = versions.selected;
    const targetChapter = chapter.id;
    const url = selectedVersionUrl || legacyDownloadUrl;
    if (url) { download(url); setMessage(target ? { key: 'versionDownloaded', values: { version: target.version } } : { key: 'retainedDownloaded' }); return; }
    if (!target) { await submit('export', targetChapter); return; }
    submittingKind.current = 'export'; setSubmitting(true); setError(null);
    try {
      const { job: next } = await api<{ job: JobRecord }>(`/api/projects/${id}/videos/${target.id}/export`, { method: 'POST' });
      if (next.projectId !== id || next.chapterId !== targetChapter || !(next.status === 'succeeded' && next.videoUrl || next.kind === 'export' && activeStatus(next.status))) throw new EditorIssue('invalidExportTask');
      const targets = versionJobTargets.current.get(next.id) ?? new Set<string>(); targets.add(target.id);
      // Prefer this requested/reused job, even when its creation date precedes a
      // later failed attempt for the same immutable video.
      versionJobTargets.current.delete(next.id); versionJobTargets.current.set(next.id, targets);
      setVersionExportJobs(current => ({ ...current, [next.id]: next }));
      downloadJobs.current.add(next.id); rememberDownloads(); completeDownload(next);
    } catch (failure) { setError(failure); }
    finally { submittingKind.current = null; setSubmitting(false); }
  };
  const failedJob = selectedExportJob?.status === 'failed' ? selectedExportJob : ownJob?.status === 'failed' && (ownJob.snapshot.chapterSourceKey ? ownJob.snapshot.chapterSourceKey === sourceKey : ownJob.inputRevision === draft?.revision) ? ownJob : null;
  const failed = !!failedJob;
  const failureReason = failedJob ? failedJob.diagnostics.filter(value => value.severity === 'error').map(value => value.message).join('；') || failedJob.error : null;

  const errorText = error ? error instanceof EditorIssue ? t(error.key) : errorMessage(error, locale) : '';
  const stageLabel = statusJob ? stages[statusJob.stage] ? t(stages[statusJob.stage]) : t('stageUnknown', { stage: statusJob.stage }) : '';
  const progressLabel = statusJob ? activeProgress || (statusJob.total > 0 ? t('stageWithProgress', { stage: stageLabel, done: statusJob.completed, total: statusJob.total }) : stageLabel) : '';
  const statusLabel = statusJob ? statusJob.chapterId && statusJob.chapterId !== chapter?.id ? t('stageForChapter', { title: draft?.chapters.find(value => value.id === statusJob.chapterId)?.title || t('otherChapter'), stage: progressLabel }) : progressLabel : message ? t(message.key, message.values) : t(failed ? 'generationFailed' : dirty ? 'changesWillSave' : currentPreview ? 'readyToDownload' : 'oneVideoPerChapter');

  if (loading || !project || !draft || !chapter) return <div className="creation-loading"><LoaderCircle size={25} className="spin" /><p>{loading ? t('openingProject') : t('projectUnavailable')}</p>{errorText && <ErrorBanner message={errorText} />}<Link href="/" className="button secondary">{t('returnToProjects')}</Link>{needsSession && <SessionGate onSuccess={() => reload(!draftRef.current)} />}</div>;
  return <div className="chapter-workspace">
    <header className="chapter-course-header"><div className="chapter-course-name"><Link href="/" aria-label={t('backToProjects')} title={t('backToProjects')} onClick={async event => { if (dirtyRef.current) { event.preventDefault(); if (await save()) window.location.href = '/'; } }}><ArrowLeft size={18} /></Link><input aria-label={t('projectName')} value={draft.title} maxLength={120} onChange={event => change(value => ({ ...value, title: event.target.value }))} /></div><div className="chapter-course-actions"><LanguageSwitcher /><span className={`chapter-save-state ${dirty || conflict ? 'pending' : ''}`}>{conflict ? t('saveConflict') : saving ? t('saving') : dirty ? t('waitingToSave') : <><Check size={13} />{t('saved')}</>}</span><button className="icon-button chapter-manual-save" aria-label={t('saveChanges')} title={t('saveChanges')} onClick={save} disabled={!dirty || saving || !!conflict}><Save size={16} /></button><button className="icon-button chapter-configure" aria-label={t('generationSettings')} title={t('generationSettings')} onClick={() => setSettingsChapter({ id: chapter.id, library: false })}><Settings2 size={17} /></button><button className="icon-button chapter-components" aria-label={t('viewComponents')} title={t('viewComponents')} onClick={() => setSettingsChapter({ id: chapter.id, library: true })}><Layers3 size={17} /></button><button className="button primary small" disabled={busy || submitting || uploading || !!conflict || !chapter.markdown.trim()} onClick={() => setSettingsChapter({ id: chapter.id, library: false })}>{submitting && submittingKind.current === 'preview' ? <LoaderCircle size={14} className="spin" /> : <Sparkles size={14} />}{busy ? ownJob && activeStatus(ownJob.status) ? ownJob.kind === 'export' ? t('exporting') : t('generating') : t('taskInProgress') : chapterOutput ? t('updateVideo') : t('generateVideo')}</button><button className="button secondary small" aria-label={t('downloadVideo')} title={versions.selected ? t('downloadVersion', { version: versions.selected.version }) : t('downloadRetained')} disabled={!canDownload} onClick={downloadSelected}>{exportingSelected || submitting && submittingKind.current === 'export' ? <LoaderCircle size={14} className="spin" /> : <Download size={14} />}{exportingSelected ? t('exporting') : t('downloadVideo')}</button></div></header>
    {(errorText || failureReason) && <div className="chapter-alert" role="alert"><AlertCircle size={15} /><span>{errorText || failureReason}</span><button className="text-button" onClick={() => setDetailsOpen(!detailsOpen)}>{t('showDetails')}</button>{errorText && <button className="icon-button" aria-label={t('closeError')} onClick={() => setError(null)}><X size={14} /></button>}</div>}
    {conflict && <div className="chapter-alert warning"><span>{t('conflictNotice')}</span><button className="text-button" onClick={() => { const local = draftRef.current!; baseRef.current = identity(toDraft(conflict)); setBaseIdentity(baseRef.current); change(() => ({ ...local, revision: conflict.revision })); blockedSave.current = false; setConflict(null); setError(null); }}>{t('keepMyChanges')}</button><button className="text-button" onClick={() => adopt(conflict)}>{t('loadServerVersion')}</button></div>}
    <main className={`chapter-layout ${chaptersOpen ? '' : 'chapters-collapsed'}`}>
      <nav className="chapter-navigation" aria-label={t('projectChapters')}><div className="chapter-navigation-heading"><span>{t('chapters')} <small>{draft.chapters.length}</small></span><button className="icon-button" aria-label={t('collapseChapters')} onClick={() => setChaptersOpen(false)}><ChevronLeft size={16} /></button></div><div className="chapter-navigation-list">{draft.chapters.map((value, index) => <button key={value.id} className={value.id === chapter.id ? 'selected' : ''} onClick={() => chooseChapter(value.id)}><small>{String(index + 1).padStart(2, '0')}</small><span>{value.title}</span>{project.chapterVideos?.[value.id] && <i className={`chapter-video-dot ${project.chapterVideos[value.id].current ? 'ready' : ''}`} title={project.chapterVideos[value.id].current ? t('videoReady') : t('videoNeedsUpdate')} />}</button>)}</div><button className="chapter-add-button" onClick={addChapter}><Plus size={15} />{t('addChapter')}</button><button className="text-button chapter-import" onClick={() => markdownInput.current?.click()}><Upload size={13} />{t('importMarkdown')}</button></nav>
      <section className="chapter-editor"><div className="chapter-pane-header">{!chaptersOpen && <button className="icon-button" aria-label={t('expandChapters')} onClick={() => setChaptersOpen(true)}><List size={17} /></button>}<input aria-label={t('chapterName')} value={chapter.title} maxLength={120} onChange={event => editChapter({ title: event.target.value })} /><div className="chapter-edit-actions"><button className="icon-button" aria-label={t('moveChapterUp')} disabled={draft.chapters[0].id === chapter.id} onClick={() => moveChapter(-1)}><ArrowUp size={14} /></button><button className="icon-button" aria-label={t('moveChapterDown')} disabled={draft.chapters.at(-1)?.id === chapter.id} onClick={() => moveChapter(1)}><ArrowDown size={14} /></button><button className="icon-button" aria-label={t('deleteChapter')} disabled={draft.chapters.length < 2} onClick={() => setDeleteChapter(chapter)}><Trash2 size={14} /></button></div><button className="button secondary small chapter-image-action" onMouseDown={rememberCursor} onClick={() => { rememberCursor(); setImagesOpen(!imagesOpen); }}><ImagePlus size={14} />{t('insertImage')}</button></div>
      {imagesOpen && <div className="chapter-image-tray"><div><strong>{t('projectAssets')}</strong><button className="text-button" disabled={uploading} onClick={() => imageInput.current?.click()}>{uploading ? <LoaderCircle size={13} className="spin" /> : <Upload size={13} />}{t('uploadImage')}</button></div>{draft.assets.length ? <div className="chapter-image-library">{draft.assets.map(asset => <button key={asset.id} onClick={() => insertAsset(asset)}><img src={asset.url} alt="" /><span>{asset.name}</span><Plus size={14} /></button>)}</div> : <p>{t('imageLibraryHint')}</p>}</div>}
      <textarea ref={textarea} className="chapter-markdown-editor" aria-label={t('chapterMarkdown')} placeholder={t('markdownPlaceholder')} spellCheck={false} value={chapter.markdown} maxLength={300000} onChange={event => editChapter({ markdown: event.target.value })} onSelect={rememberCursor} onPaste={event => { const files = Array.from(event.clipboardData.files).filter(file => file.type.startsWith('image/')); if (files.length) { event.preventDefault(); void upload(files); } }} onDragOver={event => { if (event.dataTransfer.types.includes('Files')) event.preventDefault(); }} onDrop={event => { const files = Array.from(event.dataTransfer.files); if (files.length) { event.preventDefault(); void upload(files); } }} />
      <div className="chapter-editor-footer"><span>{uploading ? t('uploadingImages') : t('characterCount', { value: chapter.markdown.length.toLocaleString(locale) })}</span><span>{t('autosave')}</span></div></section>
      <section className="chapter-preview" aria-label={t('videoPreview')}><div className="chapter-pane-header chapter-preview-header"><div className="chapter-preview-tabs" role="tablist" aria-label={t('previewTabs')}><button id="markdown-preview-tab" role="tab" aria-selected={previewTab === 'markdown'} aria-controls="markdown-preview-panel" className={previewTab === 'markdown' ? 'selected' : ''} onClick={() => { player.current?.pause(); setPreviewTab('markdown'); }}><FileText size={14} />{t('markdownTab')}</button><button id="video-preview-tab" role="tab" aria-selected={previewTab === 'video'} aria-controls="video-preview-panel" className={previewTab === 'video' ? 'selected' : ''} onClick={() => setPreviewTab('video')}><Film size={14} />{t('videoTab')}</button></div><span>{previewTab === 'markdown' ? t('currentChapter') : historical ? t('readOnlyHistory') : stale ? t('scriptUpdated') : showIncremental ? activeStatus(ownJob?.status) ? t('generatingShort') : t('incompletePreview') : t('chapterVideo')}</span></div>
      <div id="markdown-preview-panel" role="tabpanel" aria-labelledby="markdown-preview-tab" hidden={previewTab !== 'markdown'} className="chapter-reading-preview"><div className="markdown-document"><ChapterMarkdownPreview markdown={chapter.markdown} assets={draft.assets} chapters={draft.chapters} /></div></div>
      <div id="video-preview-panel" role="tabpanel" aria-labelledby="video-preview-tab" hidden={previewTab !== 'video'} className="chapter-video-preview">
        <VideoVersionPicker versions={versions.versions} selectedId={versions.selectedId} selected={versions.selected} generating={activeStatus(ownJob?.status) && ownJob?.kind !== 'export'} pendingPreview={showIncremental} loading={versions.listLoading} onSelect={versionId => { player.current?.pause(); versions.choose(versionId); setMessage(null); }} />
        {versions.error && <div className="video-version-error" role="alert"><span>{versions.error}</span><button className="text-button" onClick={versions.reload}>{t('retryVersions')}</button></div>}
        {preview ? <>
          <CreationPreview compact plan={preview.plan} assets={preview.assets} player={player} revisionKey={`${id}:${chapter.id}:${previewKey}`} versionLabel={showIncremental ? activeStatus(ownJob?.status) ? t('generatingShort') : t('incompletePreview') : versions.selected ? `v${versions.selected.version}` : t('retainedPreview')} selected={preview.plan.scenes[0]?.scene.id ?? ''} onSelect={sceneId => { const value = preview.plan.scenes.find(scene => scene.scene.id === sceneId); if (value) { player.current?.pause(); player.current?.seekTo(value.startFrame + (value.utterances[0]?.startFrame ?? 0)); } }} sourceDraft={false} dirty={stale} onScenes={() => setChaptersOpen(!chaptersOpen)} />
          {historical ? <p className="chapter-video-version-note">{t('historicalNote', { version: versions.selected?.version })}</p> : stale ? <p className="chapter-video-version-note">{t('staleVideoNote')}</p> : !versions.selected && !versions.listLoading ? <p className="chapter-video-version-note">{t('legacyVideoNote')}</p> : null}
        </> : versions.detailLoading || versions.listLoading && historical ? <div className="chapter-video-empty" role="status"><LoaderCircle size={26} className="spin" /><h3>{t('loadingVersion')}</h3><p>{t('loadingVersionHint')}</p></div> : historical ? <div className="chapter-video-empty"><Film size={30} strokeWidth={1.2} /><h3>{t('versionUnavailable')}</h3><p>{t('versionUnavailableHint')}</p><button className="text-button" onClick={versions.reload}>{t('reloadVersion')}</button></div> : <div className="chapter-video-empty"><Film size={34} strokeWidth={1.2} /><h3>{t('noVideo')}</h3><p>{t('noVideoHint')}<br />{t('noVideoRenderHint')}</p></div>}
      </div></section>
    </main>
    <footer className="chapter-status-footer"><div>{statusJob ? <LoaderCircle size={14} className="spin" /> : failed ? <AlertCircle size={14} /> : <Check size={14} />}<span>{statusLabel}</span></div><div>{statusJob && <button className="text-button" disabled={statusJob.status === 'cancelling'} onClick={cancel}>{statusJob.status === 'cancelling' ? t('stopping') : t('cancel')}</button>}{failed && <button className="text-button" onClick={() => failedJob?.kind === 'export' ? downloadSelected() : submit('preview')} disabled={submitting}><RefreshCw size={13} />{t('retry')}</button>}{(detailJob || project.latestExport || project.renderPlan) && <button className="text-button" onClick={() => setDetailsOpen(!detailsOpen)}>{t('taskDetails')}<ChevronDown size={12} /></button>}</div></footer>

    {detailsOpen && <aside className="chapter-job-details"><div><h3>{t('generationHistory')}</h3><button className="icon-button" aria-label={t('closeTaskDetails')} onClick={() => setDetailsOpen(false)}><X size={17} /></button></div>{detailJob ? <><span className={`status-pill ${detailJob.status === 'failed' ? 'failed' : detailJob.status === 'succeeded' ? 'ready' : 'running'}`}>{t(`common:jobStatuses.${detailJob.status}`)}</span><p>{t('taskRevision', { title: draft.chapters.find(value => value.id === detailJob.chapterId)?.title || detailJob.snapshot.title, revision: detailJob.inputRevision })}{detailJob.outputRevision ? t('completedRevision', { revision: detailJob.outputRevision }) : ''}</p>{detailJob.renderProgress && <p>{formatRenderProgress(detailJob.renderProgress, { completed: detailJob.status === 'succeeded', locale })}</p>}{detailJob.kind === 'export' && activeStatus(detailJob.status) && <p>{t('exportHint')}</p>}{detailJob.error && <ErrorBanner message={detailJob.error} />}{detailJob.diagnostics.map((value, index) => <p className={`chapter-diagnostic ${value.severity}`} key={index}>{value.message}</p>)}{detailJob.videoUrl && <a className="text-button" href={`${detailJob.videoUrl}?download=1`} download>{t('downloadTaskVideo')}</a>}</> : <p>{t('noChapterTask')}</p>}{(project.renderPlan || project.latestExport) && <p><button className="text-button" onClick={() => setHistoryOpen(true)}>{t('previewLegacyVideo')}</button></p>}{project.latestExport && <p><a className="text-button" href={`${project.latestExport.videoUrl}?download=1`} download>{t('downloadLegacyVideo')}</a></p>}</aside>}

    {historyOpen && <HistoricalCoursePreview project={project} onClose={() => setHistoryOpen(false)} />}
    {settingsChapter && <GenerationSettingsDialog key={settingsChapter.id} chapterTitle={draft.chapters.find(value => value.id === settingsChapter.id)?.title ?? ''} initial={draft.chapters.find(value => value.id === settingsChapter.id)?.settings ?? draft.settings} busy={busy || submitting || !!conflict} canGenerate={!!draft.chapters.find(value => value.id === settingsChapter.id)?.markdown.trim() && !uploading} initialLibrary={settingsChapter.library} onClose={() => setSettingsChapter(null)} onApply={applySettings} />}
    {(deleteChapter || importText !== null) && <div className="modal-overlay"><section ref={modal} className="modal-card confirm-modal" role="dialog" aria-modal="true" aria-labelledby="chapter-confirm-title"><h2 id="chapter-confirm-title">{deleteChapter ? t('confirmDeleteTitle') : t('confirmImportTitle')}</h2><p>{deleteChapter ? t('confirmDeleteBody', { title: deleteChapter.title }) : t('confirmImportBody')}</p><div className="confirm-actions"><button className="button secondary" onClick={() => { setDeleteChapter(null); setImportText(null); }}>{t('cancel')}</button><button className={`button ${deleteChapter ? 'danger' : 'primary'}`} onClick={() => { if (deleteChapter) { const chapters = draftRef.current!.chapters.filter(value => value.id !== deleteChapter.id); change(value => ({ ...value, chapters, lesson: null })); if (chapter.id === deleteChapter.id) setChapterId(chapters[0].id); setDeleteChapter(null); } else if (importText !== null) applyImport(importText); }}>{deleteChapter ? t('confirmDelete') : t('importAndReplace')}</button></div></section></div>}
    <input ref={imageInput} type="file" hidden multiple accept="image/png,image/jpeg,image/webp" onChange={event => { void upload(Array.from(event.target.files ?? [])); event.target.value = ''; }} /><input ref={markdownInput} type="file" hidden accept=".md,.markdown,.txt" onChange={event => { void importMarkdown(event.target.files?.[0]); event.target.value = ''; }} />
    {needsSession && <SessionGate onSuccess={() => reload(!draftRef.current)} />}
  </div>;
}
