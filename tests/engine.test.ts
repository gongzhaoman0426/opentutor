import { describe, expect, it, vi } from 'vitest';
import { compileLesson, chunkSource, codexEnvironment, type JsonRunner } from '../src/engine/codex';
import { normalizeBoundaries, speechCacheKey } from '../src/engine/speech';
import { defaultSettings, type Lesson } from '../src/shared/schema';
import { parseSource } from '../src/shared/source';
import { buildRenderPlan, toSrt } from '../src/video/timeline';

function fixtureLesson(markdown: string): Lesson {
  const source = parseSource(markdown, []);
  return { schemaVersion: '0.1', title: source.title, objectives: ['解释来源内容'], scenes: source.blocks.map((b, i) => ({ id: `s${i}`, title: '学习重点', chapter: b.chapter, layout: 'content', sourceBlockIds: [b.id], objects: [{ id: 'o1', type: 'text', content: b.text.slice(0, 40), language: '' }], narration: [{ id: 'u1', text: '我们逐步理解这个知识点。', showObjectIds: ['o1'], focusObjectId: 'o1' }] })) };
}

describe('director validation', () => {
  it('does not pass application credentials into the harness subprocess', () => {
    vi.stubEnv('AUTH_TOKEN', 'unit-test-session-token');
    vi.stubEnv('DATABASE_URL', 'unit-test-database-url');
    vi.stubEnv('CODEX_PROXY_URL', 'http://127.0.0.1:7890');
    try {
      const env = codexEnvironment();
      expect(env.AUTH_TOKEN).toBeUndefined();
      expect(env.DATABASE_URL).toBeUndefined();
      expect(env.HTTPS_PROXY).toBe('http://127.0.0.1:7890/');
    } finally { vi.unstubAllEnvs(); }
  });
  it('repairs invalid references with bounded model calls, then verifies source coverage', async () => {
    const markdown = '知识需要先理解概念，再通过实例验证。';
    const valid = fixtureLesson(markdown);
    let calls = 0;
    const runner: JsonRunner = async prompt => {
      calls++;
      if (calls === 1) return JSON.stringify({ ...valid, scenes: valid.scenes.map(s => ({ ...s, sourceBlockIds: ['invented-source'] })) });
      expect(prompt).toContain('UNKNOWN_SOURCE');
      return JSON.stringify(valid);
    };
    const result = await compileLesson(markdown, defaultSettings, [], { runner });
    expect(calls).toBe(2);
    expect(result.diagnostics.some(d => d.code === 'DSL_REPAIR')).toBe(true);
    expect(result.lesson.scenes[0].sourceBlockIds).toEqual(valid.scenes[0].sourceBlockIds);
  });
  it('fails after exactly two repairs without using a fake live lesson', async () => {
    let calls = 0;
    await expect(compileLesson('有意义的正文。', defaultSettings, [], { runner: async () => { calls++; return '{}'; } })).rejects.toThrow('已修复 2 次');
    expect(calls).toBe(3);
  });
  it('keeps every original source ID when long chapters are split', () => {
    const source = parseSource(`# 第一章\n\n${'讲义内容。'.repeat(1000)}\n\n# 第二章\n\n后续概念。`, []);
    const chunks = chunkSource(source, 500);
    expect(chunks.length).toBeGreaterThan(2);
    expect(new Set(chunks.flat().map(b => b.id))).toEqual(new Set(source.blocks.map(b => b.id)));
    expect(chunks.every(c => c.map(b => b.markdown).join('').length <= 500)).toBe(true);
    const smaller = chunkSource(source, 100);
    expect(smaller.every(c => c.reduce((length, b) => length + b.markdown.length, 0) <= 100)).toBe(true);
    expect(smaller.every(c => c.some(b => b.type !== 'heading' && b.type !== 'definition'))).toBe(true);
  });
  it('stops before invoking the model when cancelled', async () => {
    const controller = new AbortController(); controller.abort();
    let calls = 0;
    await expect(compileLesson('已取消的讲义。', defaultSettings, [], { signal: controller.signal, runner: async () => { calls++; return '{}'; } })).rejects.toBeDefined();
    expect(calls).toBe(0);
  });
  it('publishes each validated chapter before requesting the next chapter', async () => {
    const markdown = '# 第一章\n\n先认识概念。\n\n# 第二章\n\n再理解实例。';
    const chapters = [{ id: 'chapter-one', title: '第一章', markdown: '# 第一章\n\n先认识概念。' }, { id: 'chapter-two', title: '第二章', markdown: '# 第二章\n\n再理解实例。' }];
    const source = parseSource(markdown, [], chapters);
    const old = fixtureLesson(markdown);
    const full: Lesson = { ...old, scenes: old.scenes.map((scene, index) => ({ ...scene, sourceBlockIds: [source.blocks[index].id] })) };
    const published: number[] = [];
    let calls = 0;
    const runner: JsonRunner = async prompt => {
      if (prompt.includes('COURSE_DATA=')) return JSON.stringify({ summary: '先概念后实例', objectives: ['理解概念'], chapters: chapters.map(c => ({ id: c.id, title: c.title, summary: c.markdown })) });
      calls++;
      if (calls > 1) expect(published.length).toBe(calls - 1);
      const payload = JSON.parse(prompt.split('LECTURE_DATA=')[1]);
      const ids = new Set(payload.sourceBlocks.map((b: { id: string }) => b.id));
      return JSON.stringify({ ...full, scenes: full.scenes.filter(s => s.sourceBlockIds.some(id => ids.has(id))) });
    };
    const result = await compileLesson(markdown, defaultSettings, [], { source, runner, onLesson: partial => { published.push(partial.scenes.length); } });
    expect(calls).toBe(2);
    expect(published[0]).toBeLessThan(result.lesson.scenes.length);
    expect(published[1]).toBe(result.lesson.scenes.length);
  });
});

describe('speech timing and cache', () => {
  it('converts Microsoft 100ns ticks to seconds and retains monotonicity', () => {
    const boundaries = normalizeBoundaries([{ kind: 'sentence', text: '第一句。', offsetTicks: 1_000_000, durationTicks: 10_000_000 }, { kind: 'sentence', text: '第二句。', offsetTicks: 12_000_000, durationTicks: 15_000_000 }], 3, '第一句。第二句。');
    expect(boundaries[0].startSeconds).toBe(0.1);
    expect(boundaries[1].endSeconds).toBe(2.7);
    expect(boundaries[1].startSeconds).toBeGreaterThanOrEqual(boundaries[0].endSeconds);
  });
  it('downgrades malformed boundaries to real utterance duration', () => {
    const bad = [{ kind: 'word' as const, text: '甲', offsetTicks: 20_000_000, durationTicks: 10_000_000 }, { kind: 'word' as const, text: '乙', offsetTicks: 10_000_000, durationTicks: 10_000_000 }];
    expect(normalizeBoundaries(bad, 4, '甲乙')).toEqual([{ kind: 'utterance', text: '甲乙', startSeconds: 0, endSeconds: 4 }]);
  });
  it('keeps real sentence timing when native boundaries overlap by 50ms', () => {
    const actual = [{ kind: 'sentence' as const, text: '第一句。', offsetTicks: 1_000_000, durationTicks: 77_000_000 }, { kind: 'sentence' as const, text: '第二句。', offsetTicks: 77_500_000, durationTicks: 52_125_000 }];
    const boundaries = normalizeBoundaries(actual, 13.032, '第一句。第二句。');
    expect(boundaries.map(b => b.kind)).toEqual(['sentence', 'sentence']);
    expect(boundaries[1].startSeconds).toBe(7.8);
    expect(boundaries[1].endSeconds).toBe(12.9625);
  });
  it('cache identity ignores display whitespace but changes for voice or rate', () => {
    const key = speechCacheKey('hello   world', 'en-US-AriaNeural', 0);
    expect(speechCacheKey('hello world', 'en-US-AriaNeural', 0)).toBe(key);
    expect(speechCacheKey('hello world', 'en-US-GuyNeural', 0)).not.toBe(key);
    expect(speechCacheKey('hello world', 'en-US-AriaNeural', 10)).not.toBe(key);
  });
  it('uses scene-qualified utterance IDs and actual audio duration across the full timeline', () => {
    const lesson = fixtureLesson('第一个概念。\n\n第二个概念。');
    const speech = new Map(lesson.scenes.map((scene, i) => [`${scene.id}:u1`, { url: '/api/artifacts/test', durationSeconds: i + 1, boundaries: [{ kind: 'utterance' as const, text: scene.narration[0].text, startSeconds: 0, endSeconds: i + 1 }], cacheHit: true, hash: `hash${i}` }]));
    const plan = buildRenderPlan(lesson, defaultSettings, speech, 1);
    expect(plan.scenes[1].utterances[0].durationFrames).toBe(60);
    expect(plan.scenes[1].startFrame).toBe(plan.scenes[0].durationFrames);
    expect(toSrt(plan)).toContain('00:00:00,000');
    expect(plan.totalFrames).toBe(plan.scenes.reduce((sum, scene) => sum + scene.durationFrames, 0));
  });
});
