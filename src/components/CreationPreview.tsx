'use client';

import { Player, type PlayerRef } from '@remotion/player';
import { useEffect, useMemo, useState, type RefObject } from 'react';
import { ChevronDown, ChevronUp, Layers3, Maximize2, Pause, Play, SkipBack, Volume2, VolumeX } from 'lucide-react';
import type { Asset, RenderPlan } from '@/shared/schema';
import { LessonVideo } from '@/video/LessonVideo';
import { formatTime } from './api';

const playerStyle = { width: '100%', height: '100%' } as const;

export function CreationPreview({ plan, assets, player, revisionKey, selected, onSelect, sourceDraft, dirty, onScenes, compact = false }: {
  plan: RenderPlan; assets: Asset[]; player: RefObject<PlayerRef | null>; revisionKey: string;
  selected: string; onSelect: (id: string) => void; sourceDraft: boolean; dirty: boolean; onScenes: () => void; compact?: boolean;
}) {
  const [frame, setFrame] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [muted, setMuted] = useState(false);
  const [subtitles, setSubtitles] = useState(true);
  const [timelineOpen, setTimelineOpen] = useState(false);
  const ready = plan.scenes.flatMap(scene => scene.utterances).filter(clip => !clip.estimated && clip.url).length;
  const count = plan.scenes.reduce((total, scene) => total + scene.utterances.length, 0);
  const estimated = ready < count;
  const initialFrame = plan.scenes[0]?.utterances[0]?.startFrame ?? 8;
  // A fresh inputProps object changes Remotion's video config and restarts its
  // playback clock. Transport updates must not recreate that object each frame.
  const inputProps = useMemo(() => ({ plan, assets, showSubtitles: subtitles }), [plan, assets, subtitles]);
  const previewPlayer = useMemo(() => <Player key={revisionKey} ref={player} component={LessonVideo} initialFrame={initialFrame} inputProps={inputProps} durationInFrames={plan.totalFrames} compositionWidth={plan.width} compositionHeight={plan.height} fps={plan.fps} style={playerStyle} controls={false} clickToPlay={false} />, [revisionKey, player, initialFrame, inputProps, plan.totalFrames, plan.width, plan.height, plan.fps]);
  useEffect(() => {
    const current = player.current; if (!current) return;
    const update = (event: { detail: { frame: number } }) => setFrame(event.detail.frame);
    const play = () => setPlaying(true); const pause = () => setPlaying(false);
    current.addEventListener('frameupdate', update); current.addEventListener('play', play); current.addEventListener('pause', pause); current.addEventListener('ended', pause);
    setFrame(current.getCurrentFrame()); setPlaying(current.isPlaying());
    return () => { current.removeEventListener('frameupdate', update); current.removeEventListener('play', play); current.removeEventListener('pause', pause); current.removeEventListener('ended', pause); };
  }, [player, revisionKey]);
  useEffect(() => { if (player.current && player.current.getCurrentFrame() >= plan.totalFrames) player.current.seekTo(Math.max(0, plan.totalFrames - 1)); }, [plan.totalFrames, player]);
  const currentScene = plan.scenes.find(scene => frame >= scene.startFrame && frame < scene.startFrame + scene.durationFrames) ?? plan.scenes[0];
  return <>
    <div className="creation-preview-toolbar"><div><span className={`creation-preview-indicator ${estimated ? 'draft' : ''}`} /><strong>{sourceDraft ? '文稿草稿预览' : dirty ? compact ? '上一版预览' : '编辑草稿预览' : plan.previewMode === 'partial' ? '配音未完成 · 增量预览' : estimated ? '场景预览' : '视频预览'}</strong><span>v{plan.revision}</span></div>{!compact && <button className="text-button" onClick={onScenes}><Layers3 size={14} />{plan.scenes.length} 个场景</button>}</div>
    <div className="creation-player-area"><div className="creation-player-fit" style={{ aspectRatio: `${plan.width}/${plan.height}` }}>{previewPlayer}</div></div>
    <div className="creation-preview-description"><span>{sourceDraft ? '原稿分镜，尚未经过 AI 分镜编排。' : dirty ? compact ? '这是保留的旧版预览，本章文稿或设置已更新。' : '内容修改即时可见；需要更新的配音使用无声预览。' : estimated ? `真实配音 ${ready} / ${count} 段，其余段落按预计时长无声播放。` : '配音、字幕与画面已同步。'}</span><span>{plan.width} × {plan.height}</span></div>
    <div className="creation-transport"><div className="creation-play-controls"><button className="icon-button" onClick={() => { player.current?.pause(); player.current?.seekTo(initialFrame); }} aria-label="回到视频开始"><SkipBack size={17} /></button><button className="creation-play-button" aria-label={playing ? '暂停预览' : '播放预览'} onClick={() => player.current?.toggle()}>{playing ? <Pause size={18} /> : <Play size={18} fill="currentColor" />}</button><button className="icon-button" aria-label={muted ? '开启预览声音' : '静音预览'} onClick={() => { if (muted) player.current?.unmute(); else player.current?.mute(); setMuted(!muted); }}>{muted ? <VolumeX size={17} /> : <Volume2 size={17} />}</button></div><span className="creation-timecode">{formatTime(frame / plan.fps)} <i>/</i> {estimated ? '预计 ' : ''}{formatTime(plan.totalFrames / plan.fps)}</span><div className="creation-preview-options">{!compact && <label><input type="checkbox" checked={subtitles} onChange={event => setSubtitles(event.target.checked)} />字幕</label>}{!compact && <button className={`text-button ${timelineOpen ? 'active' : ''}`} onClick={() => setTimelineOpen(!timelineOpen)} aria-expanded={timelineOpen}>时间轴{timelineOpen ? <ChevronDown size={14} /> : <ChevronUp size={14} />}</button>}<button className="icon-button" aria-label="全屏预览" title="全屏预览" onClick={() => player.current?.requestFullscreen()}><Maximize2 size={16} /></button></div></div>
    <label className="creation-playhead"><span className="sr-only">预览播放位置</span><input type="range" min={0} max={Math.max(1, plan.totalFrames - 1)} value={Math.min(frame, plan.totalFrames - 1)} onChange={event => player.current?.seekTo(Number(event.target.value))} /></label>
    {timelineOpen && <div className="creation-timeline"><div className="creation-timeline-heading"><span>场景时间轴 <small>{estimated ? '包含预计时长' : '已对齐'}</small></span><span>{currentScene?.scene.title}</span></div><div className="creation-timeline-track">{plan.scenes.map((scene, index) => <button key={scene.scene.id} className={`${scene.scene.id === selected ? 'selected' : ''} ${scene.utterances.some(u => u.estimated) ? 'estimated' : ''}`} style={{ flexGrow: scene.durationFrames / plan.totalFrames }} onClick={() => onSelect(scene.scene.id)} title={`${index + 1}. ${scene.scene.title} · ${formatTime(scene.durationFrames / plan.fps)}${scene.utterances.some(u => u.estimated) ? '（预计）' : ''}`}><small>{String(index + 1).padStart(2, '0')}</small><span>{scene.scene.title}</span><i>{formatTime(scene.durationFrames / plan.fps)}</i></button>)}</div></div>}
  </>;
}
