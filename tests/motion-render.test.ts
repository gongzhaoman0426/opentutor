import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { DOMParser } from '@xmldom/xmldom';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { MotionCueState } from '../src/shared/motion';
import type { RenderPlan } from '../src/shared/schema';

const clock = vi.hoisted(() => ({ globalFrame: 200, runtime: null as unknown }));
vi.mock('react', async importOriginal => {
  const actual = await importOriginal<typeof import('react')>();
  // Server rendering does not run the WASM-loading effect. Seed its ready state,
  // retaining the real hooks, CustomGraphic component and isolated SVG runtime.
  const useState = ((initial: unknown) => actual.useState(initial === null ? clock.runtime : initial)) as typeof actual.useState;
  return { ...actual, default: { ...actual, useState } };
});
vi.mock('remotion', async () => {
  const react = await import('react');
  const offset = react.createContext(0);
  return {
    AbsoluteFill: ({ children, style }: { children: React.ReactNode; style?: React.CSSProperties }) => react.createElement('div', { style }, children),
    Sequence: ({ children, from = 0 }: { children: React.ReactNode; from?: number }) => react.createElement(offset.Provider, { value: react.useContext(offset) + from }, children),
    Audio: ({ src, pauseWhenBuffering }: { src: string; pauseWhenBuffering?: boolean }) => react.createElement('audio', { src, 'data-buffering': pauseWhenBuffering }),
    Img: ({ src }: { src: string }) => react.createElement('img', { src }),
    useCurrentFrame: () => clock.globalFrame - react.useContext(offset),
    interpolate: () => 0,
    delayRender: () => 1,
    continueRender: vi.fn(),
    cancelRender: vi.fn(),
    getRemotionEnvironment: () => ({ isRendering: false }),
  };
});

import { LessonVideo } from '../src/video/LessonVideo';
import { loadCustomRuntime } from '../src/video/custom-runtime';

beforeAll(async () => { clock.runtime = await loadCustomRuntime(); });
const modernCode = `if ('frame' in input || 'progress' in input) throw new Error('scene clock leaked into narration API');
return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 '+width+' '+height+'"><text x="10" y="30">'+JSON.stringify({apply:cues.apply,confirm:cues.confirm})+'</text></svg>';`;
const legacyCode = `if (typeof cues !== 'undefined') throw new Error('legacy API changed');
return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 '+width+' '+height+'"><text x="10" y="30">'+JSON.stringify({frame,progress})+'</text></svg>';`;

function fixture(): RenderPlan {
  const narration = ['intro', 'apply', 'confirm'].map((id, index) => ({ id, text: `步骤${index}`, showObjectIds: index ? ['modern', 'legacy'] : [], focusObjectId: index ? 'modern' : '' }));
  return {
    schemaVersion: '0.1', revision: 1, title: '旁白动作测试', fps: 10, width: 1280, height: 720, theme: 'sage', totalFrames: 360, previewMode: 'aligned',
    narrationAudio: { url: '/audio/master.wav', durationSeconds: 36 },
    scenes: [{ startFrame: 200, durationFrames: 160, scene: {
      id: 'scene', title: '名称重新绑定', chapter: '示例', layout: 'compare', sourceBlockIds: ['block'], narration,
      objects: [
        { id: 'modern', type: 'custom', language: 'javascript', content: modernCode, motion: { version: 'narration-v1', cues: [{ id: 'apply', utteranceId: 'apply' }, { id: 'confirm', utteranceId: 'confirm' }] } },
        { id: 'legacy', type: 'custom', language: 'javascript', content: legacyCode },
      ],
    }, utterances: [
      { utteranceId: 'intro', startFrame: 10, durationFrames: 30, durationSeconds: 3, boundaries: [], hash: 'intro', cacheHit: false, url: '/audio/intro.wav' },
      { utteranceId: 'apply', startFrame: 50, durationFrames: 40, durationSeconds: 4, boundaries: [{ kind: 'word', text: '步骤', startSeconds: 0.4, endSeconds: 1 }], hash: 'apply', cacheHit: false, url: '/audio/apply.wav' },
      { utteranceId: 'confirm', startFrame: 110, durationFrames: 20, durationSeconds: 2, boundaries: [{ kind: 'sentence', text: '步骤', startSeconds: 0.2, endSeconds: 1.8 }], hash: 'confirm', cacheHit: false, url: '/audio/confirm.wav' },
    ] }],
  };
}

function renderAt(plan: RenderPlan, sceneFrame: number) {
  clock.globalFrame = plan.scenes[0].startFrame + sceneFrame;
  const html = renderToStaticMarkup(React.createElement(LessonVideo, { plan, assets: [] }));
  expect(html).not.toContain('role="alert"');
  const svgs = html.match(/<svg\b[\s\S]*?<\/svg>/g) ?? [];
  const states = svgs.map(svg => JSON.parse(new DOMParser().parseFromString(svg, 'image/svg+xml').getElementsByTagName('text')[0].textContent ?? '{}'));
  return { html, modern: states[0] as Record<string, MotionCueState>, legacy: states[1] as { frame: number; progress: number } };
}

describe('narration clocks in the shared preview/export video component', () => {
  it('passes each full-frame slot to custom SVGs while preserving original geometry for saved plans', () => {
    const original = fixture();
    expect(renderAt(original, 64).html.match(/viewBox="0 0 520 286"/g)).toHaveLength(2);
    const full = fixture(); full.layoutVersion = 'full-frame';
    expect(renderAt(full, 64).html.match(/viewBox="0 0 632 720"/g)).toHaveLength(2);
    full.scenes[0].scene.objects = [full.scenes[0].scene.objects[0]];
    expect(renderAt(full, 64).html).toContain('viewBox="0 0 1280 720"');
  });
  it('uses scene-local speech cues for new SVGs and object-local time for existing SVGs', () => {
    const { modern, legacy } = renderAt(fixture(), 64);
    expect(modern.apply).toEqual({ started: true, active: true, completed: false, frame: 10, durationFrames: 36, progress: 10 / 36 });
    expect(modern.confirm).toEqual({ started: false, active: false, completed: false, frame: 0, durationFrames: 18, progress: 0 });
    expect(legacy.frame).toBe(14);
    expect(legacy.progress).toBe(14 / 109);
  });
  it('does not reveal the next action during silence and produces the same state after arbitrary seeking', () => {
    const plan = fixture();
    const earlier = renderAt(plan, 64).modern;
    const pause = renderAt(plan, 105).modern;
    expect(pause.apply.completed).toBe(true);
    expect(pause.confirm.started).toBe(false);
    const later = renderAt(plan, 130).modern;
    expect(later.apply.progress).toBe(1); expect(later.confirm.progress).toBe(1);
    expect(renderAt(plan, 64).modern).toEqual(earlier);
    expect(renderAt(plan, 112).modern.confirm).toMatchObject({ started: true, active: true, completed: false, frame: 0, progress: 0 });
  });
  it('re-resolves draft estimates against actual TTS boundaries without changing the continuous audio path', () => {
    const real = fixture(); const draft = structuredClone(real); draft.previewMode = 'draft';
    for (const clip of draft.scenes[0].utterances) { clip.estimated = true; clip.url = ''; }
    const draftFrame = renderAt(draft, 52);
    const realFrame = renderAt(real, 52);
    expect(draftFrame.modern.apply).toMatchObject({ started: true, frame: 2, durationFrames: 40 });
    expect(realFrame.modern.apply).toMatchObject({ started: false, frame: 0, durationFrames: 36 });
    expect(realFrame.html.match(/<audio\b/g)).toHaveLength(1);
    expect(realFrame.html).toContain('src="/audio/master.wav"');
    expect(realFrame.html).not.toContain('src="/audio/apply.wav"');
  });
  it('adapts to changed speech duration and scene length using utterance identities rather than scene percentages', () => {
    const plan = fixture(); const scene = plan.scenes[0];
    scene.durationFrames = 240; plan.totalFrames = 440; plan.narrationAudio!.durationSeconds = 44;
    Object.assign(scene.utterances[1], { startFrame: 80, durationFrames: 80, durationSeconds: 8 });
    scene.utterances[2].startFrame = 180;
    const rendered = renderAt(plan, 110);
    expect(rendered.modern.apply).toMatchObject({ started: true, frame: 26, durationFrames: 76, progress: 26 / 76 });
    expect(rendered.modern.confirm.started).toBe(false);
    expect(rendered.legacy.frame).toBe(30);
    expect(rendered.legacy.progress).toBe(30 / 159);
  });
  it('keeps null motion on the original API and still plays source clips when no master track exists', () => {
    const plan = fixture(); plan.narrationAudio = undefined;
    plan.scenes[0].scene.objects[1].motion = null;
    const rendered = renderAt(plan, 120);
    expect(rendered.legacy.frame).toBe(70);
    expect(rendered.html.match(/<audio\b/g)).toHaveLength(3);
    expect(rendered.html).not.toContain('/audio/master.wav');
  });
});
