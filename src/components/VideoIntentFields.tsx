'use client';

import type { GenerationSettings } from '@/shared/schema';
import { videoIntents } from '@/shared/video-intent';

export function VideoIntentFields({ value, onChange, disabled = false }: {
  value: GenerationSettings; onChange: (next: GenerationSettings) => void; disabled?: boolean;
}) {
  const intent = value.videoIntent ?? 'auto';
  return <div className="video-intent-fields">
    <label className="field">视频用途<select aria-label="视频用途" value={intent} disabled={disabled} onChange={event => onChange({ ...value, videoIntent: event.target.value as GenerationSettings['videoIntent'] })}>{videoIntents.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}</select><span className="field-hint">{videoIntents.find(item => item.id === intent)?.description}</span></label>
    <label className="field">创作要求 <span className="field-optional">可选</span><textarea aria-label="创作要求" rows={3} maxLength={2000} value={value.creativeBrief ?? ''} disabled={disabled} onChange={event => onChange({ ...value, creativeBrief: event.target.value })} placeholder="例如：做成面向新用户的产品演示，先呈现问题，再展示操作。也可以指定纪录片、活动预告等其他形式。" /><span className="field-hint">补充视频形式、叙事节奏或重点。留空时根据文稿安排。</span></label>
  </div>;
}
