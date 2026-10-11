'use client';

import { useRef } from 'react';
import type { PlayerRef } from '@remotion/player';
import { X } from 'lucide-react';
import type { Project } from '@/shared/schema';
import { CreationPreview } from './CreationPreview';
import { useModalFocus } from './StudioShell';
import { useI18n } from '@/i18n/provider';

export function HistoricalCoursePreview({ project, onClose }: { project: Project; onClose: () => void }) {
  const { t } = useI18n('preview');
  const player = useRef<PlayerRef>(null);
  const modal = useModalFocus(onClose);
  return <div className="modal-overlay generation-overlay"><section ref={modal} className="generation-dialog historical-course-dialog" role="dialog" aria-modal="true" aria-labelledby="historical-preview-title"><header className="generation-dialog-header"><div><div><h2 id="historical-preview-title">{t('historicalTitle')}</h2><p>{project.title} <span>· {t('historicalSubtitle')}</span></p></div></div><button className="icon-button" aria-label={t('historicalClose')} onClick={onClose}><X size={19} /></button></header><div className="historical-course-content">{project.renderPlan ? <CreationPreview compact plan={project.renderPlan} assets={project.previewAssets ?? project.assets} player={player} revisionKey={`legacy:${project.id}:${project.previewRevision}`} selected="" onSelect={() => {}} sourceDraft={false} dirty={false} onScenes={() => {}} versionLabel={t('historicalVideo')} /> : project.latestExport ? <video aria-label={t('historicalVideo')} controls preload="metadata" src={project.latestExport.videoUrl} /> : null}<p>{t('historicalNote')}</p></div></section></div>;
}
