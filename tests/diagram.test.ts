import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { DOMParser } from '@xmldom/xmldom';
import { describe, expect, it } from 'vitest';
import { DIAGRAM_LANGUAGE, parseDiagram, validateDiagram, type Diagram } from '../src/shared/diagram';
import { validateLesson, type Lesson, type TeachingObject } from '../src/shared/schema';
import { parseSource } from '../src/shared/source';
import { resolvePalette } from '../src/shared/visual-style';
import { PresetDiagram } from '../src/video/PresetDiagram';

const diagram: Diagram = {
  nodes: [{ id: 'name', label: '名称', detail: 'radius' }, { id: 'value', label: '值', detail: '10' }],
  edges: [{ from: 'name', to: 'value', label: '绑定到' }],
};
const source = parseSource('名称绑定到一个值。');
function lessonWith(objects: TeachingObject[], layout: 'content' | 'compare' = 'content'): Lesson {
  return { schemaVersion: '0.1', title: '名称与值', objectives: ['表示绑定关系'], scenes: [{ id: 's1', chapter: '关系', title: '名称绑定到值', layout, sourceBlockIds: source.blocks.map(block => block.id), objects, narration: [{ id: 'u1', text: '名称 radius 绑定到十。', showObjectIds: objects.map(object => object.id), focusObjectId: '' }] }] };
}
const object: TeachingObject = { id: 'd1', type: 'diagram', language: DIAGRAM_LANGUAGE, content: JSON.stringify(diagram, null, 2) };

describe('preset diagram contract', () => {
  it('accepts bounded relationship data and mathematical comparison text without executing code', () => {
    expect(parseDiagram(JSON.stringify(diagram))).toEqual(diagram);
    expect(parseDiagram(JSON.stringify({ nodes: [{ id: 'condition', label: 'x < y' }], edges: [] })).nodes[0].label).toBe('x < y');
  });
  it('rejects malformed references, duplicate identities, oversized graphs and unsupported resource or code fields', () => {
    const invalid = [
      '<svg><script>alert(1)</script></svg>',
      JSON.stringify({ nodes: [{ id: 'a', label: 'A' }, { id: 'a', label: 'B' }], edges: [] }),
      JSON.stringify({ ...diagram, edges: [{ from: 'name', to: 'missing' }] }),
      JSON.stringify({ ...diagram, edges: [{ from: 'name', to: 'name' }] }),
      JSON.stringify({ ...diagram, edges: [diagram.edges[0], diagram.edges[0]] }),
      JSON.stringify({ nodes: Array.from({ length: 7 }, (_, i) => ({ id: `n${i}`, label: '节点' })), edges: [] }),
      JSON.stringify({ ...diagram, edges: Array.from({ length: 9 }, () => diagram.edges[0]) }),
      JSON.stringify({ nodes: [{ id: 'a', label: 'A', href: 'https://example.com/image.svg' }], edges: [] }),
      JSON.stringify({ nodes: [{ id: 'a', label: '<img src="x">' }], edges: [] }),
      JSON.stringify({ ...diagram, code: 'while(true){}' }),
      JSON.stringify({ nodes: [{ id: 'a', label: '很长的标签'.repeat(8) }], edges: [] }),
    ];
    for (const content of invalid) expect(validateDiagram(content)).toBeTypeOf('string');
  });
  it('validates stable-mode drawings as graphics while preserving old Markdown diagrams', () => {
    expect(validateLesson(lessonWith([object]), source, [], 'full', 'stable').filter(issue => issue.severity === 'error' || issue.code === 'DIAGRAM_FALLBACK')).toEqual([]);
    const legacy = { ...object, language: '', content: '① 名称\n\n② 数值' };
    const legacyIssues = validateLesson(lessonWith([legacy]), source, [], 'full', 'stable');
    expect(legacyIssues.some(issue => issue.code === 'DIAGRAM_FALLBACK')).toBe(true);
    expect(legacyIssues.filter(issue => issue.severity === 'error')).toEqual([]);
    expect(validateLesson(lessonWith([{ ...object, content: '{}' }]), source, [], 'full').some(issue => issue.code === 'INVALID_DIAGRAM')).toBe(true);
  });
  it('fits two diagrams in full-frame slots while retaining the legacy card limit', () => {
    const second = { ...object, id: 'd2' };
    expect(validateLesson(lessonWith([object, second], 'compare'), source, [], 'full').some(issue => issue.severity === 'error')).toBe(false);
    expect(validateLesson(lessonWith([object, second]), source, [], 'full').some(issue => issue.code === 'CONTENT_TOO_DENSE')).toBe(false);
    expect(validateLesson(lessonWith([object, second]), source, [], 'full', 'stable', 'legacy').some(issue => issue.code === 'CONTENT_TOO_DENSE')).toBe(true);
  });
});

describe('preset SVG drawing', () => {
  const sixNodes: Diagram = {
    nodes: Array.from({ length: 6 }, (_, index) => ({ id: `n${index}`, label: `第${index + 1}个步骤名称`, detail: '短说明文字' })),
    edges: [{ from: 'n0', to: 'n1', label: '进入' }, { from: 'n1', to: 'n2' }, { from: 'n2', to: 'n3', label: '执行' }, { from: 'n0', to: 'n5', label: '关联' }],
  };
  it.each([520, 1104])('renders deterministic safe SVG with readable nodes inside %ipx width', width => {
    const props = { content: JSON.stringify(sixNodes), width, scale: 1, palette: resolvePalette('ink') };
    const svg = renderToStaticMarkup(React.createElement(PresetDiagram, props));
    expect(svg).toBe(renderToStaticMarkup(React.createElement(PresetDiagram, props)));
    const document = new DOMParser().parseFromString(svg, 'image/svg+xml');
    expect(document.documentElement?.tagName).toBe('svg');
    expect(document.getElementsByTagName('polyline').length).toBe(sixNodes.edges.length);
    expect(document.getElementsByTagName('polygon').length).toBe(sixNodes.edges.length);
    expect(svg).not.toMatch(/<script|<image|<foreignObject|href=|onload=|style="[^"]*url\(/i);
    const nodes = [...document.getElementsByTagName('g')].filter(node => node.hasAttribute('data-diagram-node'));
    expect(nodes).toHaveLength(6);
    for (const group of nodes) {
      const rect = group.getElementsByTagName('rect')[0];
      const x = Number(rect.getAttribute('x')); const y = Number(rect.getAttribute('y'));
      const nodeWidth = Number(rect.getAttribute('width')); const nodeHeight = Number(rect.getAttribute('height'));
      expect(x).toBeGreaterThanOrEqual(0); expect(x + nodeWidth).toBeLessThanOrEqual(width);
      expect(y).toBeGreaterThanOrEqual(0); expect(y + nodeHeight).toBeLessThanOrEqual(286);
      for (const text of [...group.getElementsByTagName('text')]) {
        expect(Number(text.getAttribute('y'))).toBeGreaterThan(y);
        expect(Number(text.getAttribute('y'))).toBeLessThan(y + nodeHeight);
        expect(Number(text.getAttribute('font-size'))).toBeGreaterThanOrEqual(16);
      }
    }
  });
  it('shows a clear error for invalid structured content without treating it as markup', () => {
    const html = renderToStaticMarkup(React.createElement(PresetDiagram, { content: '<svg onload="bad()">', width: 520, scale: 1, palette: resolvePalette('sage') }));
    expect(html).toContain('role="alert"');
    expect(html).not.toContain('<svg');
    expect(html).not.toContain('onload');
  });
  it('keeps opposite-direction labels distinct in both horizontal and vertical relationships', () => {
    const connections = { ...sixNodes, edges: [{ from: 'n0', to: 'n1', label: '请求' }, { from: 'n1', to: 'n0', label: '回复' }, { from: 'n1', to: 'n2', label: '发出' }, { from: 'n2', to: 'n1', label: '返回' }] };
    const svg = renderToStaticMarkup(React.createElement(PresetDiagram, { content: JSON.stringify(connections), width: 520, scale: 1, palette: resolvePalette('ocean') }));
    const document = new DOMParser().parseFromString(svg, 'image/svg+xml');
    const edges = [...document.getElementsByTagName('g')].filter(group => group.hasAttribute('data-diagram-edge'));
    for (const pair of [[0, 1], [2, 3]]) {
      const labels = pair.map(index => edges[index].getElementsByTagName('text')[0]);
      expect(Math.abs(Number(labels[0].getAttribute('y')) - Number(labels[1].getAttribute('y')))).toBeGreaterThan(20);
    }
  });
});
