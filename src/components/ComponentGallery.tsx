'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { Player, type PlayerRef } from '@remotion/player';
import { ArrowRight, Code2, Maximize2, Pause, Play, SkipBack } from 'lucide-react';
import type { GenerationSettings } from '@/shared/schema';
import { componentCatalog } from '@/video/catalog';
import { LessonVideo, type LessonVideoProps } from '@/video/LessonVideo';
import { resolvePalette } from '@/shared/visual-style';
import { useI18n } from '@/i18n/provider';

const sampleStyle = { width: '100%', aspectRatio: '16/9' } as const;

function GalleryPlayer({ inputProps }: { inputProps: LessonVideoProps }) {
  const { t } = useI18n('settings');
  const player = useRef<PlayerRef>(null);
  const [playing, setPlaying] = useState(false);
  useEffect(() => {
    const current = player.current;
    if (!current) return;
    const onPlay = () => setPlaying(true);
    const onPause = () => setPlaying(false);
    current.addEventListener('play', onPlay);
    current.addEventListener('pause', onPause);
    current.addEventListener('ended', onPause);
    return () => { current.removeEventListener('play', onPlay); current.removeEventListener('pause', onPause); current.removeEventListener('ended', onPause); };
  }, []);
  const { plan } = inputProps;
  return <>
    <Player ref={player} component={LessonVideo} inputProps={inputProps} durationInFrames={plan.totalFrames} compositionWidth={plan.width} compositionHeight={plan.height} fps={plan.fps} style={sampleStyle} controls={false} loop initiallyMuted initialFrame={Math.min(plan.totalFrames - 1, plan.fps * 2)} />
    <div className="creation-transport" role="group" aria-label={t('gallery.playbackControls')} style={{ padding: '6px 10px' }}>
      <button type="button" className="icon-button" aria-label={t('gallery.restart')} title={t('gallery.restart')} onClick={() => { player.current?.pause(); player.current?.seekTo(0); }}><SkipBack size={16} /></button>
      <button type="button" className="creation-play-button" aria-label={t(playing ? 'gallery.pause' : 'gallery.play')} title={t(playing ? 'gallery.pause' : 'gallery.play')} onClick={() => player.current?.toggle()}>{playing ? <Pause size={16} /> : <Play size={16} fill="currentColor" />}</button>
      <button type="button" className="icon-button" aria-label={t('gallery.fullscreen')} title={t('gallery.fullscreen')} style={{ marginLeft: 'auto' }} onClick={() => player.current?.requestFullscreen()}><Maximize2 size={16} /></button>
    </div>
  </>;
}

export function ComponentGallery({ theme, onCreative }: {
  theme: GenerationSettings['theme']; onCreative: () => void;
}) {
  const { t } = useI18n('settings');
  const [selected, setSelected] = useState(componentCatalog[0]?.id ?? '');
  const [filter, setFilter] = useState<'all' | 'preset' | 'creative'>('all');
  const examples = useMemo(() => componentCatalog.map(example => ({ ...example, inputProps: { plan: { ...example.plan, theme, palette: resolvePalette(theme) }, assets: example.assets, showSubtitles: false } })), [theme]);
  const active = examples.find(example => example.id === selected) ?? examples[0];
  const visible = examples.filter(example => filter === 'all' || example.kind === filter);
  return <div className="component-gallery"><div className="component-gallery-intro"><h3>{t('gallery.title')}</h3><p>{t('gallery.description')}</p></div>
    {active && <div className="component-gallery-featured"><div className="component-gallery-player" aria-label={t('gallery.animatedPreview', { name: t(`catalog.${active.id}.title`) })}><GalleryPlayer key={active.id} inputProps={active.inputProps} /></div><div className="component-gallery-caption"><span className={`component-kind ${active.kind}`}>{active.kind === 'creative' ? <Code2 size={12} /> : <Play size={11} />}{t(active.kind === 'creative' ? 'gallery.creativeKind' : 'gallery.presetKind')}</span><h4>{t(`catalog.${active.id}.title`)}</h4><p>{t(`catalog.${active.id}.description`)}</p>{active.kind === 'creative' && <button type="button" className="text-button" onClick={onCreative}>{t('gallery.useCreative')}<ArrowRight size={13} /></button>}</div></div>}
    <div className="component-gallery-heading"><strong>{t('gallery.allComponents')} <span>{examples.length}</span></strong><div className="component-gallery-filters">{(['all', 'preset', 'creative'] as const).map(value => <button type="button" key={value} className={filter === value ? 'selected' : ''} aria-pressed={filter === value} onClick={() => setFilter(value)}>{t(`gallery.filters.${value}`)}</button>)}</div></div>
    <div className="component-gallery-grid">{visible.map(example => <button type="button" className={`component-gallery-card ${selected === example.id ? 'selected' : ''}`} aria-pressed={selected === example.id} aria-label={t('gallery.previewComponent', { name: t(`catalog.${example.id}.title`) })} key={example.id} onClick={() => setSelected(example.id)}><div className="component-gallery-thumbnail" aria-hidden="true"><Player component={LessonVideo} inputProps={example.inputProps} durationInFrames={example.plan.totalFrames} compositionWidth={example.plan.width} compositionHeight={example.plan.height} fps={example.plan.fps} style={sampleStyle} controls={false} clickToPlay={false} initialFrame={Math.min(example.plan.totalFrames - 1, example.plan.fps * 2)} /></div><div><strong>{t(`catalog.${example.id}.title`)}</strong><span>{example.kind === 'creative' ? 'JS / SVG' : t('gallery.preset')}</span></div><p>{t(`catalog.${example.id}.description`)}</p></button>)}</div>
  </div>;
}
