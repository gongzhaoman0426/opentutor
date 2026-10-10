'use client';

import { useRef } from 'react';
import type { PlayerRef } from '@remotion/player';
import { X } from 'lucide-react';
import type { Project } from '@/shared/schema';
import { CreationPreview } from './CreationPreview';
import { useModalFocus } from './StudioShell';

export function HistoricalCoursePreview({ project, onClose }: { project: Project; onClose: () => void }) {
  const player = useRef<PlayerRef>(null);
  const modal = useModalFocus(onClose);
  return <div className="modal-overlay generation-overlay"><section ref={modal} className="generation-dialog historical-course-dialog" role="dialog" aria-modal="true" aria-labelledby="historical-preview-title"><header className="generation-dialog-header"><div><div><h2 id="historical-preview-title">历史完整预览</h2><p>{project.title} <span>· 以前生成的完整视频</span></p></div></div><button className="icon-button" aria-label="关闭历史完整预览" onClick={onClose}><X size={19} /></button></header><div className="historical-course-content">{project.renderPlan ? <CreationPreview compact plan={project.renderPlan} assets={project.previewAssets ?? project.assets} player={player} revisionKey={`legacy:${project.id}:${project.previewRevision}`} selected="" onSelect={() => {}} sourceDraft={false} dirty={false} onScenes={() => {}} /> : project.latestExport ? <video aria-label="历史完整视频" controls preload="metadata" src={project.latestExport.videoUrl} /> : null}<p>当前编辑按章节独立生成视频。这份历史完整预览会继续保留。</p></div></section></div>;
}
