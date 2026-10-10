import { describe, expect, it } from 'vitest';
import { parseSource } from '../src/shared/source';
import { LessonSchema, validateLesson, type Asset, type Lesson } from '../src/shared/schema';

describe('source and DSL contracts', () => {
  it('indexes arbitrary Markdown with accurate UTF-16 ranges and distinct repeated blocks', () => {
    const markdown = '# 数学 🧮\n\n相同段落\n\n相同段落\n\n$$\nx^2 + y^2\n$$\n\n| a | b |\n| - | - |\n| 1 | 2 |';
    const source = parseSource(markdown);
    expect(source.title).toBe('数学 🧮');
    expect(new Set(source.blocks.map(b => b.id)).size).toBe(source.blocks.length);
    expect(source.blocks.some(b => b.type === 'math')).toBe(true);
    expect(source.blocks.some(b => b.type === 'table')).toBe(true);
    for (const block of source.blocks) expect(markdown.slice(block.start, block.end)).toBe(block.markdown);
  });
  it('rejects empty lectures and reports missing inline and reference images', () => {
    expect(() => parseSource('  ')).toThrow();
    expect(parseSource('![a](a.png)\n\n![b][b]\n\n[b]: b.png').diagnostics.filter(d => d.severity === 'error')).toHaveLength(2);
  });
  it('rejects unknown, hidden and uncovered source references', () => {
    const source = parseSource('# 学习\n\n第一点\n\n第二点');
    const lesson: Lesson = { schemaVersion: '0.1', title: '学习', objectives: ['理解'], scenes: [{ id: 's1', title: '第一点', chapter: '学习', layout: 'content', sourceBlockIds: [source.blocks[0].id, 'bogus'], objects: [{ id: 'o1', type: 'text', content: '内容', language: '' }], narration: [{ id: 'u1', text: '解释', showObjectIds: [], focusObjectId: 'missing' }] }] };
    LessonSchema.parse(lesson);
    const codes = validateLesson(lesson, source, [], 'full').map(d => d.code);
    expect(codes).toEqual(expect.arrayContaining(['UNKNOWN_SOURCE', 'UNKNOWN_TARGET', 'HIDDEN_OBJECT', 'UNCOVERED_SOURCE']));
    expect(validateLesson(lesson, source, [], 'summary').some(d => d.code === 'UNCOVERED_SOURCE')).toBe(false);
  });
  it('keeps chapter source IDs stable on reordering and skips empty/title-only chapters', () => {
    const chapters = [{ id: 'a', title: '第一章', markdown: '# 概念\n\n第一点' }, { id: 'b', title: '第二章', markdown: '## 实例\n\n第二点' }, { id: 'empty', title: '尚未填写', markdown: '# 尚未填写' }];
    const first = parseSource('', [], chapters); const reordered = parseSource('', [], [chapters[1], chapters[0], chapters[2]]);
    expect(new Set(first.blocks.map(b => b.id))).toEqual(new Set(reordered.blocks.map(b => b.id)));
    expect(first.blocks.every(b => b.chapterId !== 'empty')).toBe(true);
    expect(first.diagnostics.some(d => d.code === 'EMPTY_CHAPTER')).toBe(true);
    expect(() => parseSource('', [], [chapters[2]])).toThrow('所有章节');
    expect(parseSource(chapters[0].markdown).blocks.every(b => b.id.startsWith('block_'))).toBe(true);
  });
  it('resolves canonical/reference images across chapter definitions and rejects ambiguous names', () => {
    const asset: Asset = { id: '00000000-0000-4000-8000-000000000001', name: 'figure.png', mime: 'image/png', url: '/api/artifacts/00000000-0000-4000-8000-000000000001', hash: 'a'.repeat(64) };
    const chapters = [{ id: 'a', title: '图解', markdown: '![教学图][shared]' }, { id: 'b', title: '资料', markdown: `正文。\n\n[shared]: asset://${asset.id}` }];
    const source = parseSource('', [asset], chapters);
    expect(source.diagnostics.some(d => d.severity === 'error')).toBe(false);
    expect(source.imageOccurrences).toEqual([expect.objectContaining({ assetId: asset.id, chapterId: 'a', alt: '教学图' })]);
    const sameName = { ...asset, id: '00000000-0000-4000-8000-000000000002', url: '/api/artifacts/00000000-0000-4000-8000-000000000002' };
    expect(parseSource('![图](figure.png)', [asset, sameName]).diagnostics.some(d => d.code === 'AMBIGUOUS_SOURCE_IMAGE')).toBe(true);
    expect(parseSource(`![图](asset://${asset.id})`, [asset, sameName]).diagnostics.some(d => d.severity === 'error')).toBe(false);
  });
  it('requires the referenced teaching image to actually appear in its narration', () => {
    const asset: Asset = { id: '00000000-0000-4000-8000-000000000001', name: 'figure.png', mime: 'image/png', url: '/api/artifacts/00000000-0000-4000-8000-000000000001', hash: 'a'.repeat(64) };
    const source = parseSource(`![教学图](asset://${asset.id})`, [asset]);
    const lesson: Lesson = { schemaVersion: '0.1', title: '图解', objectives: ['解释图'], scenes: [{ id: 's1', title: '图解', chapter: '图解', layout: 'content', sourceBlockIds: [source.blocks[0].id], objects: [{ id: 'o1', type: 'text', content: '只有正文', language: '' }], narration: [{ id: 'u1', text: '解释正文', showObjectIds: ['o1'], focusObjectId: '' }] }] };
    expect(validateLesson(lesson, source, [asset], 'full').some(d => d.code === 'UNUSED_SOURCE_IMAGE')).toBe(true);
    lesson.scenes[0].objects[0] = { id: 'o1', type: 'image', content: asset.id, language: '' };
    expect(validateLesson(lesson, source, [asset], 'full').some(d => d.code === 'UNUSED_SOURCE_IMAGE')).toBe(false);
  });
  it('locates each inline image within a shared paragraph for lossless batch splitting', () => {
    const asset: Asset = { id: '00000000-0000-4000-8000-000000000001', name: 'figure.png', mime: 'image/png', url: '/api/artifacts/00000000-0000-4000-8000-000000000001', hash: 'a'.repeat(64) };
    const first = `![第一幅](asset://${asset.id})`;
    const second = '![第二幅][shared]';
    const markdown = `🧮 ${'前置说明。'.repeat(500)}${first}${'后续解释。'.repeat(500)}${second}`;
    const source = parseSource('', [asset], [{ id: 'a', title: '图解', markdown }, { id: 'b', title: '图片定义', markdown: `[shared]: asset://${asset.id}` }]);
    expect(source.imageOccurrences).toHaveLength(2);
    expect(source.imageOccurrences!.map(image => markdown.slice(image.start, image.end))).toEqual([first, second]);
    expect(source.imageOccurrences![0].sourceBlockId).toBe(source.imageOccurrences![1].sourceBlockId);
  });
  it('prefers each chapter local reference definition over a same-named course definition', () => {
    const first: Asset = { id: '00000000-0000-4000-8000-000000000001', name: 'a.png', mime: 'image/png', url: '/api/artifacts/00000000-0000-4000-8000-000000000001', hash: 'a'.repeat(64) };
    const second: Asset = { ...first, id: '00000000-0000-4000-8000-000000000002', name: 'b.png', url: '/api/artifacts/00000000-0000-4000-8000-000000000002' };
    const chapters = [{ id: 'a', title: 'A', markdown: `![A图][ref]\n\n[ref]: asset://${first.id}` }, { id: 'b', title: 'B', markdown: `![B图][ref]\n\n[ref]: asset://${second.id}` }];
    const source = parseSource('', [first, second], chapters);
    expect(source.imageOccurrences?.map(o => [o.chapterId, o.assetId])).toEqual([['a', first.id], ['b', second.id]]);
  });
});
