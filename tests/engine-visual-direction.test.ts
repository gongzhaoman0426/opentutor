import { describe, expect, it } from 'vitest';
import { compileLesson, regenerateScene, type JsonRunner } from '../src/engine/codex';
import { nearbyCodeContext, validateSelfContainedVisuals } from '../src/engine/visual-direction';
import { defaultSettings, validateLesson, type Lesson, type Scene } from '../src/shared/schema';
import { parseSource } from '../src/shared/source';

const markdown = '环境图展示名字和数值的绑定。书中的交互式环境图可逐行执行程序。';
const source = parseSource(markdown);
const diagram: Scene['objects'][number] = { id: 'graphic', type: 'diagram', language: 'diagram-json', content: JSON.stringify({ nodes: [{ id: 'name', label: 'x' }, { id: 'value', label: '-2' }], edges: [{ from: 'name', to: 'value', label: '绑定' }] }) };
function example(graphic = false): Lesson {
  return { schemaVersion: '0.1', title: '名称绑定', objectives: ['观察名称与数值的关系'], scenes: [{ id: 's1', title: '逐行观察环境图', chapter: '绑定', sourceBlockIds: source.blocks.map(block => block.id), layout: 'diagram', objects: graphic ? [diagram] : [{ id: 'text', type: 'text', content: markdown, language: '' }], narration: [{ id: 'u1', text: graphic ? '这里用简化示意图展示名称 x 绑定到负二。' : '书中的交互式环境图可逐行执行程序。', showObjectIds: [graphic ? 'graphic' : 'text'], focusObjectId: graphic ? 'graphic' : 'text' }] }] };
}

describe('self-contained video direction', () => {
  it('repairs the reported text-only book diagram into a visible preset graph without needing an uploaded image', async () => {
    let calls = 0;
    const runner: JsonRunner = async prompt => {
      expect(prompt).toContain('SELF-CONTAINED VISUALS');
      expect(prompt).toContain('Full coverage does NOT require repeating those delivery instructions');
      expect(prompt).toContain('diagram-json');
      if (++calls === 1) return JSON.stringify(example());
      expect(prompt).toContain('MISSING_VISUAL_DEMONSTRATION');
      return JSON.stringify(example(true));
    };
    const result = await compileLesson(markdown, defaultSettings, [], { runner });
    expect(calls).toBe(2);
    expect(result.lesson.scenes[0].objects[0]).toEqual(diagram);
    expect(result.diagnostics.some(issue => issue.code === 'DSL_REPAIR')).toBe(true);
  });

  it('checks the graphic shown with the current utterance, not an unrelated graphic elsewhere in the scene', () => {
    const lesson = example(true);
    const scene = lesson.scenes[0];
    scene.objects.push({ id: 'note', type: 'text', content: '名称与值', language: '' });
    scene.narration.push({ id: 'u2', text: '请观察这张图中的绑定变化。', showObjectIds: ['note'], focusObjectId: 'note' });
    expect(validateSelfContainedVisuals(lesson)).toEqual([expect.objectContaining({ code: 'MISSING_VISUAL_DEMONSTRATION', sceneId: 's1', message: expect.stringContaining('u2') })]);
    scene.narration[1].showObjectIds.push('graphic');
    expect(validateSelfContainedVisuals(lesson)).toEqual([]);
  });

  it('rejects source-page narration even beside a generated drawing, but preserves actual image attribution', () => {
    const lesson = example(true);
    lesson.scenes[0].narration[0].text = '原文的交互式环境图支持逐行执行，并可载入 Online Python Tutor。';
    expect(validateSelfContainedVisuals(lesson)[0]?.code).toBe('SOURCE_PAGE_LEAK');
    lesson.scenes[0].objects[0] = { id: 'graphic', type: 'image', content: 'source-figure', language: '' };
    expect(validateSelfContainedVisuals(lesson)).toEqual([]);
  });

  it('does not count legacy Markdown diagrams as rendered graphics', () => {
    const lesson = example(true);
    lesson.scenes[0].objects[0] = { ...diagram, content: 'x → -2', language: '' };
    expect(validateSelfContainedVisuals(lesson)[0]?.code).toBe('MISSING_VISUAL_DEMONSTRATION');
    // Existing videos still pass the export's shared validator.
    expect(validateLesson(lesson, source, [], 'full', 'stable').filter(issue => issue.severity === 'error')).toEqual([]);
  });

  it('allows ordinary prose, missing-evidence qualifications and a genuine visible software tutorial', () => {
    for (const text of ['环境图是一种表示名称与数值关系的工具。', '书中没有提供实验数据，无法恢复原始测量结果。', '本节讨论图形为何有助于理解复杂信息。', '书中的流程图没有提供，因此无法复原实际审批顺序。', '书中的流程图，目前没有提供。', '我们不展示流程图，先说明本次报告的范围。']) {
      const lesson = example(); lesson.scenes[0].title = '概念介绍';
      lesson.scenes[0].objects[0].content = text; lesson.scenes[0].narration[0].text = text;
      expect(validateSelfContainedVisuals(lesson)).toEqual([]);
    }
    const missing = example(); missing.scenes[0].title = '示意';
    missing.scenes[0].objects[0].content = '书中的流程图，目前没有提供，但请看这张图。';
    missing.scenes[0].narration[0].text = '资料不足，不过我们展示流程图。';
    expect(validateSelfContainedVisuals(missing)).toHaveLength(1);
    const lesson = example(true); lesson.scenes[0].title = '工具操作';
    lesson.scenes[0].objects[0] = { id: 'graphic', type: 'image', content: 'screenshot-id', language: '' };
    lesson.scenes[0].narration[0].text = '点击 Edit this code 加载程序，再点击 Next 查看执行状态。';
    expect(validateSelfContainedVisuals(lesson)).toEqual([]);
  });

  it('a failed visual promise cannot silently pass after all repair attempts', async () => {
    let calls = 0;
    await expect(compileLesson(markdown, defaultSettings, [], { runner: async () => { calls++; return JSON.stringify(example()); } })).rejects.toThrow('视频结构校验未通过');
    expect(calls).toBe(3);
  });

  it('regenerates only the target scene without invalidating unrelated historical narration', async () => {
    const lesson = example();
    lesson.scenes.push({ ...structuredClone(lesson.scenes[0]), id: 'target' });
    const result = await regenerateScene(lesson, 'target', '补上实际图形', source, defaultSettings, [], { runner: async prompt => {
      expect(prompt).toContain('SELF-CONTAINED VISUALS');
      return JSON.stringify({ ...example(true).scenes[0], id: 'target' });
    } });
    expect(result.lesson.scenes[0]).toEqual(lesson.scenes[0]);
    expect(result.lesson.scenes[1].objects[0]).toEqual(diagram);
  });

  it('provides complete nearby code as bounded, noncitable context without copying target code', () => {
    const blocks = parseSource('```python\ndef square(x):\n    return x * x\n```\n\n若调用 square(-2)，环境绑定如下。\n\n```python\nsquare(-2)\n```').blocks;
    const context = nearbyCodeContext(blocks, [blocks[1]]);
    expect(context).toHaveLength(2);
    expect(context).toEqual([expect.objectContaining({ position: 'before', contextOnly: true, content: expect.stringContaining('def square') }), expect.objectContaining({ position: 'after', contextOnly: true })]);
    expect(context.every(item => !('id' in item))).toBe(true);
    expect(nearbyCodeContext(blocks, [blocks[0], blocks[1]])).toHaveLength(1);
    const oversized = { ...blocks[0], markdown: 'x'.repeat(2001) };
    expect(nearbyCodeContext([oversized, blocks[1]], [blocks[1]])).toEqual([]);
    const distant = [blocks[0], ...Array.from({ length: 12 }, (_, i) => ({ ...blocks[1], id: `other-${i}` })), blocks[1]];
    expect(nearbyCodeContext(distant, [blocks[1]])).toEqual([]);
  });

  it('retains adjacent program context when regenerating a scene beyond the chapter excerpt limit', async () => {
    const chapter = { id: 'long', title: '长章节', markdown: `${'早先的说明。'.repeat(5000)}\n\n\`\`\`python\ndef square(x):\n    return x * x\n\`\`\`\n\n${markdown}` };
    const longSource = parseSource('', [], [chapter]);
    const lesson = example();
    lesson.scenes[0].sourceBlockIds = longSource.blocks.slice(0, -1).map(block => block.id);
    lesson.scenes.push({ ...example().scenes[0], id: 'target', chapterId: 'long', sourceBlockIds: [longSource.blocks.at(-1)!.id] });
    await regenerateScene(lesson, 'target', '绘制绑定', longSource, defaultSettings, [], { runner: async prompt => {
      const data = JSON.parse(prompt.split('LECTURE_DATA=')[1]);
      expect(data.chapterContext.markdown).not.toContain('def square');
      expect(data.chapterContext.nearbyCode).toEqual([expect.objectContaining({ content: expect.stringContaining('def square'), contextOnly: true })]);
      return JSON.stringify({ ...example(true).scenes[0], id: 'target', chapterId: 'long', sourceBlockIds: [longSource.blocks.at(-1)!.id] });
    } });
  });
});
