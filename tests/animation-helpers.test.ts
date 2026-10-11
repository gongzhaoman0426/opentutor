import { DOMParser } from '@xmldom/xmldom';
import { beforeAll, describe, expect, it } from 'vitest';
import type { QuickJSWASMModule } from 'quickjs-emscripten-core';
import { getMotionCueStates } from '../src/shared/motion';
import { loadCustomRuntime, renderCustomFrame, validateSvg, type CustomFrame } from '../src/video/custom-runtime';

let runtime: QuickJSWASMModule;
beforeAll(async () => { runtime = await loadCustomRuntime(); });
const geometry = { fps: 30, width: 1280, height: 720, theme: { background: '#fff', surface: '#fff', text: '#111', muted: '#555', accent: '#369' } };
const resolved = [{ id: 'reveal', utteranceId: 'u1', startFrame: 30, durationFrames: 60, estimated: false }];
function sample(expression: string, sceneFrame = 30, cues = resolved, fps = 30) {
  const svg = renderCustomFrame(runtime, `return '<svg xmlns="http://www.w3.org/2000/svg"><text>'+JSON.stringify(${expression})+'</text></svg>';`, {
    ...geometry, fps, cues: getMotionCueStates(cues, sceneFrame),
  });
  return JSON.parse(new DOMParser().parseFromString(svg, 'image/svg+xml').getElementsByTagName('text')[0].textContent || 'null');
}

describe('optional animation helpers in the real isolated runtime', () => {
  it('has finite interpolation, explicit easing choices and exact endpoints', () => {
    expect(sample('[anim.clamp(-2),anim.clamp(4,2,3),anim.lerp(10,30,0.5),anim.lerp(10,30,1.1),anim.ease(0.5,"linear"),anim.ease(0.5),anim.ease(0.5,"inOutCubic"),anim.ease(0.5,"outQuint")]'))
      .toEqual([0, 3, 20, 32, 0.5, 0.875, 0.5, 0.96875]);
    for (const easing of ['linear', 'outCubic', 'inOutCubic', 'outQuint', 'backOut']) {
      expect(sample(`[anim.ease(-1,"${easing}"),anim.ease(0,"${easing}"),anim.ease(1,"${easing}"),anim.ease(2,"${easing}")]`)).toEqual([0, 0, 1, 1]);
    }
    expect(sample('anim.ease(0.6,"backOut")')).toBeGreaterThan(1);
    expect(sample('anim.clamp(anim.ease(0.6,"backOut"))')).toBe(1);
  });

  it('cannot reveal future cue transitions, then delays only inside the active utterance', () => {
    const expression = 'anim.tween(cues.reveal,0.8,0.2,"linear")';
    for (const frame of [-100, 0, 29, 30, 35, 36]) expect(sample(expression, frame)).toBe(0);
    expect(sample(expression, 48)).toBeCloseTo(0.5);
    expect(sample(expression, 60)).toBe(1);
    expect(sample(expression, 1000)).toBe(1);
  });

  it('compresses delay and transition together when speech is shorter, without a frozen partial end', () => {
    const short = [{ ...resolved[0], durationFrames: 12 }];
    const expression = 'anim.tween(cues.reveal,0.8,0.4,"linear")';
    expect(sample(expression, 33, short)).toBe(0);
    expect(sample(expression, 38, short)).toBeCloseTo(0.5);
    expect(sample(expression, 42, short)).toBe(1);
    expect(sample(expression, 100, short)).toBe(1);
    // The frozen end also completes if a caller has not yet set its completed flag.
    expect(sample('anim.tween({...cues.reveal,completed:false},0.8,0.4,"linear")', 42, short)).toBe(1);
  });

  it('is deterministic when scrubbing backwards and invariant to the render frame rate', () => {
    const expression = '[anim.tween(cues.reveal,1,0,"inOutCubic"),anim.pointOnBezier([0,0],[0,100],[100,100],[100,0],anim.tween(cues.reveal,1,0,"linear"))]';
    const first = sample(expression, 45);
    expect(first).toEqual([0.5, [50, 75]]);
    sample(expression, 900);
    expect(sample(expression, 45)).toEqual(first);
    expect(sample(expression, 90, [{ ...resolved[0], startFrame: 60, durationFrames: 120 }], 60)).toEqual(first);
  });

  it('calculates cubic paths with clamped endpoints without modifying control points', () => {
    expect(sample('[anim.pointOnBezier([0,1],[2,3],[4,5],[6,7],-1),anim.pointOnBezier([0,1],[2,3],[4,5],[6,7],2)]'))
      .toEqual([[0, 1], [6, 7]]);
    expect(sample('(()=>{const p=[3,4];anim.pointOnBezier(p,p,p,p,0.3);return p;})()')).toEqual([3, 4]);
  });

  it.each([
    ['anim.clamp(Infinity)', 'finite number'],
    ['anim.clamp(1,2,0)', 'min must be <= max'],
    ['anim.lerp(0,1,"0.5")', 'finite number'],
    ['anim.ease(0.4,"spring")', 'easing must be'],
    ['anim.ease(0.4,"constructor")', 'easing must be'],
    ['anim.tween(cues.missing,0.4)', 'existing cues.<id>'],
    ['anim.tween(cues.reveal,0)', 'seconds must be > 0'],
    ['anim.tween(cues.reveal,0.4,-1)', 'delay must be >= 0'],
    ['anim.tween(cues.reveal,0.4,0,"missing")', 'easing must be'],
    ['anim.pointOnBezier([0],[0,0],[0,0],[0,0],0.3)', 'each point must be [x, y]'],
    ['anim.pointOnBezier([NaN,0],[0,0],[0,0],[0,0],0.3)', 'finite number'],
  ])('returns repairable helper errors for %s', (expression, error) => {
    expect(() => sample(expression, 0)).toThrow(error);
  });

  it('preserves legacy code, including a local variable named anim', () => {
    const input: CustomFrame = { ...geometry, frame: 45, progress: 0.5 };
    const svg = renderCustomFrame(runtime, 'const anim={x:frame+progress}; return \'<svg xmlns="http://www.w3.org/2000/svg"><text>\'+anim.x+\'</text></svg>\';', input);
    expect(svg).toContain('45.5');
    expect(renderCustomFrame(runtime, 'return \'<svg xmlns="http://www.w3.org/2000/svg"><text>\'+anim.lerp(0,10,progress)+\'</text></svg>\';', input)).toContain('>5</text>');
  });

  it('keeps helpers inside the isolated heap and preserves sandbox limits', () => {
    expect(sample('[Object.isFrozen(anim),typeof fetch,typeof process,typeof window,typeof require,typeof Date,anim.tween.constructor("return typeof process")()]'))
      .toEqual([true, 'undefined', 'undefined', 'undefined', 'undefined', 'undefined', 'undefined']);
    expect(() => sample('(()=>{anim.tween=()=>1;return 0;})()')).toThrow('组件执行失败');
    expect(sample('anim.tween(cues.reveal,0.5)', 0)).toBe(0);
    expect(() => sample('(()=>{while(true){}return 0;})()')).toThrow('组件执行失败');
  });
});

describe('normalized SVG path drawing', () => {
  it('allows pathLength with cue-bound dash interpolation', () => {
    const svg = renderCustomFrame(runtime, 'return \'<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0L100 0" pathLength="1" stroke="#333" stroke-dasharray="1" stroke-dashoffset="\'+(1-anim.tween(cues.reveal,1,0,"linear"))+\'"/></svg>\';', {
      ...geometry, cues: getMotionCueStates(resolved, 45),
    });
    expect(svg).toContain('pathLength="1"');
    expect(svg).toContain('stroke-dashoffset="0.5"');
  });
  it.each(['0', '-1', 'Infinity', 'NaN', '10px', '1;opacity:1', '1e999'])('rejects invalid pathLength %s', value => {
    expect(() => validateSvg(`<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0L1 1" pathLength="${value}"/></svg>`)).toThrow('pathLength 必须是有限正数');
  });
});
