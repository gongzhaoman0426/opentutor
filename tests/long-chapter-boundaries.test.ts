import { describe, expect, it } from 'vitest';
import { batchImageOccurrences, chunkSource, compileLesson } from '../src/engine/codex';
import { defaultSettings, type Asset, type SourceBlock, type SourceDocument } from '../src/shared/schema';
import { parseSource } from '../src/shared/source';

function assertLossless(source: SourceDocument, chunks: SourceBlock[][], characterBudget: number, blockBudget = 40) {
  const pieces = chunks.flat();
  // Compare the actual ordered content, not just a set of IDs: one ID can span many requests.
  expect(pieces.map(piece => piece.markdown).join('')).toBe(source.blocks.map(block => block.markdown).join(''));
  expect(new Set(pieces.map(piece => piece.id))).toEqual(new Set(source.blocks.map(block => block.id)));
  for (const original of source.blocks) {
    const fragments = pieces.filter(piece => piece.id === original.id);
    expect(fragments[0].start).toBe(original.start);
    expect(fragments.at(-1)?.end).toBe(original.end);
    for (const [index, fragment] of fragments.entries()) {
      expect(fragment.markdown).toBe(original.markdown.slice(fragment.start - original.start, fragment.end - original.start));
      expect(fragment.end - fragment.start).toBe(fragment.markdown.length);
      if (index) expect(fragment.start).toBe(fragments[index - 1].end);
      for (const character of fragment.markdown) {
        const point = character.codePointAt(0)!;
        expect(point < 0xd800 || point > 0xdfff, 'a fragment must not contain a broken Unicode surrogate').toBe(true);
      }
    }
  }
  for (const chunk of chunks) {
    expect(chunk.reduce((length, block) => length + block.markdown.length, 0)).toBeLessThanOrEqual(characterBudget);
    expect(chunk.length).toBeLessThanOrEqual(blockBudget);
    expect(chunk.some(block => !['heading', 'definition'].includes(block.type))).toBe(true);
    expect(new Set(chunk.map(block => block.chapterId)).size).toBe(1);
  }
}

describe('long chapter input boundaries', () => {
  it('preserves oversized paragraphs, fenced code, lists and tables without changing source IDs', () => {
    const markdown = [
      '# 编程的要素',
      '程序🧑🏽‍💻让计算机执行指令，变量保存中间结果。'.repeat(100),
      '```python\n' + Array.from({ length: 80 }, (_, index) => `value_${index} = "测试🚀${index}"  # 原样保留缩进与标点`).join('\n') + '\n```',
      Array.from({ length: 30 }, (_, index) => `- 第 ${index + 1} 步：计算 x_${index}，随后验证结果。`).join('\n'),
      '| 名称 | 含义 |\n| --- | --- |\n' + Array.from({ length: 30 }, (_, index) => `| value_${index} | 中间值 ${index} |`).join('\n'),
      '$$\nf(x) = ' + 'x + '.repeat(60) + '1\n$$',
    ].join('\n\n');
    const source = parseSource(markdown);
    for (const budget of [127, 500, 3600]) assertLossless(source, chunkSource(source, budget), budget);
  });

  it('bounds many short blockquotes and paragraphs by block count as well as characters', () => {
    const markdown = '# 短段落组成的长章\n\n' + Array.from({ length: 150 }, (_, index) => `> 引文 ${index}：先观察。\n\n正文 ${index}：再验证。`).join('\n\n');
    const source = parseSource(markdown);
    expect(source.blocks.filter(block => block.type === 'blockquote')).toHaveLength(150);
    expect(source.blocks.filter(block => block.type === 'paragraph')).toHaveLength(150);
    const chunks = chunkSource(source, 3600, 12);
    expect(chunks.length).toBeGreaterThan(20);
    assertLossless(source, chunks, 3600, 12);
  });

  it('retains a trailing heading and its preceding body in the original order', () => {
    const markdown = '首段😀。'.repeat(70) + '\n\n# ' + '末标题'.repeat(25);
    const source = parseSource(markdown);
    assertLossless(source, chunkSource(source, 128, 8), 128, 8);
  });

  it('keeps consecutive headings with real teaching content without a title-only request', () => {
    const markdown = '# 开篇\n\n' + '引入。'.repeat(40) + '\n\n## 下一节\n\n### 子节\n\n' + '正文内容🌱。'.repeat(200);
    const source = parseSource(markdown);
    assertLossless(source, chunkSource(source, 128, 8), 128, 8);
  });

  it('reports an impossible heading budget instead of silently dropping heading text', () => {
    const source = parseSource('# ' + '题'.repeat(300) + '\n\n' + '充足正文。'.repeat(200));
    expect(() => chunkSource(source, 128, 8)).toThrow(/标题.*预算/);
  });

  it('refuses a title-only document before making a model request', async () => {
    let calls = 0;
    await expect(compileLesson('# 第一章\n\n## 只有标题', defaultSettings, [], {
      runner: async () => { calls++; return '{}'; },
    })).rejects.toThrow(/只有标题|没有可讲解/);
    expect(calls).toBe(0);
  });

  it('does not mix chapters even when adjacent chapter offsets and body text repeat', () => {
    const chapters = [
      { id: 'chapter-a', title: '第一章', markdown: '# 第一章\n\n' + '相同原文🔬。'.repeat(100) },
      { id: 'chapter-b', title: '第二章', markdown: '# 第二章\n\n' + '相同原文🔬。'.repeat(100) },
    ];
    const source = parseSource('', [], chapters);
    assertLossless(source, chunkSource(source, 128, 8), 128, 8);
  });

  it('assigns each image occurrence only to the fragment containing its complete syntax', () => {
    const asset: Asset = { id: 'e471e6bd-f1ed-4616-a4b4-c9da7a6c656d', name: 'diagram.png', mime: 'image/png', hash: 'test-image', url: '/api/assets/test-image' };
    const firstImage = `![第一幅](asset://${asset.id})`;
    const secondImage = `![第二幅](asset://${asset.id})`;
    const markdown = '# ' + '长标题'.repeat(29) + '\n\n前言' + firstImage + '观察第一幅图中的变化。'.repeat(60) + secondImage + '再比较第二幅图。'.repeat(40);
    const source = parseSource(markdown, [asset]);
    expect(source.imageOccurrences).toHaveLength(2);
    expect(source.blocks.filter(block => block.type === 'paragraph')).toHaveLength(1);
    const chunks = chunkSource(source, 128, 8);
    assertLossless(source, chunks, 128, 8);
    const selectedOccurrences = chunks.flatMap(chunk => batchImageOccurrences(source, chunk));
    expect(selectedOccurrences.map(occurrence => occurrence.id).sort()).toEqual(source.imageOccurrences!.map(occurrence => occurrence.id).sort());
    for (const occurrence of source.imageOccurrences!) {
      const owner = chunks.find(chunk => batchImageOccurrences(source, chunk).some(selected => selected.id === occurrence.id))!;
      const containing = owner.find(block => block.id === occurrence.sourceBlockId && block.start <= occurrence.start! && block.end >= occurrence.end!);
      expect(containing, 'the request owning an image must receive its complete original Markdown syntax').toBeDefined();
      expect(containing!.markdown).toContain(markdown.slice(occurrence.start, occurrence.end));
    }
  });
});
