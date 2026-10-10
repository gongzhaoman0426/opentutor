import { expect, it } from 'vitest';
import { buildRenderPlan, replaceAssetUrls, toSrt } from '../src/video/timeline';
import { defaultSettings, type Lesson, type SpeechResult } from '../src/shared/schema';
const scene = { id: 'scene1', title: '过程', chapter: '第一章', layout: 'content' as const, sourceBlockIds: ['b1'], objects: [{ id: 'o1', type: 'text' as const, content: '步骤', language: '' }], narration: [{ id: 'u1', text: '步骤一', showObjectIds: ['o1'], focusObjectId: 'o1' }] };
const lesson: Lesson = { schemaVersion: '0.1', title: '课程', objectives: ['理解'], scenes: [scene, { ...scene, id: 'scene2' }] };
const audio: SpeechResult = { url: '/api/artifacts/a', hash: 'a', durationSeconds: 1.01, cacheHit: false, boundaries: [{ kind: 'sentence', text: '步骤一', startSeconds: 0, endSeconds: 1.01 }] };
it('uses actual audio duration with contiguous speech and resolves IDs within scenes', () => {
  const plan = buildRenderPlan(lesson, defaultSettings, new Map([['scene1:u1', audio], ['scene2:u1', { ...audio, durationSeconds: 2 }]]), 2);
  expect(plan.scenes[0].utterances[0].durationFrames).toBe(31);
  expect(plan.scenes.every(s => s.utterances[0].startFrame === 0 && s.durationFrames === s.utterances.reduce((sum, u) => sum + u.durationFrames, 0))).toBe(true);
  expect(plan.scenes[1].startFrame).toBe(plan.scenes[0].durationFrames);
  expect(plan.scenes[1].utterances[0].durationFrames).toBe(60);
  expect(plan.totalFrames).toBe(plan.scenes.reduce((n, s) => n + s.durationFrames, 0));
  expect(toSrt(plan)).toContain('00:00:00,000 --> 00:00:01,010');
});
it('never substitutes estimated timing for missing speech', () => {
  expect(() => buildRenderPlan(lesson, defaultSettings, new Map(), 1)).toThrow('缺少有效配音');
});
it('rewrites the master track for private rendering along with individual speech', () => {
  const plan = buildRenderPlan(lesson, defaultSettings, new Map([['scene1:u1', audio], ['scene2:u1', audio]]), 1);
  plan.narrationAudio = { url: '/api/artifacts/master', durationSeconds: plan.totalFrames / plan.fps };
  const replaced = replaceAssetUrls(plan, [], url => `http://127.0.0.1:4567/${url.split('/').at(-1)}`).plan;
  expect(replaced.narrationAudio?.url).toBe('http://127.0.0.1:4567/master');
  expect(plan.narrationAudio.url).toBe('/api/artifacts/master');
});
