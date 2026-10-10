import { describe, expect, it } from 'vitest';
import { loadCustomRuntime, renderCustomFrame, validateSvg } from '../src/video/custom-runtime';
import { validateCustomCode } from '../src/shared/custom';
import { resolvePalette, stylePresets } from '../src/shared/visual-style';
import { componentCatalog, catalogLesson, waveComponentCode } from '../src/video/catalog';
import { validateCustomLesson } from '../src/engine/custom-validation';

const frame = { frame: 30, fps: 30, width: 1104, height: 286, progress: 0.5, theme: resolvePalette('sage') };
describe('isolated dynamic teaching components', () => {
  it('draws deterministic frames when seeking backwards', async () => {
    const runtime = await loadCustomRuntime();
    const first = renderCustomFrame(runtime, waveComponentCode, frame);
    const later = renderCustomFrame(runtime, waveComponentCode, { ...frame, frame: 90 });
    expect(later).not.toBe(first);
    expect(renderCustomFrame(runtime, waveComponentCode, frame)).toBe(first);
  });
  it('does not expose Node, browser, network, or host time APIs', async () => {
    const runtime = await loadCustomRuntime();
    for (const global of ['process', 'require', 'fetch', 'window', 'document', 'Date']) {
      expect(() => renderCustomFrame(runtime, `return ${global}.toString()`, frame)).toThrow();
    }
  });
  it('interrupts infinite loops and survives the failed component', async () => {
    const runtime = await loadCustomRuntime();
    expect(() => renderCustomFrame(runtime, 'while(true) {}', frame)).toThrow(/interrupted|执行失败/);
    expect(renderCustomFrame(runtime, waveComponentCode, frame)).toContain('<polyline');
  });
  it('limits guest allocation without leaking state to subsequent frames', async () => {
    const runtime = await loadCustomRuntime();
    expect(() => renderCustomFrame(runtime, 'const data=[]; while(true) data.push(new Array(10000).fill(1));', frame)).toThrow();
    expect(renderCustomFrame(runtime, waveComponentCode, frame)).toContain('<svg');
  });
  it('rejects active markup, external resources, CSS and clock-based animation', () => {
    for (const content of ['<script>alert(1)</script>', '<rect onclick="alert(1)"/>', '<foreignObject/>', '<image href="https://example.com/a.png"/>', '<rect fill="url(https://example.com/a)"/>', '<animate attributeName="x"/>', '<rect style="fill:red"/>']) {
      expect(() => validateSvg(`<svg xmlns="http://www.w3.org/2000/svg">${content}</svg>`)).toThrow();
    }
    expect(() => validateSvg('<!DOCTYPE svg><svg xmlns="http://www.w3.org/2000/svg"/>')).toThrow();
  });
  it('accepts internal gradients and reports malformed SVG', () => {
    expect(validateSvg('<svg xmlns="http://www.w3.org/2000/svg"><defs><linearGradient id="fade"><stop offset="0" stop-color="#fff"/></linearGradient></defs><rect width="40" height="40" fill="url(#fade)"/></svg>')).toContain('url(#fade)');
    expect(() => validateSvg('<svg xmlns="http://www.w3.org/2000/svg"><rect></svg>')).toThrow();
  });
  it('rejects CSS escape resource references and indirect paint values', () => {
    for (const fill of [String.raw`u\72l(//paint.test/gradient.svg#p)`, String.raw`\75rl(//paint.test/gradient.svg#p)`, 'u/**/rl(//paint.test/p)', 'var(--external-paint)', 'image-set(url(//paint.test/p))', 'url(//paint.test/p)']) {
      expect(() => validateSvg(`<svg xmlns="http://www.w3.org/2000/svg"><rect fill="${fill}"/></svg>`)).toThrow();
    }
  });
  it('scopes gradients and clipping to each component instance', () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"><defs><linearGradient id="fade"><stop stop-color="rgb(255, 0, 0)"/></linearGradient><clipPath id="crop"><rect width="10" height="10"/></clipPath></defs><rect fill="url(#fade)" clip-path="url(#crop)"/></svg>';
    const first = validateSvg(svg, 'component-a-');
    const second = validateSvg(svg, 'component-b-');
    expect(first).toContain('id="component-a-fade"');
    expect(first).toContain('fill="url(#component-a-fade)"');
    expect(first).toContain('clip-path="url(#component-a-crop)"');
    expect(second).not.toContain('component-a-');
    expect(second).toContain('url(#component-b-fade)');
    expect(() => validateSvg('<svg xmlns="http://www.w3.org/2000/svg"><rect fill="url(#other-component)"/></svg>')).toThrow();
    expect(() => validateSvg('<svg xmlns="http://www.w3.org/2000/svg"><rect id="same"/><circle id="same"/></svg>')).toThrow();
  });
  it('requires a bounded, synchronous string result', async () => {
    const runtime = await loadCustomRuntime();
    expect(validateCustomCode('return <svg/>')).toMatch(/语法/);
    expect(validateCustomCode('x'.repeat(12001))).toMatch(/12000/);
    expect(() => renderCustomFrame(runtime, 'return Promise.resolve("svg")', frame)).toThrow(/同步/);
    expect(() => renderCustomFrame(runtime, 'return "x".repeat(100001)', frame)).toThrow(/太大/);
  });
  it('preflights all creative examples at multiple frames', async () => {
    for (const sample of componentCatalog.filter(item => item.kind === 'creative')) expect(await validateCustomLesson(catalogLesson(sample))).toEqual([]);
    expect(new Set(componentCatalog.map(item => item.plan.scenes[0].scene.layout)).size).toBe(6);
    expect(new Set(componentCatalog.flatMap(item => item.plan.scenes[0].scene.objects.map(object => object.type))).size).toBe(7);
  });
  it('preserves valid presets and corrects unreadable generated colors', () => {
    for (const preset of stylePresets) expect(resolvePalette(preset.id)).toEqual(preset.palette);
    const result = resolvePalette('sage', { background: '#ffffff', surface: '#ffffff', text: '#eeeeee', muted: '#eeeeee', accent: '#447700' });
    expect(result.text).toBe('#14251c'); expect(result.muted).toBe('#14251c');
  });
});
