import { describe, expect, it } from 'vitest';
import { getMotionCueStates, MotionSchema, resolveMotionCues, type Motion } from '../src/shared/motion';
import { LessonSchema, validateLesson, type Lesson, type RenderUtterance } from '../src/shared/schema';
import { parseSource } from '../src/shared/source';

const motion: Motion = { version: 'narration-v1', cues: [{ id: 'introduce', utteranceId: 'u1' }, { id: 'assign', utteranceId: 'u2' }] };
function clip(id: string, startFrame: number, durationFrames: number, speechStart = 0): RenderUtterance {
  return { utteranceId: id, startFrame, durationFrames, durationSeconds: durationFrames / 30, url: `/audio/${id}`, hash: id, cacheHit: false, boundaries: [{ kind: 'sentence', text: id, startSeconds: speechStart, endSeconds: durationFrames / 30 }] };
}
const source = parseSource('先说明变量名称，然后绑定新值。');
function lesson(): Lesson {
  return { schemaVersion: '0.1', title: '动作同步', objectives: ['跟随讲解查看变化'], scenes: [{ id: 's1', title: '名称绑定', chapter: '说明', layout: 'diagram', sourceBlockIds: source.blocks.map(block => block.id), objects: [{ id: 'graphic', type: 'custom', language: '', content: 'return `<svg xmlns="http://www.w3.org/2000/svg"/>`;', motion: structuredClone(motion) }], narration: [{ id: 'u1', text: '先说明名称。', showObjectIds: ['graphic'], focusObjectId: 'graphic' }, { id: 'u2', text: '现在绑定新值。', showObjectIds: ['graphic'], focusObjectId: 'graphic' }] }] };
}
function motionErrors(value: Lesson) { return validateLesson(value, source, [], 'full', 'creative').filter(issue => issue.code === 'INVALID_MOTION'); }

describe('narration motion contract', () => {
  it('accepts valid cues while preserving old objects with missing or null motion', () => {
    const current = lesson();
    expect(LessonSchema.parse(current)).toEqual(current);
    expect(motionErrors(current)).toEqual([]);
    current.scenes[0].objects[0].motion = null;
    expect(LessonSchema.parse(current)).toEqual(current);
    expect(motionErrors(current)).toEqual([]);
    delete current.scenes[0].objects[0].motion;
    expect(LessonSchema.parse(current)).toEqual(current);
    expect(motionErrors(current)).toEqual([]);
  });

  it('rejects unsafe/duplicate cue IDs, repeated narration anchors and unsupported shape', () => {
    for (const id of ['中文', '__proto__', 'name.value', 'name value', 'a'.repeat(65)]) expect(MotionSchema.safeParse({ ...motion, cues: [{ id, utteranceId: 'u1' }] }).success).toBe(false);
    for (const id of [...Object.getOwnPropertyNames(Object.prototype), 'prototype']) expect(MotionSchema.safeParse({ ...motion, cues: [{ id, utteranceId: 'u1' }] }).success).toBe(false);
    for (const cues of [[], [...motion.cues, motion.cues[0]], [{ id: 'first', utteranceId: 'u1' }, { id: 'second', utteranceId: 'u1' }], Array.from({ length: 17 }, (_, i) => ({ id: `cue${i}`, utteranceId: `u${i}` }))]) expect(MotionSchema.safeParse({ ...motion, cues }).success).toBe(false);
    expect(MotionSchema.safeParse({ ...motion, offsetSeconds: -1 }).success).toBe(false);
    expect(MotionSchema.safeParse({ ...motion, version: 'unknown' }).success).toBe(false);
  });

  it('requires custom objects, existing visible anchors and narration order', () => {
    const wrongType = lesson(); wrongType.scenes[0].objects[0].type = 'text';
    expect(motionErrors(wrongType)[0].message).toContain('只有 custom');
    const unknown = lesson(); unknown.scenes[0].objects[0].motion!.cues[0].utteranceId = 'missing';
    expect(motionErrors(unknown)[0].message).toContain('不存在');
    const hidden = lesson(); hidden.scenes[0].narration[1].showObjectIds = [];
    expect(motionErrors(hidden)[0].message).toContain('showObjectIds');
    const reversed = lesson(); reversed.scenes[0].objects[0].motion!.cues.reverse();
    expect(motionErrors(reversed)[0].message).toContain('顺序');
  });
});

describe('motion timing resolved from speech', () => {
  it('uses the first real boundary rounded upward, never a character or scene-duration estimate', () => {
    const resolved = resolveMotionCues(motion, [clip('u1', 0, 90, 0.101), clip('u2', 90, 210, 0.401)], 30);
    expect(resolved).toEqual([{ id: 'introduce', utteranceId: 'u1', startFrame: 4, durationFrames: 86, estimated: false }, { id: 'assign', utteranceId: 'u2', startFrame: 103, durationFrames: 197, estimated: false }]);
    expect(getMotionCueStates(resolved, 102).assign).toMatchObject({ started: false, active: false, completed: false, frame: 0, progress: 0 });
    expect(getMotionCueStates(resolved, 103).assign).toMatchObject({ started: true, active: true, completed: false, frame: 0, progress: 0 });
    expect(getMotionCueStates(resolved, 299).assign.progress).toBeLessThan(1);
    expect(getMotionCueStates(resolved, 300).assign).toEqual({ started: true, active: false, completed: true, frame: 197, durationFrames: 197, progress: 1 });
    expect(getMotionCueStates(resolved, 5000).assign).toEqual(getMotionCueStates(resolved, 300).assign);
  });

  it('can seek backwards and forwards without accumulating time or completing future actions', () => {
    const resolved = resolveMotionCues(motion, [clip('u1', 0, 300), clip('u2', 300, 30)], 30);
    const before = getMotionCueStates(resolved, 299);
    getMotionCueStates(resolved, 400);
    expect(getMotionCueStates(resolved, 299)).toEqual(before);
    expect(before.assign).toEqual({ started: false, active: false, completed: false, frame: 0, durationFrames: 30, progress: 0 });
    expect(getMotionCueStates(resolved, -30).introduce).toMatchObject({ started: false, active: false, completed: false, frame: 0, progress: 0 });
  });

  it('re-resolves estimated and partial previews after real speech changes the timeline', () => {
    const draft = [clip('u1', 0, 90, 0.5), clip('u2', 90, 60, 0.5)].map(value => ({ ...value, estimated: true }));
    expect(resolveMotionCues(motion, draft, 30).map(value => [value.startFrame, value.estimated])).toEqual([[0, true], [90, true]]);
    const partial = [clip('u1', 0, 300, 0.1), { ...clip('u2', 300, 60), estimated: true }];
    expect(resolveMotionCues(motion, partial, 30).map(value => [value.startFrame, value.estimated])).toEqual([[3, false], [300, true]]);
    const aligned = resolveMotionCues(motion, [clip('u1', 0, 300, 0.1), clip('u2', 300, 180, 0.2)], 30);
    expect(aligned.map(value => [value.startFrame, value.estimated])).toEqual([[3, false], [306, false]]);
    expect(getMotionCueStates(aligned, 200).assign.started).toBe(false);
  });

  it('skips unusable boundaries and falls back to the actual clip start when none are valid', () => {
    const first = clip('u1', 12, 90, 0.2);
    first.boundaries.unshift({ kind: 'sentence', text: '坏数据', startSeconds: -1, endSeconds: 1 });
    const second = clip('u2', 102, 90); second.boundaries = [];
    expect(resolveMotionCues(motion, [first, second], 30).map(value => value.startFrame)).toEqual([18, 102]);
    first.boundaries = [{ kind: 'sentence', text: '坏数据', startSeconds: NaN, endSeconds: 1 }];
    expect(resolveMotionCues(motion, [first, second], 30)[0].startFrame).toBe(12);
  });

  it('treats a one-frame action as active before it completes, with no division by zero', () => {
    const resolved = resolveMotionCues({ ...motion, cues: [motion.cues[0]] }, [clip('u1', 4, 1)], 30);
    expect(getMotionCueStates(resolved, 4).introduce).toMatchObject({ active: true, completed: false, progress: 0 });
    expect(getMotionCueStates(resolved, 5).introduce).toMatchObject({ active: false, completed: true, progress: 1 });
  });

  it('fails instead of silently starting cues on missing, overlapping, inverted or invalid timing', () => {
    const good = [clip('u1', 0, 90), clip('u2', 90, 90)];
    for (const fps of [0, -30, NaN, Infinity]) expect(() => resolveMotionCues(motion, good, fps)).toThrow('帧率');
    expect(() => resolveMotionCues(motion, good.slice(0, 1), 30)).toThrow('不存在');
    expect(() => resolveMotionCues(motion, [good[0], good[0]], 30)).toThrow('重复');
    expect(() => resolveMotionCues(motion, [good[1], good[0]], 30)).toThrow('时间轴');
    expect(() => resolveMotionCues(motion, [good[0], clip('u2', 80, 90)], 30)).toThrow('时间轴');
    expect(() => resolveMotionCues(motion, [{ ...good[0], durationFrames: 0 }, good[1]], 30)).toThrow('时间轴');
    expect(() => resolveMotionCues(motion, [{ ...good[0], startFrame: -1 }, good[1]], 30)).toThrow('时间轴');
    expect(() => resolveMotionCues(motion, [{ ...good[0], durationSeconds: Infinity }, good[1]], 30)).toThrow('时间轴');
    expect(() => resolveMotionCues({ ...motion, cues: [...motion.cues].reverse() }, good, 30)).toThrow('顺序');
    expect(() => getMotionCueStates([], NaN)).toThrow('采样帧');
  });

  it('does not expose prototype values as undeclared cue state', () => {
    const resolved = resolveMotionCues({ version: 'narration-v1', cues: [{ id: 'assignment', utteranceId: 'u1' }] }, [clip('u1', 0, 30)], 30);
    const states = getMotionCueStates(resolved, 0);
    expect(Object.getPrototypeOf(states)).toBeNull();
    expect(states.assignment).toMatchObject({ started: true, progress: 0 });
    expect(states.constructor).toBeUndefined();
    expect(states.toString).toBeUndefined();
  });
});
