'use client';

import { useMemo, useState } from 'react';
import { Player } from '@remotion/player';
import { ArrowRight, Code2, Play } from 'lucide-react';
import type { GenerationSettings } from '@/shared/schema';
import { componentCatalog } from '@/video/catalog';
import { LessonVideo } from '@/video/LessonVideo';
import { resolvePalette } from '@/shared/visual-style';

const sampleStyle = { width: '100%', aspectRatio: '16/9' } as const;

export function ComponentGallery({ theme, onCreative }: {
  theme: GenerationSettings['theme']; onCreative: () => void;
}) {
  const [selected, setSelected] = useState(componentCatalog[0]?.id ?? '');
  const [filter, setFilter] = useState<'all' | 'preset' | 'creative'>('all');
  const examples = useMemo(() => componentCatalog.map(example => ({ ...example, inputProps: { plan: { ...example.plan, theme, palette: resolvePalette(theme) }, assets: example.assets, showSubtitles: false } })), [theme]);
  const active = examples.find(example => example.id === selected) ?? examples[0];
  const visible = examples.filter(example => filter === 'all' || example.kind === filter);
  return <div className="component-gallery"><div className="component-gallery-intro"><h3>为内容，找到合适的画面。</h3><p>这里展示的是实际视频组件。选择一个示例，播放它的动态效果。</p></div>
    {active && <div className="component-gallery-featured"><div className="component-gallery-player" aria-label={`${active.title}动态预览`}><Player key={active.id} component={LessonVideo} inputProps={active.inputProps} durationInFrames={active.plan.totalFrames} compositionWidth={active.plan.width} compositionHeight={active.plan.height} fps={active.plan.fps} style={sampleStyle} controls loop initiallyMuted initialFrame={Math.min(active.plan.totalFrames - 1, active.plan.fps * 2)} /></div><div className="component-gallery-caption"><span className={`component-kind ${active.kind}`}>{active.kind === 'creative' ? <Code2 size={12} /> : <Play size={11} />}{active.kind === 'creative' ? '创作 JS / SVG' : '预设视频组件'}</span><h4>{active.title}</h4><p>{active.description}</p>{active.kind === 'creative' && <button type="button" className="text-button" onClick={onCreative}>用创作模式生成<ArrowRight size={13} /></button>}</div></div>}
    <div className="component-gallery-heading"><strong>全部组件与布局 <span>{examples.length}</span></strong><div className="component-gallery-filters">{(['all', 'preset', 'creative'] as const).map(value => <button type="button" key={value} className={filter === value ? 'selected' : ''} aria-pressed={filter === value} onClick={() => setFilter(value)}>{{ all: '全部', preset: '稳定预设', creative: '创作组件' }[value]}</button>)}</div></div>
    <div className="component-gallery-grid">{visible.map(example => <button type="button" className={`component-gallery-card ${selected === example.id ? 'selected' : ''}`} aria-pressed={selected === example.id} aria-label={`预览组件：${example.title}`} key={example.id} onClick={() => setSelected(example.id)}><div className="component-gallery-thumbnail" aria-hidden="true"><Player component={LessonVideo} inputProps={example.inputProps} durationInFrames={example.plan.totalFrames} compositionWidth={example.plan.width} compositionHeight={example.plan.height} fps={example.plan.fps} style={sampleStyle} controls={false} clickToPlay={false} initialFrame={Math.min(example.plan.totalFrames - 1, example.plan.fps * 2)} /></div><div><strong>{example.title}</strong><span>{example.kind === 'creative' ? 'JS / SVG' : '预设'}</span></div><p>{example.description}</p></button>)}</div>
  </div>;
}
