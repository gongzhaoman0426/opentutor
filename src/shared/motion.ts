import { z } from 'zod';
import type { RenderUtterance } from './schema';

const reservedCueIds = new Set([...Object.getOwnPropertyNames(Object.prototype), 'prototype']);
const CueSchema = z.object({
  id: z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/, '动作 ID 应以英文字母开头，只含字母、数字、下划线或短横线，最多64字符')
    .refine(id => !reservedCueIds.has(id), '动作 ID 不能使用 constructor、prototype、toString 等对象保留名称'),
  utteranceId: z.string().min(1).max(80),
}).strict();

export const MotionSchema = z.object({
  version: z.literal('narration-v1'),
  cues: z.array(CueSchema).min(1).max(16),
}).strict().superRefine((motion, context) => {
  const ids = new Set<string>();
  const utterances = new Set<string>();
  for (const [index, cue] of motion.cues.entries()) {
    if (ids.has(cue.id)) context.addIssue({ code: 'custom', path: ['cues', index, 'id'], message: '动作 ID 不能重复' });
    if (utterances.has(cue.utteranceId)) context.addIssue({ code: 'custom', path: ['cues', index, 'utteranceId'], message: '同一组件的每段旁白只能绑定一个动作，请将不同语义动作拆为独立旁白' });
    ids.add(cue.id); utterances.add(cue.utteranceId);
  }
});

export type Motion = z.infer<typeof MotionSchema>;
export type MotionCue = Motion['cues'][number];
export interface ResolvedMotionCue extends MotionCue {
  /** Scene-local frame positions, derived afresh from the current speech plan. */
  startFrame: number;
  durationFrames: number;
  estimated: boolean;
}
export interface MotionCueState {
  started: boolean;
  active: boolean;
  completed: boolean;
  /** Elapsed frames, clamped to [0, durationFrames]; the end frame is exclusive. */
  frame: number;
  durationFrames: number;
  progress: number;
}

/** Resolve narration anchors after TTS, never by character ratios or scene percentages. */
export function resolveMotionCues(motion: Motion, utterances: RenderUtterance[], fps: number): ResolvedMotionCue[] {
  const parsed = MotionSchema.parse(motion);
  if (!Number.isFinite(fps) || fps <= 0) throw new Error('动作时间轴帧率无效');
  const clips = new Map<string, RenderUtterance>();
  let previousEnd = 0;
  for (const clip of utterances) {
    if (!clip.utteranceId || clips.has(clip.utteranceId)) throw new Error('动作时间轴旁白 ID 缺失或重复');
    const end = clip.startFrame + clip.durationFrames;
    if (!Number.isSafeInteger(clip.startFrame) || clip.startFrame < previousEnd || !Number.isSafeInteger(clip.durationFrames) || clip.durationFrames <= 0 || !Number.isSafeInteger(end)
      || !Number.isFinite(clip.durationSeconds) || clip.durationSeconds <= 0 || clip.durationSeconds > clip.durationFrames / fps + 1e-6) throw new Error('动作时间轴包含无效、重叠或倒序的旁白片段');
    clips.set(clip.utteranceId, clip);
    previousEnd = end;
  }
  let previousCueStart = -1;
  return parsed.cues.map(cue => {
    const clip = clips.get(cue.utteranceId);
    if (!clip) throw new Error(`动作 ${cue.id} 引用的旁白不存在：${cue.utteranceId}`);
    if (clip.startFrame <= previousCueStart) throw new Error('动作顺序必须与旁白时间轴一致');
    previousCueStart = clip.startFrame;
    // Estimated previews have no trustworthy speech boundary. Ignore any copied or
    // generated boundaries until real audio arrives and this resolver is run again.
    const boundary = clip.estimated ? undefined : clip.boundaries.find(item =>
      ['word', 'sentence', 'utterance'].includes(item.kind) && Number.isFinite(item.startSeconds) && Number.isFinite(item.endSeconds)
      && item.startSeconds >= 0 && item.endSeconds > item.startSeconds && item.endSeconds <= clip.durationSeconds + 1e-6);
    const offset = boundary ? Math.ceil(boundary.startSeconds * fps) : 0;
    if (offset >= clip.durationFrames) throw new Error(`动作 ${cue.id} 的配音起点没有可用画面帧`);
    return { ...cue, startFrame: clip.startFrame + offset, durationFrames: clip.durationFrames - offset, estimated: Boolean(clip.estimated) };
  });
}

/** Pure frame sampling makes scrubbing, browser playback and export agree. */
export function getMotionCueStates(resolved: ResolvedMotionCue[], sceneFrame: number): Record<string, MotionCueState> {
  if (!Number.isFinite(sceneFrame)) throw new Error('动作采样帧无效');
  const states: Record<string, MotionCueState> = Object.create(null);
  for (const cue of resolved) {
    if (Object.hasOwn(states, cue.id) || !Number.isSafeInteger(cue.startFrame) || cue.startFrame < 0 || !Number.isSafeInteger(cue.durationFrames) || cue.durationFrames <= 0 || !Number.isSafeInteger(cue.startFrame + cue.durationFrames)) throw new Error('已解析的动作时间轴无效');
    const frame = Math.min(cue.durationFrames, Math.max(0, sceneFrame - cue.startFrame));
    const started = sceneFrame >= cue.startFrame;
    const completed = sceneFrame >= cue.startFrame + cue.durationFrames;
    states[cue.id] = { started, active: started && !completed, completed, frame, durationFrames: cue.durationFrames, progress: frame / cue.durationFrames };
  }
  return states;
}
