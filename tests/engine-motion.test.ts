import { describe, expect, it } from 'vitest';
import { compileLesson, regenerateScene, type JsonRunner } from '../src/engine/codex';
import { validateCustomLesson } from '../src/engine/custom-validation';
import { defaultSettings, type Lesson } from '../src/shared/schema';
import { validateNarrationCustomCode } from '../src/shared/custom';
import { parseSource } from '../src/shared/source';
import { loadCustomRuntime, renderCustomFrame, type CustomFrame } from '../src/video/custom-runtime';
import { resolvePalette } from '../src/shared/visual-style';
import { getMotionCueStates, resolveMotionCues } from '../src/shared/motion';
import { buildRenderPlan } from '../src/video/timeline';
import { buildPreviewPlan } from '../src/video/preview';

const markdown = 'square(-2) 绑定 x=-2，查找 x 后，负二乘以负二得到四。';
const source = parseSource(markdown);
const code = 'return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1104 286"><text x="24" y="48" font-size="28">${cues.result.started ? "Return value: 4" : "查找 x → -2"}</text></svg>`;';
function lesson(): Lesson {
  return { schemaVersion: '0.1', title: '求值', objectives: ['展示调用求值'], scenes: [{ id: 'scene', title: '查找与返回', chapter: '函数', layout: 'diagram', sourceBlockIds: source.blocks.map(block => block.id), objects: [{ id: 'visual', type: 'custom', content: code, language: 'javascript', motion: { version: 'narration-v1', cues: [{ id: 'result', utteranceId: 'result-line' }] } }], narration: [{ id: 'context-line', text: '先解释名称查找，从局部帧取出 x 的值。', showObjectIds: ['visual'], focusObjectId: 'visual' }, { id: 'result-line', text: '负二乘以负二，得到四。', showObjectIds: ['visual'], focusObjectId: 'visual' }] }] };
}
const creative = { ...defaultSettings, creationMode: 'creative' as const };

describe('narration-bound creative generation', () => {
  it('repairs missing motion contracts and old guessed clocks instead of accepting a legacy timing path', async () => {
    let calls = 0;
    const runner: JsonRunner = async prompt => {
      calls++;
      expect(prompt).toContain('NARRATION-BOUND MOTION');
      const output = lesson();
      if (calls === 1) { delete output.scenes[0].objects[0].motion; output.scenes[0].objects[0].content = code.replace('cues.result.started', 'progress >= 0.55'); }
      if (calls === 2) { expect(prompt).toContain('CUSTOM_MOTION_REQUIRED'); output.scenes[0].objects[0].content = code.replace('cues.result.started', 'progress >= 0.55'); }
      if (calls === 3) expect(prompt).toContain('CUSTOM_COMPONENT_INVALID');
      return JSON.stringify(output);
    };
    const output = await compileLesson(markdown, creative, [], { runner });
    expect(calls).toBe(3);
    expect(output.lesson.scenes[0].objects[0].motion?.cues[0].utteranceId).toBe('result-line');
  });

  it('preflights future cues and rejects references to undeclared cue IDs', async () => {
    const output = lesson();
    expect(await validateCustomLesson(output)).toEqual([]);
    output.scenes[0].objects[0].content = code.replace('cues.result', 'cues.typo');
    expect(await validateCustomLesson(output)).toEqual([expect.objectContaining({ code: 'CUSTOM_COMPONENT_INVALID' })]);
  });

  it('keeps untouched legacy scenes exportable during targeted regeneration', async () => {
    const output = lesson();
    const legacy = structuredClone(output.scenes[0]); legacy.id = 'legacy';
    delete legacy.objects[0].motion; legacy.objects[0].content = code.replace('cues.result.started', 'progress >= 0.55');
    output.scenes.push(legacy);
    const updated = await regenerateScene(output, 'scene', '使动作跟随讲解', source, creative, [], { runner: async () => JSON.stringify(lesson().scenes[0]) });
    expect(updated.lesson.scenes[1]).toEqual(legacy);
    expect(await validateCustomLesson(updated.lesson)).toEqual([]);
  });

  it('allows stable-mode repair to remove a mistakenly generated legacy custom object', async () => {
    let calls = 0;
    await compileLesson(markdown, defaultSettings, [], { runner: async () => {
      const output = lesson(); delete output.scenes[0].objects[0].motion;
      output.scenes[0].objects[0].content = code.replace('cues.result.started', 'progress >= 0.55');
      if (++calls > 1) output.scenes[0].objects[0] = { id: 'visual', type: 'text', content: 'x=-2，计算结果为4。', language: '' };
      return JSON.stringify(output);
    } });
    expect(calls).toBe(2);
  });

  it('does not reveal the result early with long or short speech, changed rates, partial previews, or backwards seeking', async () => {
    const runtime = await loadCustomRuntime();
    const output = lesson();
    for (const contextSeconds of [2.2, 33.766666666666666, 60]) {
      const speech = new Map(output.scenes[0].narration.map((unit, index) => [`scene:${unit.id}`, { url: `/audio/${unit.id}.wav`, durationSeconds: index ? 4 : contextSeconds, boundaries: [{ kind: 'sentence' as const, text: unit.text, startSeconds: index ? 0.08 : 0, endSeconds: index ? 4 : contextSeconds }], cacheHit: true, hash: unit.id }]));
      const plan = buildRenderPlan(output, { ...creative, rate: contextSeconds === 60 ? -50 : 50 }, speech, 1);
      const preview = buildPreviewPlan(output, creative, 1, null, speech);
      const resolved = resolveMotionCues(output.scenes[0].objects[0].motion!, plan.scenes[0].utterances, 30);
      expect(resolveMotionCues(output.scenes[0].objects[0].motion!, preview.scenes[0].utterances, 30)).toEqual(resolved);
      const start = resolved[0].startFrame;
      const render = (frame: number) => renderCustomFrame(runtime, code, { fps: 30, width: 1104, height: 286, theme: resolvePalette('sage'), cues: getMotionCueStates(resolved, frame) });
      expect(render(start - 1)).not.toContain('Return value: 4');
      expect(render(start)).toContain('Return value: 4');
      expect(render(start + 90)).toContain('Return value: 4');
      expect(render(0)).not.toContain('Return value: 4');
      expect(render(start - 1)).not.toContain('Return value: 4');
    }
    const estimated = buildPreviewPlan(output, creative, 1);
    expect(resolveMotionCues(output.scenes[0].objects[0].motion!, estimated.scenes[0].utterances, 30).every(cue => cue.estimated)).toBe(true);
  });

  it('does not expose the full-scene clock to the new VM, even from a mixed untyped input', async () => {
    const runtime = await loadCustomRuntime();
    const geometry = { fps: 30, width: 1104, height: 286, theme: resolvePalette('sage') };
    const cues = { result: { started: false, active: false, completed: false, frame: 0, durationFrames: 300, progress: 0 } };
    const mixed = { ...geometry, frame: 999, progress: 1, cues } as unknown as CustomFrame;
    expect(() => renderCustomFrame(runtime, code.replace('cues.result.started', 'progress >= 0.55'), mixed)).toThrow('progress');
    const inspect = 'return `<svg xmlns="http://www.w3.org/2000/svg"><text>${String(input["progress"])}:${String(input["frame"])}</text></svg>`;';
    expect(renderCustomFrame(runtime, inspect, mixed)).toContain('undefined:undefined');
    expect(renderCustomFrame(runtime, code.replace('cues.result.started', 'progress >= 0.55'), { ...geometry, frame: 999, progress: 1 })).toContain('Return value: 4');
    expect(validateNarrationCustomCode('const p=cues.result.progress; return String(p);')).toBeNull();
    expect(validateNarrationCustomCode('const {progress: cueProgress}=cues.result; return String(cueProgress);')).toBeNull();
    expect(validateNarrationCustomCode('const {progress}=cues.result; return String(progress);')).toContain('progress');
    expect(validateNarrationCustomCode('const cues={}; return "";')).toContain('语法错误');
  });
});
