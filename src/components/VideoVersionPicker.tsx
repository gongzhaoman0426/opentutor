'use client';

import { History, LoaderCircle } from 'lucide-react';
import type { VideoVersionSummary } from '@/shared/schema';
import { languageLabel } from '@/shared/voices';

function generationTime(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).format(date);
}
export function VideoVersionPicker({ versions, selectedId, selected, generating, pendingPreview, loading, onSelect }: { versions: VideoVersionSummary[]; selectedId: string; selected?: VideoVersionSummary; generating: boolean; pendingPreview: boolean; loading: boolean; onSelect: (id: string) => void }) {
  const latest = versions.find(version => version.current) ?? versions[0];
  const settings = selected?.settings;
  return <div className="video-version-picker">
    <div className="video-version-select-row"><label><History size={14} /><span>视频版本</span><select aria-label="视频版本" value={selectedId} onChange={event => onSelect(event.target.value)} disabled={loading && !versions.length}><option value="latest">{generating ? '最新 / 生成中' : pendingPreview ? '最新 / 未完成预览' : latest ? `最新 · v${latest.version}` : '最新预览'}</option>{versions.map(version => <option key={version.id} value={version.id}>v{version.version} · {generationTime(version.createdAt)}</option>)}</select></label>{loading && <LoaderCircle size={14} className="spin" aria-label="正在读取视频版本" />}</div>
    {selected && !(pendingPreview && selectedId === 'latest') ? <div className="video-version-meta"><time dateTime={selected.createdAt}>生成于 {generationTime(selected.createdAt)}</time>{settings && <span className="video-version-settings" aria-label="所选版本设置" title={`${languageLabel(settings.language)} · ${settings.voice} · ${settings.resolution} · ${settings.creationMode === 'creative' ? '创作模式' : '稳定模式'}`}>{languageLabel(settings.language)} · {settings.voice.split('-').at(-1)?.replace(/Neural$/, '')} · {settings.resolution}</span>}</div> : <p className="video-version-meta">{pendingPreview && selectedId === 'latest' ? '未完成的预览不会计入视频版本，可选择已完成版本下载。' : loading ? '读取本章成功生成的视频…' : versions.length ? '选择版本预览，文稿与生成设置保持不变。' : '成功生成的视频会保存在这里。'}</p>}
  </div>;
}
