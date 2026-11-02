import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('remotion', () => ({
  AbsoluteFill: ({ children, style }: { children: React.ReactNode; style?: React.CSSProperties }) => React.createElement('div', { style }, children),
  Sequence: ({ children }: { children: React.ReactNode }) => React.createElement('div', null, children),
  Audio: () => null, Img: ({ src }: { src: string }) => React.createElement('img', { src }),
  useCurrentFrame: () => (globalThis as { __frame?: number }).__frame ?? 0,
  getRemotionEnvironment: () => ({ isRendering: false }), delayRender: () => 1, continueRender: () => {}, cancelRender: (e: Error) => { throw e; },
}));
import { loadCustomRuntime, renderCustomFrame, validateSvg } from '../src/video/custom-runtime';
import { CUSTOM_COMPONENT_API, CUSTOM_EXAMPLES, customBox } from '../src/shared/custom';
import { parseViz } from '../src/shared/viz';
import { validateLesson, defaultSettings, type Lesson, type RenderPlan } from '../src/shared/schema';
import { parseSource } from '../src/shared/source';
import { componentCatalog } from '../src/video/catalog';
import { resolvePalette } from '../src/shared/visual-style';
import { VizGraphic } from '../src/video/Viz';
import { LessonVideo } from '../src/video/LessonVideo';

const theme = resolvePalette('ink');
const base = { frame: 45, fps: 30, progress: 0.5, theme };
const svg = (inner: string) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">${inner}</svg>`;

describe('expanded SVG whitelist', () => {
  it('accepts filters, masks, patterns and internal use references, and namespaces their ids', () => {
    const out = validateSvg(svg('<defs><filter id="f"><feGaussianBlur stdDeviation="6"/><feDropShadow dx="0" dy="4" stdDeviation="3" flood-color="#000000" flood-opacity="0.3"/></filter><mask id="m"><rect width="100" height="100" fill="#ffffff"/></mask><pattern id="p" width="10" height="10" patternUnits="userSpaceOnUse"><circle cx="2" cy="2" r="1" fill="#888888"/></pattern><g id="shape"><circle cx="5" cy="5" r="4"/></g><path id="curve" d="M0 50 C30 0 70 100 100 50"/></defs><rect width="100" height="100" fill="url(#p)" filter="url(#f)" mask="url(#m)"/><use href="#shape"/><text><textPath href="#curve">hello</textPath></text>'), 'x-');
    expect(out).toContain('url(#x-f)'); expect(out).toContain('href="#x-shape"'); expect(out).toContain('id="x-m"');
  });
  it.each([
    ['external image', '<image width="10" height="10"/>'],
    ['foreignObject', '<foreignObject/>'],
    ['external href', '<use href="https://evil.test/x.svg#a"/>'],
    ['href on a shape', '<rect href="#a" width="1" height="1"/>'],
    ['unknown reference', '<rect width="1" height="1" filter="url(#missing)"/>'],
    ['wrong reference type', '<defs><linearGradient id="g"/></defs><rect width="1" height="1" filter="url(#g)"/>'],
    ['CSS filter function', '<rect width="1" height="1" filter="blur(40px)"/>'],
    ['huge blur', '<defs><filter id="f"><feGaussianBlur stdDeviation="500"/></filter></defs>'],
    ['style attribute', '<rect width="1" height="1" style="fill:red"/>'],
    ['use cloning use', '<defs><g id="a"><circle r="1"/></g><use id="b" href="#a"/></defs><use href="#b"/>'],
    ['script', '<script>alert(1)</script>'],
  ])('rejects %s', (_name, inner) => { expect(() => validateSvg(svg(inner))).toThrow(); });
  it('caps amplification primitives', () => {
    expect(() => validateSvg(svg(`<defs><g id="a"><circle r="1"/></g></defs>${'<use href="#a"/>'.repeat(301)}`))).toThrow(/use/);
    expect(() => validateSvg(svg(`<defs>${'<filter id="f"><feGaussianBlur stdDeviation="1"/></filter>'.repeat(1)}</defs>${Array.from({ length: 9 }, (_, i) => `<filter id="g${i}"/>`).join('')}`))).toThrow(/filter/);
  });
});

describe('motion toolkit available inside the sandbox', () => {
  it('exposes the documented helpers and lets generated code shadow them', async () => {
    const runtime = await loadCustomRuntime();
    const probe = `const checks=[typeof clamp,typeof lerp,typeof range,typeof ease.outBack,typeof ease.spring,typeof stagger,typeof mix,typeof alpha,typeof noise,typeof polar,typeof arc,typeof smoothPath,typeof fmt,typeof esc,typeof svg,typeof time];
const t=[ease.outCubic(1),clamp(5),range(5,0,10),fmt(1234567.891,1),mix('#000000','#ffffff',0.5),alpha('#ff0000',0.5),esc('a<b&c')].join('|');
return svg('<text x="0" y="30" font-size="24">'+checks.join(',')+'#'+t+'#'+arc(50,50,10,0,90)+'#'+smoothPath([[0,0],[10,10],[20,0]]).slice(0,2)+'</text>');`;
    const out = renderCustomFrame(runtime, probe, { ...base, ...customBox('content') });
    expect(out).not.toContain('undefined');
    expect(out).toContain('1|1|0.5|1,234,567.9|#808080|rgba(255,0,0,0.500)|a&lt;b&amp;c');
    const shadow = `const clamp=(v)=>v*2, time=3; return svg('<text x="0" y="30" font-size="24">'+clamp(2)+':'+time+'</text>');`;
    expect(renderCustomFrame(runtime, shadow, { ...base, ...customBox('content') })).toContain('4:3');
  });
  it('noise is deterministic and bounded', async () => {
    const runtime = await loadCustomRuntime();
    const code = `let m=0;for(let i=0;i<200;i++)m=Math.max(m,Math.abs(noise(i*0.37,i*0.11,3)));return svg('<text x="0" y="30" font-size="24">'+m.toFixed(3)+'</text>');`;
    const first = renderCustomFrame(runtime, code, { ...base, ...customBox('content') });
    expect(renderCustomFrame(runtime, code, { ...base, ...customBox('content') })).toBe(first);
    expect(Number(/>([\d.]+)</.exec(first)![1])).toBeLessThanOrEqual(1);
  });
});

describe('reference implementations shown to the model', () => {
  it.each(CUSTOM_EXAMPLES.map(example => [example.title, example] as const))('%s renders at many frames without errors', async (_title, example) => {
    const runtime = await loadCustomRuntime();
    const box = customBox(example.layout);
    for (const frame of [0, 10, 30, 60, 120, 240]) {
      const out = renderCustomFrame(runtime, example.code, { frame, fps: 30, ...box, progress: Math.min(1, frame / 240), theme });
      expect(out.length).toBeGreaterThan(200); expect(out).toContain('viewBox');
    }
  });
  it('documents every SVG tag the sandbox accepts', () => {
    for (const tag of ['filter', 'mask', 'pattern', 'textPath', 'feTurbulence', 'use']) expect(CUSTOM_COMPONENT_API).toContain(tag);
    expect(CUSTOM_COMPONENT_API).toContain('1280'); expect(CUSTOM_COMPONENT_API).toContain('stagger');
  });
});

const lessonWith = (layout: 'canvas' | 'content', objects: Lesson['scenes'][0]['objects']): { lesson: Lesson; source: ReturnType<typeof parseSource> } => {
  const source = parseSource('正文内容。', []);
  return { source, lesson: { schemaVersion: '0.1', title: 't', objectives: ['o'], scenes: [{ id: 's', title: '标题', chapter: 'c', layout, sourceBlockIds: source.blocks.map(b => b.id), objects, narration: [{ id: 'n', text: '旁白', showObjectIds: objects.map(o => o.id), focusObjectId: '' }] }] } };
};
const errors = (lesson: Lesson, source: ReturnType<typeof parseSource>, mode: 'stable' | 'creative') => validateLesson(lesson, source, [], 'full', mode).filter(d => d.severity === 'error').map(d => d.code);

describe('canvas layout and viz objects validation', () => {
  const custom = { id: 'c1', type: 'custom' as const, content: 'return svg("")', language: '' };
  it('allows canvas only in creative mode and only with custom layers', () => {
    const ok = lessonWith('canvas', [custom]);
    expect(errors(ok.lesson, ok.source, 'creative')).toEqual([]);
    expect(errors(ok.lesson, ok.source, 'stable')).toContain('CANVAS_MODE');
    const mixed = lessonWith('canvas', [custom, { id: 't', type: 'text', content: '文字', language: '' }]);
    expect(errors(mixed.lesson, mixed.source, 'creative')).toContain('CANVAS_OBJECTS');
  });
  it('validates viz content in any mode and reports malformed JSON for repair', () => {
    const good = lessonWith('content', [{ id: 'v', type: 'viz', content: JSON.stringify({ kind: 'bar', items: [{ label: 'A', value: 1 }] }), language: '' }]);
    expect(errors(good.lesson, good.source, 'stable')).toEqual([]);
    const bad = lessonWith('content', [{ id: 'v', type: 'viz', content: '{"kind":"bar","items":[]}', language: '' }]);
    expect(errors(bad.lesson, bad.source, 'stable')).toContain('INVALID_VIZ');
    expect(parseViz('not json')).toHaveProperty('error');
    expect(parseViz(JSON.stringify({ kind: 'line', labels: ['a', 'b'], series: [{ name: 's', values: [1] }] }))).toHaveProperty('error');
  });
});

describe('rendering', () => {
  const palette = resolvePalette('sage');
  it('draws every viz kind with finite coordinates and animates over time', () => {
    for (const sample of componentCatalog.filter(item => item.id.startsWith('viz-'))) {
      const parsed = parseViz(sample.plan.scenes[0].scene.objects[0].content);
      expect('spec' in parsed).toBe(true);
      if (!('spec' in parsed)) continue;
      const at = (frame: number) => renderToStaticMarkup(React.createElement(VizGraphic, { spec: parsed.spec, frame, fps: 30, width: 1104, height: 286, scale: 1, palette }));
      const start = at(0), end = at(150);
      expect(end).not.toMatch(/NaN|Infinity|undefined/); expect(start).not.toMatch(/NaN|Infinity/);
      expect(end).not.toBe(start);
      expect(renderToStaticMarkup(React.createElement(VizGraphic, { spec: parsed.spec, frame: 150, fps: 30, width: 520, height: 286, scale: 1, palette }))).not.toMatch(/NaN|Infinity/);
    }
  });
  const plan = (layout: 'canvas' | 'content', objects: Lesson['scenes'][0]['objects']): RenderPlan => ({
    schemaVersion: '0.1', revision: 1, title: 't', fps: 30, width: 1280, height: 720, theme: 'ink', totalFrames: 120,
    scenes: [0, 1].map(index => ({ startFrame: index * 60, durationFrames: 60, scene: { id: `s${index}`, title: `标题${index}`, chapter: '章', layout, sourceBlockIds: ['b'], objects, narration: [{ id: 'n0', text: 'a', showObjectIds: [objects[0].id], focusObjectId: '' }] }, utterances: [{ utteranceId: 'n0', startFrame: 0, durationFrames: 60, url: '', durationSeconds: 2, hash: 'h', cacheHit: false, boundaries: [{ kind: 'sentence', text: '这是一句字幕', startSeconds: 0, endSeconds: 2 }], estimated: true }] })),
  });
  it('renders canvas scenes full-bleed without the title chrome, and viz scenes inside the standard layout', () => {
    const canvasHtml = renderToStaticMarkup(React.createElement(LessonVideo, { plan: plan('canvas', [{ id: 'c', type: 'custom', content: CUSTOM_EXAMPLES[1].code, language: '' }]), assets: [] }));
    expect(canvasHtml).toContain('height:720px'); expect(canvasHtml).not.toContain('OPEN TUTOR'); expect(canvasHtml).not.toMatch(/NaN/);
    const vizHtml = renderToStaticMarkup(React.createElement(LessonVideo, { plan: plan('content', [{ id: 'v', type: 'viz', content: JSON.stringify({ kind: 'stat', items: [{ label: '用户', value: 100 }] }), language: '' }]), assets: [] }));
    expect(vizHtml).toContain('stat 图表'); expect(vizHtml).toContain('OPEN TUTOR');
  });
  it('dips between scenes with a background veil and keeps the opening frame fully visible', () => {
    const objects = [{ id: 'o', type: 'text' as const, content: '内容', language: '' }];
    (globalThis as { __frame?: number }).__frame = 0;
    const html = renderToStaticMarkup(React.createElement(LessonVideo, { plan: plan('content', objects), assets: [] }));
    const veils = html.match(/style="position:absolute;inset:0;background:rgba\(/g) ?? [];
    expect(veils.length).toBe(1);
    expect(html.match(/内容/g)!.length).toBe(2);
    delete (globalThis as { __frame?: number }).__frame;
  });
});
