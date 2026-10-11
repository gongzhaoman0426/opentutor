import { describe, expect, it } from 'vitest';
import { DOMParser } from '@xmldom/xmldom';
import { loadCustomRuntime, renderCustomFrame, validateSvg } from '../src/video/custom-runtime';
import { validateCustomCode } from '../src/shared/custom';
import { resolvePalette, stylePresets } from '../src/shared/visual-style';
import { componentCatalog, catalogLesson, waveComponentCode, type ComponentExample } from '../src/video/catalog';
import { validateCustomLesson } from '../src/engine/custom-validation';
import { getMotionCueStates, resolveMotionCues } from '../src/shared/motion';
import { getFullFrameLayout } from '../src/shared/video-layout';

const frame = { frame: 30, fps: 30, width: 1104, height: 286, progress: 0.5, theme: resolvePalette('sage') };
const wave = componentCatalog.find(sample => sample.id === 'custom-wave')!;
function sampleFrame(sample: ComponentExample, sceneFrame: number) {
  const scene = sample.plan.scenes[0];
  const motion = scene.scene.objects[0].motion!;
  const { width, height } = getFullFrameLayout(scene.scene).objects[scene.scene.objects[0].id];
  return { fps: sample.plan.fps, width, height, theme: resolvePalette(sample.plan.theme), cues: getMotionCueStates(resolveMotionCues(motion, scene.utterances, sample.plan.fps), sceneFrame) };
}
describe('isolated dynamic teaching components', () => {
  it('draws deterministic frames when seeking backwards', async () => {
    const runtime = await loadCustomRuntime();
    const first = renderCustomFrame(runtime, waveComponentCode, sampleFrame(wave, 30));
    const later = renderCustomFrame(runtime, waveComponentCode, sampleFrame(wave, 90));
    expect(later).not.toBe(first);
    expect(renderCustomFrame(runtime, waveComponentCode, sampleFrame(wave, 30))).toBe(first);
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
    expect(renderCustomFrame(runtime, waveComponentCode, sampleFrame(wave, 30))).toContain('<polyline');
  });
  it('limits guest allocation without leaking state to subsequent frames', async () => {
    const runtime = await loadCustomRuntime();
    expect(() => renderCustomFrame(runtime, 'const data=[]; while(true) data.push(new Array(10000).fill(1));', frame)).toThrow();
    expect(renderCustomFrame(runtime, waveComponentCode, sampleFrame(wave, 30))).toContain('<svg');
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
    expect(componentCatalog).toHaveLength(14);
    for (const sample of componentCatalog) expect(sample.plan).toMatchObject({ layoutVersion: 'full-frame', burnSubtitles: false });
    for (const sample of componentCatalog.filter(item => item.kind === 'creative')) expect(await validateCustomLesson(catalogLesson(sample))).toEqual([]);
    expect(new Set(componentCatalog.map(item => item.plan.scenes[0].scene.layout)).size).toBe(6);
    expect(new Set(componentCatalog.flatMap(item => item.plan.scenes[0].scene.objects.map(object => object.type))).size).toBe(7);
  });
  it('uses the main canvas area for catalog graphics at full-frame and comparison sizes', async () => {
    const runtime = await loadCustomRuntime();
    for (const width of [1280, 632]) for (const sample of componentCatalog.filter(item => ['custom-wave', 'custom-orbit', 'custom-bars'].includes(item.id))) {
      const input = { ...sampleFrame(sample, 120), width, height: 720 };
      const svg = renderCustomFrame(runtime, sample.plan.scenes[0].scene.objects[0].content, input);
      const doc = new DOMParser().parseFromString(svg, 'image/svg+xml');
      const yValues: number[] = [];
      for (const node of Array.from(doc.getElementsByTagName('polyline'))) {
        for (const point of node.getAttribute('points')!.split(' ')) yValues.push(Number(point.split(',')[1]));
      }
      for (const node of Array.from(doc.getElementsByTagName('circle'))) {
        const cy = Number(node.getAttribute('cy')), radius = Number(node.getAttribute('r'));
        yValues.push(cy - radius, cy + radius);
      }
      for (const node of Array.from(doc.getElementsByTagName('rect'))) {
        const y = Number(node.getAttribute('y'));
        yValues.push(y, y + Number(node.getAttribute('height')));
      }
      expect(Math.max(...yValues) - Math.min(...yValues)).toBeGreaterThan(input.height * 0.45);
      expect(Math.min(...yValues)).toBeGreaterThan(0);
      expect(Math.max(...yValues)).toBeLessThan(input.height);
      expect((Math.max(...yValues) + Math.min(...yValues)) / 2).toBeGreaterThan(input.height * 0.4);
      expect((Math.max(...yValues) + Math.min(...yValues)) / 2).toBeLessThan(input.height * 0.65);
    }
  });
  it('binds every creative catalog animation to its demo narration and holds before and after the cue', async () => {
    const runtime = await loadCustomRuntime();
    const examples = componentCatalog.filter(item => ['custom-wave', 'custom-orbit', 'custom-bars'].includes(item.id));
    expect(examples).toHaveLength(3);
    for (const sample of examples) {
      const object = sample.plan.scenes[0].scene.objects[0];
      expect(object.motion).toEqual({ version: 'narration-v1', cues: [{ id: 'demo', utteranceId: 'demo-narration' }] });
      const draw = (sceneFrame: number) => renderCustomFrame(runtime, object.content, sampleFrame(sample, sceneFrame));
      expect(draw(-1)).toBe(draw(0));
      expect(draw(60)).not.toBe(draw(0));
      expect(draw(180)).toBe(draw(360));
    }
  });
  it('keeps the motion studies continuous, cue-gated, seekable, and still at their endings', async () => {
    const runtime = await loadCustomRuntime();
    const examples = componentCatalog.filter(item => item.id.endsWith('-study'));
    expect(examples).toHaveLength(2);
    for (const sample of examples) {
      const graphic = sample.plan.scenes[0].scene.objects[0];
      expect(graphic.motion?.cues).toHaveLength(3);
      expect(sample.plan.totalFrames / sample.plan.fps).toBeGreaterThanOrEqual(8);
      expect(sample.plan.totalFrames / sample.plan.fps).toBeLessThanOrEqual(10);
      const draw = (sceneFrame: number, width = 1280) => renderCustomFrame(runtime, graphic.content, { ...sampleFrame(sample, sceneFrame), width });
      for (const width of [1280, 632]) {
        const early = draw(45, width);
        const middle = draw(135, width);
        const end = draw(288, width);
        expect(early).not.toBe(middle);
        expect(middle).not.toBe(end);
        expect(draw(45, width)).toBe(early);
        expect(draw(-1, width)).toBe(draw(0, width));
        expect(draw(270, width)).toBe(end);
        expect(draw(500, width)).toBe(end);
        const document = new DOMParser().parseFromString(middle, 'image/svg+xml');
        expect(document.documentElement?.getAttribute('viewBox')).toBe(`0 0 ${width} 720`);
        expect(document.getElementsByTagName('polygon').length).toBeGreaterThanOrEqual(7);
      }
      const finalWords = sample.id === 'custom-form-study' ? 'Same parts.' : 'Look';
      expect(draw(191)).not.toContain(finalWords);
      expect(draw(193)).toContain(finalWords);
    }
  });
  it('preserves valid presets and corrects unreadable generated colors', () => {
    for (const preset of stylePresets) expect(resolvePalette(preset.id)).toEqual(preset.palette);
    const result = resolvePalette('sage', { background: '#ffffff', surface: '#ffffff', text: '#eeeeee', muted: '#eeeeee', accent: '#447700' });
    expect(result.text).toBe('#14251c'); expect(result.muted).toBe('#14251c');
  });
});
