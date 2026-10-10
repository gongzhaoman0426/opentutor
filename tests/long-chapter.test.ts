import { describe, expect, it, vi } from 'vitest';
import { mkdirSync } from 'node:fs';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { batchImageOccurrences, chunkSource, CodexTurnTimeoutError, compileLesson, generationProfile, type JsonRunner } from '../src/engine/codex';
import { defaultSettings, type Asset, type Lesson } from '../src/shared/schema';
import { parseSource } from '../src/shared/source';

type Payload = { title: string; settings: { stylePrompt: string }; paletteContext?: Lesson['palette']; sourceBlocks: { id: string; content: string }[]; chapterContext: Record<string, unknown>; courseOverview: { summary: string; chapters: { summary: string }[] } };
const generatedPalette = { background: '#071D32', surface: '#0E3049', text: '#E9F7FF', muted: '#91AFBF', accent: '#38D9E6' };
function payload(prompt: string): Payload { return JSON.parse(prompt.split('LECTURE_DATA=')[1].split('\nREPAIR_ERRORS=')[0]); }
function result(data: Payload): string {
  const lesson: Lesson = { schemaVersion: '0.1', title: data.title, objectives: ['理解相邻知识点的联系'], scenes: [{ id: 's1', title: '知识点', chapter: '本章', layout: 'content', sourceBlockIds: [...new Set(data.sourceBlocks.map(block => block.id))], objects: [{ id: 'o1', type: 'text', content: '用实例连接相关概念。', language: '' }], narration: [{ id: 'u1', text: '我们通过实例理解这些相邻概念之间的联系。', showObjectIds: ['o1'], focusObjectId: 'o1' }] }] };
  return JSON.stringify({ ...lesson, ...(data.settings.stylePrompt ? { palette: data.paletteContext || generatedPalette } : {}) });
}
const cacheFor = (directory: string) => (name = 'cache') => { const target = path.join(directory, name); mkdirSync(target, { recursive: true }); return target; };

describe('bounded long chapter compilation', () => {
  it('bounds image-heavy batches even when many images share one Markdown paragraph', () => {
    const asset: Asset = { id: 'e471e6bd-f1ed-4616-a4b4-c9da7a6c656d', name: 'diagram.png', mime: 'image/png', hash: 'fixture', url: '/api/assets/fixture' };
    for (const separator of ['  ', '\n\n']) {
      const markdown = Array.from({ length: 30 }, (_, index) => `![图 ${index}](asset://${asset.id})`).join(separator);
      const source = parseSource(markdown, [asset]);
      const chunks = chunkSource(source, 3600, 40);
      expect(chunks.length).toBeGreaterThanOrEqual(4);
      expect(chunks.every(blocks => batchImageOccurrences(source, blocks).length <= 8)).toBe(true);
      expect(chunks.flatMap(blocks => batchImageOccurrences(source, blocks))).toHaveLength(30);
      expect(chunks.flat().map(block => block.markdown).join('')).toBe(source.blocks.map(block => block.markdown).join(''));
    }
  });
  it('generates an 88-block creative chapter in small batches without repeated full chapter context', async () => {
    const markdown = '# 编程的要素\n\n' + Array.from({ length: 87 }, (_, index) => `${index + 1}. ${'这是一个需要解释的独立知识点，使用实例说明概念。'.repeat(3)}`).join('\n\n');
    const source = parseSource(markdown);
    const batches: Payload[] = [];
    const runner: JsonRunner = async prompt => { const data = payload(prompt); batches.push(data); return result(data); };
    const output = await compileLesson(markdown, { ...defaultSettings, creationMode: 'creative' }, [], { source, runner });
    expect(batches.length).toBeGreaterThanOrEqual(4);
    expect(batches.length).toBeLessThanOrEqual(7);
    for (const data of batches) {
      expect(data.sourceBlocks.length).toBeLessThanOrEqual(24);
      expect(data.sourceBlocks.reduce((sum, block) => sum + block.content.length, 0)).toBeLessThanOrEqual(1800);
      expect(data.chapterContext).not.toHaveProperty('body');
      expect(data.chapterContext).not.toHaveProperty('allSourceBlockIds');
      expect(data.courseOverview.summary.length).toBeLessThanOrEqual(700);
      expect(data.courseOverview.chapters[0].summary.length).toBeLessThanOrEqual(600);
    }
    expect(batches.flatMap(batch => batch.sourceBlocks).map(block => block.content).join('')).toBe(source.blocks.map(block => block.markdown).join(''));
    expect(new Set(output.lesson.scenes.flatMap(scene => scene.sourceBlockIds))).toEqual(new Set(source.blocks.map(block => block.id)));
  });

  it('persists adaptive splits and reuses successful children on retry instead of timing out the parent again', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'opentutor-batch-retry-'));
    try {
      const markdown = Array.from({ length: 20 }, (_, index) => `知识点 ${index}：${'通过完整讲解解释这项概念。'.repeat(4)}`).join('\n\n');
      const source = parseSource(markdown);
      const publications: Lesson[] = [];
      const firstCalls: Payload[] = [];
      const runner: JsonRunner = async prompt => {
        const data = payload(prompt); firstCalls.push(data);
        if (firstCalls.length === 1) throw new CodexTurnTimeoutError();
        if (firstCalls.length === 3) throw new Error('Codex 生成失败：401 Unauthorized');
        return result(data);
      };
      const options = { source, ownerProjectId: 'owner', cacheDirectory: cacheFor(directory), onLesson: (lesson: Lesson) => { publications.push(lesson); } };
      const settings = { ...defaultSettings, stylePrompt: '深蓝背景，青色强调。' };
      await expect(compileLesson(markdown, settings, [], { ...options, runner })).rejects.toThrow('401');
      expect(firstCalls).toHaveLength(3);
      expect(publications).toHaveLength(1);
      expect((await readdir(path.join(directory, 'chapter-compiler'))).some(name => name.endsWith('.split.json'))).toBe(true);
      const retryCalls: Payload[] = [];
      const output = await compileLesson(markdown, settings, [], { ...options, runner: async prompt => { const data = payload(prompt); retryCalls.push(data); return result(data); } });
      expect(retryCalls.length).toBeGreaterThanOrEqual(1);
      expect(retryCalls.every(data => JSON.stringify(data.sourceBlocks) !== JSON.stringify(firstCalls[0].sourceBlocks) && JSON.stringify(data.sourceBlocks) !== JSON.stringify(firstCalls[1].sourceBlocks))).toBe(true);
      expect(retryCalls[0].sourceBlocks).toEqual(firstCalls[2].sourceBlocks);
      expect(output.lesson.scenes[0].id).toBe(publications[0].scenes[0].id);
      expect(retryCalls.every(data => JSON.stringify(data.paletteContext) === JSON.stringify(generatedPalette))).toBe(true);
      expect(output.lesson.palette).toEqual(generatedPalette);
      expect(output.diagnostics.some(item => item.code === 'CHAPTER_CACHE')).toBe(true);
      expect(new Set(output.lesson.scenes.flatMap(scene => scene.sourceBlockIds))).toEqual(new Set(source.blocks.map(block => block.id)));
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it('retries only typed per-turn timeouts and leaves authentication and generic failures alone', async () => {
    for (const error of [new Error('401 Unauthorized'), new Error('模型配置不可用'), new Error('TimeoutError from an unrelated service')]) {
      let calls = 0;
      await expect(compileLesson('这是足够长的正文。'.repeat(100), defaultSettings, [], { runner: async () => { calls++; throw error; } })).rejects.toBe(error);
      expect(calls).toBe(1);
    }
  });

  it('honors cancellation before adaptive timeout retries', async () => {
    const controller = new AbortController();
    const reason = new Error('用户停止任务');
    let calls = 0;
    await expect(compileLesson('解释变量如何保存数据。'.repeat(100), defaultSettings, [], { signal: controller.signal, runner: async () => { calls++; controller.abort(reason); throw new CodexTurnTimeoutError(); } })).rejects.toBe(reason);
    expect(calls).toBe(1);
  });

  it('has a bounded subdivision depth and reports resumable progress if tiny pieces still time out', async () => {
    let calls = 0;
    await expect(compileLesson('讲解函数参数与返回值。'.repeat(180), { ...defaultSettings, creationMode: 'creative' }, [], { runner: async () => { calls++; throw new CodexTurnTimeoutError(); } })).rejects.toThrow('保留缓存');
    expect(calls).toBeLessThanOrEqual(4);
  });

  it('repairs a response that violates the per-batch scene ceiling without discarding any source IDs', async () => {
    let calls = 0;
    const markdown = '这是一段可以合并讲解的正文。';
    const output = await compileLesson(markdown, defaultSettings, [], { runner: async prompt => {
      calls++; const data = payload(prompt); const good = JSON.parse(result(data)) as Lesson;
      if (calls === 1) return JSON.stringify({ ...good, scenes: Array.from({ length: 13 }, (_, index) => ({ ...good.scenes[0], id: `s${index}` })) });
      expect(prompt).toContain('BATCH_TOO_MANY_SCENES');
      return JSON.stringify(good);
    } });
    expect(calls).toBe(2); expect(output.lesson.scenes).toHaveLength(1);
  });

  it('pins medium reasoning effort by default and keys caches by explicit overrides', async () => {
    vi.stubEnv('CODEX_REASONING_EFFORT', '');
    try {
      const first = JSON.parse(await generationProfile('selected-model'));
      expect(first.reasoningEffort).toBe('medium');
      expect(first.model).toBe('selected-model');
      vi.stubEnv('CODEX_REASONING_EFFORT', 'high');
      const second = JSON.parse(await generationProfile('selected-model'));
      expect(second.reasoningEffort).toBe('high');
      expect(second).not.toEqual(first);
    } finally { vi.unstubAllEnvs(); }
  });
});
