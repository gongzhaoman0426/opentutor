'use client';

import type { GenerationSettings } from '@/shared/schema';
import { videoIntents } from '@/shared/video-intent';
import { useI18n } from '@/i18n/provider';

export function VideoIntentFields({ value, onChange, disabled = false }: {
  value: GenerationSettings; onChange: (next: GenerationSettings) => void; disabled?: boolean;
}) {
  const { t } = useI18n('settings');
  const intent = value.videoIntent ?? 'auto';
  return <div className="video-intent-fields">
    <label className="field">{t('videoIntent')}<select aria-label={t('videoIntent')} value={intent} disabled={disabled} onChange={event => onChange({ ...value, videoIntent: event.target.value as GenerationSettings['videoIntent'] })}>{videoIntents.map(item => <option key={item.id} value={item.id}>{t(`intents.${item.id}.label`)}</option>)}</select><span className="field-hint">{t(`intents.${intent}.description`)}</span></label>
    <label className="field">{t('creativeBrief')} <span className="field-optional">{t('optional')}</span><textarea aria-label={t('creativeBrief')} rows={3} maxLength={2000} value={value.creativeBrief ?? ''} disabled={disabled} onChange={event => onChange({ ...value, creativeBrief: event.target.value })} placeholder={t('briefPlaceholder')} /><span className="field-hint">{t('briefHint')}</span></label>
  </div>;
}
