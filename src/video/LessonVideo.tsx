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
import { PresetDiagram } from './PresetDiagram';
import { DIAGRAM_HEIGHT, DIAGRAM_LANGUAGE } from '../shared/diagram';
import { resolveMotionCues, type ResolvedMotionCue } from '../shared/motion';
import { getFullFrameLayout, isVisualObject, type FrameBox } from '../shared/video-layout';

export type LessonVideoProps = { plan: RenderPlan; assets: Asset[]; showSubtitles?: boolean };
const fonts = '"PingFang SC", "Noto Sans CJK SC", "Microsoft YaHei", Arial, sans-serif';

export function LessonVideo({ plan, assets, showSubtitles }: LessonVideoProps) {
  const hasNarrationAudio = Boolean(plan.narrationAudio?.url);
  const subtitles = showSubtitles ?? plan.burnSubtitles ?? true;
  const palette = React.useMemo(() => resolvePalette(plan.theme, plan.palette), [plan.theme, plan.palette]);
  return <AbsoluteFill style={{ fontFamily: fonts, background: palette.background }}>
    {hasNarrationAudio && <Audio src={plan.narrationAudio!.url} pauseWhenBuffering name="连续视频配音" />}
    {plan.scenes.map((scene, index) => <Sequence key={scene.scene.id} from={scene.startFrame} durationInFrames={scene.durationFrames} premountFor={plan.fps}>
      <SceneVideo value={scene} plan={plan} assets={assets} index={index} showSubtitles={subtitles} hasNarrationAudio={hasNarrationAudio} palette={palette} />
    </Sequence>)}
  </AbsoluteFill>;
}

function SceneVideo({ value, plan, assets, index, showSubtitles, hasNarrationAudio, palette }: { value: RenderScene; plan: RenderPlan; assets: Asset[]; index: number; showSubtitles: boolean; hasNarrationAudio: boolean; palette: Palette }) {
  const frame = useCurrentFrame();
  const motionByObject = React.useMemo(() => {
    const resolved = new Map<string, ResolvedMotionCue[]>();
    for (const object of value.scene.objects) if (object.type === 'custom' && object.motion) resolved.set(object.id, resolveMotionCues(object.motion, value.utterances, plan.fps));
    return resolved;
  }, [value.scene.objects, value.utterances, plan.fps]);
  const scale = plan.width / 1280;
  const fullFrame = plan.layoutVersion === 'full-frame';
  const layout = React.useMemo(() => fullFrame ? getFullFrameLayout(value.scene, 1280, plan.height / scale) : null, [fullFrame, value.scene, plan.height, scale]);
  const foreground = palette.text;
  const secondary = palette.muted;
  const active = Math.max(0, value.utterances.findLastIndex(u => u.startFrame <= frame));
  const visible = new Set(value.scene.narration.slice(0, active + 1).flatMap(u => u.showObjectIds));
  const focus = value.scene.narration[active]?.focusObjectId;
  const clip = value.utterances[active];
  const seconds = clip ? (frame - clip.startFrame) / plan.fps : -1;
  const caption = clip?.boundaries.find(b => seconds >= b.startSeconds && seconds < b.endSeconds)?.text;
  const renderObject = (object: TeachingObject, box?: FrameBox) => <ObjectCard object={object} assets={assets} scale={scale} contentWidth={box?.width ?? (value.scene.layout === 'compare' ? 520 : 1104)} contentHeight={box?.height} palette={palette} focused={focus === object.id} frame={frame} resolvedCues={motionByObject.get(object.id)} fps={plan.fps} durationFrames={value.durationFrames} appearAt={value.utterances[value.scene.narration.findIndex(u => u.showObjectIds.includes(object.id))]?.startFrame ?? 0} />;
  return <AbsoluteFill style={{ color: foreground, padding: fullFrame ? 0 : `${48 * scale}px ${64 * scale}px`, background: palette.background }}>
    {layout ? <>
      {layout.title && <h1 style={{ position: 'absolute', left: layout.title.x * scale, top: layout.title.y * scale, width: layout.title.width * scale, height: layout.title.height * scale, margin: 0, display: 'flex', alignItems: 'center', fontSize: (layout.title.width < 600 ? 30 : 40) * scale, lineHeight: 1.2, fontWeight: 650, overflow: 'hidden' }}>{value.scene.title}</h1>}
      {value.scene.objects.filter(object => visible.has(object.id)).map(object => {
        const box = layout.objects[object.id];
        return <div key={object.id} data-video-object={object.id} style={{ position: 'absolute', left: box.x * scale, top: box.y * scale, width: box.width * scale, height: box.height * scale }}>{renderObject(object, box)}</div>;
      })}
    </> : <>
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', color: secondary, fontSize: 16 * scale, letterSpacing: 1.3 }}>
      <span>◈ OPEN TUTOR <span style={{ marginLeft: 22 * scale, letterSpacing: 0 }}>{value.scene.chapter}</span></span>
      <span>{String(index + 1).padStart(2, '0')} / {String(plan.scenes.length).padStart(2, '0')}</span>
    </div>
    <h1 style={{ fontSize: 42 * scale, lineHeight: 1.25, margin: `${30 * scale}px 0 ${26 * scale}px`, fontWeight: 650, maxHeight: 108 * scale, overflow: 'hidden' }}>{value.scene.title}</h1>
    <div style={{ flex: 1, minHeight: 0, display: 'grid', gridTemplateColumns: value.scene.layout === 'compare' ? '1fr 1fr' : '1fr', alignContent: 'start', gap: 16 * scale, overflow: 'hidden', paddingBottom: 24 * scale }}>
      {value.scene.objects.filter(o => visible.has(o.id)).map(o => <React.Fragment key={o.id}>{renderObject(o)}</React.Fragment>)}
    </div>
    </>}
    {showSubtitles && (fullFrame ? caption && <div data-video-subtitles="overlay" style={{ position: 'absolute', left: 32 * scale, right: 32 * scale, bottom: 24 * scale, zIndex: 20, display: 'flex', justifyContent: 'center', pointerEvents: 'none' }}><span style={{ color: '#ffffff', background: 'rgba(0,0,0,0.72)', padding: `${8 * scale}px ${18 * scale}px`, borderRadius: 8 * scale, fontSize: 26 * scale, lineHeight: 1.45, textAlign: 'center', maxWidth: '100%', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{caption}</span></div> : <div data-video-subtitles="footer" style={{ minHeight: 62 * scale, padding: `${12 * scale}px ${20 * scale}px`, borderTop: `1px solid ${palette.muted}44`, color: foreground, fontSize: 24 * scale, lineHeight: 1.55, textAlign: 'center', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>{caption ?? ''}</div>)}
    {!fullFrame && <div style={{ height: 3 * scale, background: `${palette.muted}44`, position: 'absolute', left: 0, right: 0, bottom: 0 }}><div style={{ height: '100%', width: `${(frame / value.durationFrames) * 100}%`, background: palette.accent }} /></div>}
    {!hasNarrationAudio && value.utterances.filter(u => u.url && !u.estimated).map(u => <Sequence key={u.utteranceId} from={u.startFrame} durationInFrames={u.durationFrames} premountFor={plan.fps}><Audio src={u.url} pauseWhenBuffering /></Sequence>)}
  </AbsoluteFill>;
}

function ObjectCard({ object, assets, scale, contentWidth: outerWidth, contentHeight: outerHeight, palette, focused, frame, resolvedCues, fps, durationFrames, appearAt }: { object: TeachingObject; assets: Asset[]; scale: number; contentWidth: number; contentHeight?: number; palette: Palette; focused: boolean; frame: number; resolvedCues?: ResolvedMotionCue[]; fps: number; durationFrames: number; appearAt: number }) {
  const fullFrame = outerHeight !== undefined;
  const visual = isVisualObject(object);
  const contentWidth = fullFrame && !visual ? outerWidth - 48 : outerWidth;
  const contentHeight = outerHeight === undefined ? undefined : Math.max(1, outerHeight - (visual ? 0 : 36));
  const rise = interpolate(frame - appearAt, [0, 8], [12 * scale, 0], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
  const size = object.type === 'code' ? (fullFrame && outerWidth < 650 ? 18 : 22) : (fullFrame && outerWidth < 650 ? 22 : 26);
  const body = React.useMemo(() => {
    let body: React.ReactNode;
    if (object.type === 'custom') body = null;
    else if (object.type === 'diagram' && object.language === DIAGRAM_LANGUAGE) body = fullFrame ? <div style={{ width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center' }}><PresetDiagram content={object.content} width={contentWidth} scale={Math.min(scale, contentHeight! * scale / DIAGRAM_HEIGHT)} palette={palette} /></div> : <PresetDiagram content={object.content} width={contentWidth} scale={scale} palette={palette} />;
    else if (object.type === 'image') {
      const asset = assets.find(a => a.id === object.content);
      body = asset ? <TeachingImage asset={asset} object={object} width={contentWidth * scale} height={contentHeight === undefined ? undefined : contentHeight * scale} scale={scale} /> : <span>素材缺失</span>;
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
  }, [object, assets, scale, contentWidth, contentHeight, fullFrame, palette]);
  const bare = fullFrame && visual;
  return <div data-video-card={object.type} style={{ width: fullFrame ? '100%' : undefined, height: fullFrame ? '100%' : undefined, boxSizing: fullFrame ? 'border-box' : undefined, padding: bare ? 0 : `${18 * scale}px ${24 * scale}px`, borderRadius: bare ? 0 : 14 * scale, fontSize: size * scale, lineHeight: 1.5, background: bare ? undefined : palette.surface, border: bare ? undefined : `1px solid ${focused ? palette.accent : `${palette.muted}44`}`, boxShadow: !bare && focused ? `inset 0 0 0 1px ${palette.accent}44` : undefined, transform: bare ? undefined : `translateY(${rise}px)`, overflow: 'hidden' }}>{object.type === 'custom' ? <CustomGraphic code={object.content} frame={frame - appearAt} sceneFrame={frame} resolvedCues={resolvedCues} fps={fps} durationFrames={durationFrames - appearAt} width={contentWidth} height={contentHeight} scale={scale} palette={palette} /> : body}</div>;
}

function TeachingImage({ asset, object, width, height: allocatedHeight, scale }: { asset: Asset; object: TeachingObject; width: number; height?: number; scale: number }) {
  const [natural, setNatural] = React.useState<{ width: number; height: number } | null>(null);
  const dimensions = asset.width && asset.height ? asset : natural;
  const presentation = object.imagePresentation;
  const fullFrame = allocatedHeight !== undefined;
  const height = allocatedHeight ?? (presentation?.caption ? 248 : 290) * scale;
  const geometry = dimensions?.width && dimensions?.height ? imageGeometry(width, height, dimensions.width, dimensions.height, presentation?.region, presentation?.highlight) : null;
  const image = <Img src={asset.url} alt={presentation?.caption || asset.name} onLoad={event => {
    if (!asset.width || !asset.height) setNatural({ width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight });
  }} style={geometry ? { position: 'absolute', maxWidth: 'none', ...geometry.image } : { width, height, objectFit: 'contain' }} />;
  return <figure style={{ margin: 0, position: fullFrame ? 'relative' : undefined, height: fullFrame ? height : undefined }}>
    <div data-image-viewport style={{ width, maxWidth: '100%', height, position: 'relative' }}>
      {geometry ? <div data-image-crop style={{ position: 'absolute', left: geometry.left, top: geometry.top, width: geometry.width, height: geometry.height, overflow: 'hidden', borderRadius: fullFrame ? 0 : 4 * scale }}>
        {image}
        {geometry.highlight && <div data-image-highlight style={{ position: 'absolute', ...geometry.highlight, border: `${3 * scale}px solid #efb341`, background: '#ffd66022', boxShadow: '0 0 0 9999px #14251c22', boxSizing: 'border-box' }} />}
      </div> : image}
    </div>
    {presentation?.caption && <figcaption style={fullFrame ? { position: 'absolute', left: 20 * scale, top: 16 * scale, maxWidth: '80%', padding: `${5 * scale}px ${10 * scale}px`, color: '#ffffff', background: 'rgba(0,0,0,0.64)', borderRadius: 5 * scale, fontSize: 18 * scale, lineHeight: 1.35, maxHeight: 58 * scale, boxSizing: 'border-box', overflow: 'hidden' } : { fontSize: 19 * scale, lineHeight: 1.35, marginTop: 8 * scale, maxHeight: 52 * scale, display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden', textAlign: 'center' }}>{presentation.caption}</figcaption>}
  </figure>;
}
