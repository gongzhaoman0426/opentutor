import { describe, expect, it } from 'vitest';
import { buildDraftLesson, buildPreviewPlan } from '../src/video/preview';
import { buildRenderPlan } from '../src/video/timeline';
import { defaultSettings, type Lesson, type SpeechResult } from '../src/shared/schema';

const lesson: Lesson = { schemaVersion: '0.1', title: '步骤', objectives: ['理解'], scenes: [{ id: 'scene', title: '两步过程', chapter: '步骤', layout: 'content', sourceBlockIds: ['source'], objects: [{ id: 'o1', type: 'text', content: '第一步', language: '' }, { id: 'o2', type: 'text', content: '第二步', language: '' }], narration: [{ id: 'u1', text: '先做第一步。', showObjectIds: ['o1'], focusObjectId: 'o1' }, { id: 'u2', text: '再做第二步。', showObjectIds: ['o2'], focusObjectId: 'o2' }] }] };
const speech: SpeechResult = { url: '/api/artifacts/real-test-clip', hash: 'test', cacheHit: false, durationSeconds: 2.25, boundaries: [{ kind: 'sentence', text: '先做第一步。', startSeconds: 0.1, endSeconds: 2.1 }] };

describe('always-available interactive preview', () => {
  it('provides a readable storyboard for empty and arbitrary Markdown without an AI call', () => {
    expect(buildDraftLesson('', '新课程').scenes[0].objects[0].content).toContain('导入 Markdown');
    const draft = buildDraftLesson('# 标题\n\n这是正文。\n\n```python\nprint(1)\n```\n\n$$\na^2 + b^2 = c^2\n$$', '新课程');
    expect(draft.scenes.map(s => s.objects[0].type)).toEqual(['text', 'code', 'formula']);
    expect(draft.scenes.every(s => s.id.startsWith('draft-'))).toBe(true);
    const plan = buildPreviewPlan(draft, defaultSettings, 1);
    expect(plan.previewMode).toBe('draft');
    expect(plan.totalFrames).toBeGreaterThan(0);
    expect(plan.scenes.flatMap(s => s.utterances).every(u => u.estimated && !u.url)).toBe(true);
  });
  it('retains chapter identity and stable image references in draft storyboards', () => {
    const asset = { id: '4fce714d-e161-455b-9437-e612918fd459', name: 'figure.png', mime: 'image/png' as const, url: '/api/artifacts/4fce714d-e161-455b-9437-e612918fd459', hash: 'a' };
    const chapters = [{ id: 'chapter-a', title: '原理', markdown: `![原理图][figure]\n\n[figure]: asset://${asset.id}` }, { id: 'chapter-b', title: '应用', markdown: `![应用图](${asset.url})` }];
    const draft = buildDraftLesson('', '课程', [asset], chapters);
    expect(draft.scenes).toHaveLength(2);
    expect(draft.scenes.map(scene => scene.chapterId)).toEqual(['chapter-a', 'chapter-b']);
    expect(draft.scenes.every(scene => scene.objects[0].type === 'image' && scene.objects[0].content === asset.id)).toBe(true);
    expect(new Set(draft.scenes.map(scene => scene.id)).size).toBe(2);
  });
  it('plays completed real speech while explicitly estimating still-pending segments', () => {
    const partial = buildPreviewPlan(lesson, defaultSettings, 1, null, new Map([['scene:u1', speech]]));
    expect(partial.previewMode).toBe('partial');
    expect(partial.scenes[0].utterances[0].durationFrames).toBe(68);
    expect(partial.scenes[0].utterances[0].estimated).toBe(false);
    expect(partial.scenes[0].utterances[1].estimated).toBe(true);
    expect(partial.scenes[0].utterances[1].url).toBe('');
    expect(partial.scenes[0].utterances[1].startFrame).toBe(68);
  });
  it('reuses voice for visual edits but never uses stale speech after narration or voice changes', () => {
    const audio = buildRenderPlan(lesson, defaultSettings, new Map([['scene:u1', speech], ['scene:u2', { ...speech, hash: 'test2' }]]), 1);
    const visual = structuredClone(lesson); visual.scenes[0].objects[0].content = '调整过的画面';
    expect(buildPreviewPlan(visual, defaultSettings, 2, audio).previewMode).toBe('aligned');
    const edit = structuredClone(lesson); edit.scenes[0].narration[0].text = '改后的第一步。';
    const changed = buildPreviewPlan(edit, defaultSettings, 2, audio);
    expect(changed.previewMode).toBe('partial');
    expect(changed.scenes[0].utterances[0].url).toBe('');
    expect(changed.scenes[0].utterances[1].url).toBe(speech.url);
    expect(buildPreviewPlan(lesson, { ...defaultSettings, rate: 20 }, 2, audio).previewMode).toBe('draft');
    expect(buildPreviewPlan(lesson, { ...defaultSettings, voice: 'zh-CN-YunxiNeural' }, 2, audio).previewMode).toBe('draft');
  });
  it('requires actual audio for production timing even when an estimated preview exists', () => {
    expect(() => buildRenderPlan(lesson, defaultSettings, new Map([['scene:u1', { ...speech, url: '' }]]), 1)).toThrow('缺少有效配音');
  });
  it('keeps the continuous track through visual edits and invalidates it when narration or order changes', () => {
    const audio = buildRenderPlan(lesson, defaultSettings, new Map([['scene:u1', speech], ['scene:u2', { ...speech, hash: 'second' }]]), 1);
    audio.narrationAudio = { url: '/api/artifacts/master-track', durationSeconds: audio.totalFrames / audio.fps };
    const visual = structuredClone(lesson); visual.scenes[0].objects[0].content = '调整过的画面';
    const preview = buildPreviewPlan(visual, defaultSettings, 2, audio);
    expect(preview.narrationAudio).toEqual(audio.narrationAudio);
    expect(preview.scenes.map(s => s.utterances)).toEqual(audio.scenes.map(s => s.utterances.map(u => ({ ...u, estimated: false }))));
    const reordered = structuredClone(lesson); reordered.scenes[0].narration.reverse();
    expect(buildPreviewPlan(reordered, defaultSettings, 2, audio).narrationAudio).toBeUndefined();
    const changed = structuredClone(lesson); changed.scenes[0].narration[0].text = '新的讲稿。';
    expect(buildPreviewPlan(changed, defaultSettings, 2, audio).narrationAudio).toBeUndefined();
    expect(buildPreviewPlan(lesson, defaultSettings, 1, audio, new Map([['scene:u1', { ...speech, url: '/api/artifacts/new-audio' }]])).narrationAudio).toBeUndefined();
    expect(buildPreviewPlan(lesson, { ...defaultSettings, rate: 10 }, 1, audio).narrationAudio).toBeUndefined();
  });
});
