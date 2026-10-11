'use client';

import Link from 'next/link';
import { Check, ChevronRight, FileText, Film, Layers3, List, LoaderCircle, Save, Settings2, Sprout, Volume2 } from 'lucide-react';
import type { ReactNode } from 'react';
import { useI18n } from '@/i18n/provider';

export type CreationStage = 'markdown' | 'lesson' | 'speech' | 'video';
export const creationStages = [
  { id: 'markdown', label: 'stageMarkdown', detail: 'stageMarkdownDetail', icon: FileText },
  { id: 'lesson', label: 'stageLesson', detail: 'stageLessonDetail', icon: Layers3 },
  { id: 'speech', label: 'stageSpeech', detail: 'stageSpeechDetail', icon: Volume2 },
  { id: 'video', label: 'stageVideo', detail: 'stageVideoDetail', icon: Film },
] as const;

export function StageWorkspace({ title, revision, dirty, saving, onSave, stage, onStage, completed, runningStage, mainAction, navigator, editor, preview, footer, notices, onContext, onScenes, scenesOpen, scenesCount, editorOpen, onEditorToggle }: {
  title: string; revision: number; dirty: boolean; saving: boolean; onSave: () => void;
  stage: CreationStage; onStage: (next: CreationStage) => void; completed: CreationStage[]; runningStage?: CreationStage;
  mainAction: ReactNode; navigator?: ReactNode; editor: ReactNode; preview: ReactNode; footer: ReactNode; notices?: ReactNode;
  onContext: () => void; onScenes: () => void; scenesOpen: boolean; scenesCount: number; editorOpen: boolean; onEditorToggle: () => void;
}) {
  const { t } = useI18n('studio');
  return <div className="creation-workspace">
    <aside className="creation-brand-rail"><Link href="/" className="creation-brand" aria-label={t('backToStudio')} title={t('backToStudio')}><Sprout size={25} /></Link><span className="creation-rail-divider" /><button className={`creation-rail-button ${scenesOpen ? 'active' : ''}`} onClick={onScenes} title={t('sceneNavigation')} aria-label={t('sceneNavigation')} aria-expanded={scenesOpen}><List size={21} /><span>{scenesCount}</span></button><button className="creation-rail-button" onClick={onContext} title={t('studioContext')} aria-label={t('studioContext')}><Settings2 size={21} /></button><span className="creation-rail-mark">OT</span></aside>
    <div className="creation-main"><header className="creation-header"><div className="creation-title"><Link href="/">{t('projects')}</Link><ChevronRight size={14} /><h1 title={title}>{title}</h1></div><div className="creation-header-actions"><span className={`creation-save-status ${dirty ? 'dirty' : ''}`}>{dirty ? t('unsaved') : t('savedRevision', { revision })}</span><button className="button secondary small" onClick={onSave} disabled={!dirty || saving}>{saving ? <LoaderCircle size={14} className="spin" /> : <Save size={14} />}{t('save')}</button>{mainAction}</div></header>
    <nav className="creation-stage-nav" aria-label={t('videoStages')}><div role="tablist" aria-label={t('stages')}>{creationStages.map((item, index) => <button key={item.id} role="tab" aria-selected={stage === item.id} onClick={() => onStage(item.id)} className={`${stage === item.id ? 'selected' : ''} ${runningStage === item.id ? 'executing' : ''}`}><span className="creation-stage-number">{runningStage === item.id ? <LoaderCircle size={14} className="spin" /> : completed.includes(item.id) ? <Check size={14} /> : index + 1}</span><span><strong>{t(item.label)}</strong><small>{t(item.detail)}</small></span>{index < creationStages.length - 1 && <ChevronRight size={14} className="creation-stage-arrow" />}</button>)}</div><button className="creation-mobile-editor-toggle text-button" onClick={onEditorToggle} aria-expanded={editorOpen}>{t(editorOpen ? 'collapseEditor' : 'expandEditor')}</button></nav>
    {notices}
    <div className={`creation-body ${scenesOpen ? 'with-navigator' : ''} ${editorOpen ? 'editor-expanded' : ''}`}>{scenesOpen && navigator}<section className="creation-preview-pane" aria-label={t('persistentPreview')}>{preview}</section><section className="creation-editor-pane" aria-label={t('stageEditor')}>{editor}</section></div>
    <footer className="creation-progress-footer">{footer}</footer></div>
  </div>;
}
