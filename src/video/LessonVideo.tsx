import React from 'react';
import { AbsoluteFill, Audio, Img, Sequence, interpolate, useCurrentFrame } from 'remotion';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import katex from 'katex';
import type { Asset, Palette, RenderPlan, RenderScene, TeachingObject } from '../shared/schema';
import { imageGeometry } from '../shared/images';
import { resolvePalette } from '../shared/visual-style';
import { CustomGraphic } from './CustomGraphic';

export type LessonVideoProps = { plan: RenderPlan; assets: Asset[]; showSubtitles?: boolean };
const fonts = '"PingFang SC", "Noto Sans CJK SC", "Microsoft YaHei", Arial, sans-serif';

export function LessonVideo({ plan, assets, showSubtitles = true }: LessonVideoProps) {
  const hasNarrationAudio = Boolean(plan.narrationAudio?.url);
  const palette = React.useMemo(() => resolvePalette(plan.theme, plan.palette), [plan.theme, plan.palette]);
  return <AbsoluteFill style={{ fontFamily: fonts, background: palette.background }}>
    {hasNarrationAudio && <Audio src={plan.narrationAudio!.url} pauseWhenBuffering name="连续视频配音" />}
    {plan.scenes.map((scene, index) => <Sequence key={scene.scene.id} from={scene.startFrame} durationInFrames={scene.durationFrames} premountFor={plan.fps}>
      <SceneVideo value={scene} plan={plan} assets={assets} index={index} showSubtitles={showSubtitles} hasNarrationAudio={hasNarrationAudio} palette={palette} />
    </Sequence>)}
  </AbsoluteFill>;
}

function SceneVideo({ value, plan, assets, index, showSubtitles, hasNarrationAudio, palette }: { value: RenderScene; plan: RenderPlan; assets: Asset[]; index: number; showSubtitles: boolean; hasNarrationAudio: boolean; palette: Palette }) {
  const frame = useCurrentFrame();
  const scale = plan.width / 1280;
  const foreground = palette.text;
  const secondary = palette.muted;
  const active = Math.max(0, value.utterances.findLastIndex(u => u.startFrame <= frame));
  const visible = new Set(value.scene.narration.slice(0, active + 1).flatMap(u => u.showObjectIds));
  const focus = value.scene.narration[active]?.focusObjectId;
  const clip = value.utterances[active];
  const seconds = clip ? (frame - clip.startFrame) / plan.fps : -1;
  const caption = clip?.boundaries.find(b => seconds >= b.startSeconds && seconds < b.endSeconds)?.text;
  return <AbsoluteFill style={{ color: foreground, padding: `${48 * scale}px ${64 * scale}px`, background: palette.background }}>
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', color: secondary, fontSize: 16 * scale, letterSpacing: 1.3 }}>
      <span>◈ OPEN TUTOR <span style={{ marginLeft: 22 * scale, letterSpacing: 0 }}>{value.scene.chapter}</span></span>
      <span>{String(index + 1).padStart(2, '0')} / {String(plan.scenes.length).padStart(2, '0')}</span>
    </div>
    <h1 style={{ fontSize: 42 * scale, lineHeight: 1.25, margin: `${30 * scale}px 0 ${26 * scale}px`, fontWeight: 650, maxHeight: 108 * scale, overflow: 'hidden' }}>{value.scene.title}</h1>
    <div style={{ flex: 1, minHeight: 0, display: 'grid', gridTemplateColumns: value.scene.layout === 'compare' ? '1fr 1fr' : '1fr', alignContent: 'start', gap: 16 * scale, overflow: 'hidden', paddingBottom: 24 * scale }}>
      {value.scene.objects.filter(o => visible.has(o.id)).map(o => <ObjectCard key={o.id} object={o} assets={assets} scale={scale} contentWidth={value.scene.layout === 'compare' ? 520 : 1104} palette={palette} focused={focus === o.id} frame={frame} fps={plan.fps} durationFrames={value.durationFrames} appearAt={value.utterances[value.scene.narration.findIndex(u => u.showObjectIds.includes(o.id))]?.startFrame ?? 0} />)}
    </div>
    {showSubtitles && <div style={{ minHeight: 62 * scale, padding: `${12 * scale}px ${20 * scale}px`, borderTop: `1px solid ${palette.muted}44`, color: foreground, fontSize: 24 * scale, lineHeight: 1.55, textAlign: 'center', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>{caption ?? ''}</div>}
    <div style={{ height: 3 * scale, background: `${palette.muted}44`, position: 'absolute', left: 0, right: 0, bottom: 0 }}><div style={{ height: '100%', width: `${(frame / value.durationFrames) * 100}%`, background: palette.accent }} /></div>
    {!hasNarrationAudio && value.utterances.filter(u => u.url && !u.estimated).map(u => <Sequence key={u.utteranceId} from={u.startFrame} durationInFrames={u.durationFrames} premountFor={plan.fps}><Audio src={u.url} pauseWhenBuffering /></Sequence>)}
  </AbsoluteFill>;
}

function ObjectCard({ object, assets, scale, contentWidth, palette, focused, frame, fps, durationFrames, appearAt }: { object: TeachingObject; assets: Asset[]; scale: number; contentWidth: number; palette: Palette; focused: boolean; frame: number; fps: number; durationFrames: number; appearAt: number }) {
  const rise = interpolate(frame - appearAt, [0, 8], [12 * scale, 0], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
  const size = object.type === 'code' ? 22 : 26;
  const body = React.useMemo(() => {
    let body: React.ReactNode;
    if (object.type === 'custom') body = null;
    else if (object.type === 'image') {
      const asset = assets.find(a => a.id === object.content);
      body = asset ? <TeachingImage asset={asset} object={object} width={contentWidth * scale} scale={scale} /> : <span>素材缺失</span>;
    } else if (object.type === 'code') body = <pre style={{ margin: 0, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', fontFamily: '"SFMono-Regular", Consolas, monospace', lineHeight: 1.55 }}>{object.content}</pre>;
    else if (object.type === 'formula') {
      const html = katex.renderToString(object.content, { displayMode: true, throwOnError: false, trust: false });
      body = <div dangerouslySetInnerHTML={{ __html: html }} />;
    } else body = <ReactMarkdown remarkPlugins={[remarkGfm, remarkMath]} rehypePlugins={[[rehypeKatex, { throwOnError: false, trust: false }]]} components={{
      p: ({ children }) => <p style={{ margin: '0.25em 0' }}>{children}</p>,
      ul: ({ children }) => <ul style={{ margin: '0.2em 0', paddingLeft: '1.3em' }}>{children}</ul>,
      ol: ({ children }) => <ol style={{ margin: '0.2em 0', paddingLeft: '1.3em' }}>{children}</ol>,
      li: ({ children }) => <li style={{ padding: '0.12em 0' }}>{children}</li>,
      a: ({ children }) => <span>{children}</span>,
      img: () => <span style={{ color: '#8a7345' }}>（图片应使用独立素材对象）</span>,
      table: ({ children }) => <table style={{ borderCollapse: 'collapse', width: '100%', fontSize: 20 * scale }}>{children}</table>,
      th: ({ children }) => <th style={{ borderBottom: '1px solid #b7c6b3', padding: 8 * scale, textAlign: 'left' }}>{children}</th>,
      td: ({ children }) => <td style={{ borderBottom: '1px solid #d7dfd2', padding: 8 * scale }}>{children}</td>,
      code: ({ children }) => <code style={{ fontFamily: 'monospace', fontSize: '0.85em' }}>{children}</code>,
    }}>{object.content}</ReactMarkdown>;
    return body;
  }, [object, assets, scale, contentWidth]);
  return <div style={{ padding: `${18 * scale}px ${24 * scale}px`, borderRadius: 14 * scale, fontSize: size * scale, lineHeight: 1.5, background: palette.surface, border: `1px solid ${focused ? palette.accent : `${palette.muted}44`}`, boxShadow: focused ? `inset 0 0 0 1px ${palette.accent}44` : undefined, transform: `translateY(${rise}px)`, overflow: 'hidden' }}>{object.type === 'custom' ? <CustomGraphic code={object.content} frame={frame - appearAt} fps={fps} durationFrames={durationFrames - appearAt} width={contentWidth} scale={scale} palette={palette} /> : body}</div>;
}

function TeachingImage({ asset, object, width, scale }: { asset: Asset; object: TeachingObject; width: number; scale: number }) {
  const [natural, setNatural] = React.useState<{ width: number; height: number } | null>(null);
  const dimensions = asset.width && asset.height ? asset : natural;
  const presentation = object.imagePresentation;
  const height = (presentation?.caption ? 248 : 290) * scale;
  const geometry = dimensions?.width && dimensions?.height ? imageGeometry(width, height, dimensions.width, dimensions.height, presentation?.region, presentation?.highlight) : null;
  const image = <Img src={asset.url} alt={presentation?.caption || asset.name} onLoad={event => {
    if (!asset.width || !asset.height) setNatural({ width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight });
  }} style={geometry ? { position: 'absolute', maxWidth: 'none', ...geometry.image } : { width, height, objectFit: 'contain' }} />;
  return <figure style={{ margin: 0 }}>
    <div style={{ width, maxWidth: '100%', height, position: 'relative' }}>
      {geometry ? <div style={{ position: 'absolute', left: geometry.left, top: geometry.top, width: geometry.width, height: geometry.height, overflow: 'hidden', borderRadius: 4 * scale }}>
        {image}
        {geometry.highlight && <div style={{ position: 'absolute', ...geometry.highlight, border: `${3 * scale}px solid #efb341`, background: '#ffd66022', boxShadow: '0 0 0 9999px #14251c22', boxSizing: 'border-box' }} />}
      </div> : image}
    </div>
    {presentation?.caption && <figcaption style={{ fontSize: 19 * scale, lineHeight: 1.35, marginTop: 8 * scale, maxHeight: 52 * scale, display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden', textAlign: 'center' }}>{presentation.caption}</figcaption>}
  </figure>;
}
