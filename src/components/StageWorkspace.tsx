'use client';

import Link from 'next/link';
import { Check, ChevronRight, FileText, Film, Layers3, List, LoaderCircle, Save, Settings2, Sprout, Volume2 } from 'lucide-react';
import type { ReactNode } from 'react';

export type CreationStage = 'markdown' | 'lesson' | 'speech' | 'video';
export const creationStages = [
  { id: 'markdown', label: 'Markdown', detail: '文稿与素材', icon: FileText },
  { id: 'lesson', label: '中间表示', detail: '场景与讲稿', icon: Layers3 },
  { id: 'speech', label: '配音', detail: '声音与同步', icon: Volume2 },
  { id: 'video', label: '视频', detail: '渲染与导出', icon: Film },
] as const;

export function StageWorkspace({ title, revision, dirty, saving, onSave, stage, onStage, completed, runningStage, mainAction, navigator, editor, preview, footer, notices, onContext, onScenes, scenesOpen, scenesCount, editorOpen, onEditorToggle }: {
  title: string; revision: number; dirty: boolean; saving: boolean; onSave: () => void;
  stage: CreationStage; onStage: (next: CreationStage) => void; completed: CreationStage[]; runningStage?: CreationStage;
  mainAction: ReactNode; navigator?: ReactNode; editor: ReactNode; preview: ReactNode; footer: ReactNode; notices?: ReactNode;
  onContext: () => void; onScenes: () => void; scenesOpen: boolean; scenesCount: number; editorOpen: boolean; onEditorToggle: () => void;
}) {
  return <div className="creation-workspace">
    <aside className="creation-brand-rail"><Link href="/" className="creation-brand" aria-label="返回视频工作室" title="返回视频工作室"><Sprout size={25} /></Link><span className="creation-rail-divider" /><button className={`creation-rail-button ${scenesOpen ? 'active' : ''}`} onClick={onScenes} title="场景导航" aria-label="场景导航" aria-expanded={scenesOpen}><List size={21} /><span>{scenesCount}</span></button><button className="creation-rail-button" onClick={onContext} title="工作室资料" aria-label="工作室资料"><Settings2 size={21} /></button><span className="creation-rail-mark">OT</span></aside>
    <div className="creation-main"><header className="creation-header"><div className="creation-title"><Link href="/">项目</Link><ChevronRight size={14} /><h1 title={title}>{title}</h1></div><div className="creation-header-actions"><span className={`creation-save-status ${dirty ? 'dirty' : ''}`}>{dirty ? '未保存修改' : `已保存 · v${revision}`}</span><button className="button secondary small" onClick={onSave} disabled={!dirty || saving}>{saving ? <LoaderCircle size={14} className="spin" /> : <Save size={14} />}保存修改</button>{mainAction}</div></header>
    <nav className="creation-stage-nav" aria-label="视频创作阶段"><div role="tablist" aria-label="创作阶段">{creationStages.map((item, index) => <button key={item.id} role="tab" aria-selected={stage === item.id} onClick={() => onStage(item.id)} className={`${stage === item.id ? 'selected' : ''} ${runningStage === item.id ? 'executing' : ''}`}><span className="creation-stage-number">{runningStage === item.id ? <LoaderCircle size={14} className="spin" /> : completed.includes(item.id) ? <Check size={14} /> : index + 1}</span><span><strong>{item.label}</strong><small>{item.detail}</small></span>{index < creationStages.length - 1 && <ChevronRight size={14} className="creation-stage-arrow" />}</button>)}</div><button className="creation-mobile-editor-toggle text-button" onClick={onEditorToggle} aria-expanded={editorOpen}>{editorOpen ? '收起编辑' : '展开编辑'}</button></nav>
    {notices}
    <div className={`creation-body ${scenesOpen ? 'with-navigator' : ''} ${editorOpen ? 'editor-expanded' : ''}`}>{scenesOpen && navigator}<section className="creation-preview-pane" aria-label="常驻视频预览">{preview}</section><section className="creation-editor-pane" aria-label="当前阶段编辑区">{editor}</section></div>
    <footer className="creation-progress-footer">{footer}</footer></div>
  </div>;
}
