import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it, vi } from 'vitest';
import type { RenderPlan } from '../src/shared/schema';

vi.mock('remotion', () => ({
  AbsoluteFill: ({ children, style }: { children: React.ReactNode; style?: React.CSSProperties }) => React.createElement('div', { style }, children),
  Sequence: ({ children, premountFor }: { children: React.ReactNode; premountFor?: number }) => React.createElement('div', { 'data-premount': premountFor }, children),
  Audio: ({ src, pauseWhenBuffering }: { src: string; pauseWhenBuffering?: boolean }) => React.createElement('audio', { src, 'data-buffering': pauseWhenBuffering }),
  Img: ({ src }: { src: string }) => React.createElement('img', { src }),
  useCurrentFrame: () => 0,
  interpolate: () => 0,
}));
import { LessonVideo } from '../src/video/LessonVideo';

const plan: RenderPlan = {
  schemaVersion: '0.1', revision: 1, title: '连续讲解', fps: 30, width: 1280, height: 720, theme: 'sage', totalFrames: 120,
  scenes: [0, 1].map(index => ({
    startFrame: index * 60, durationFrames: 60,
    scene: { id: `s${index}`, title: `步骤 ${index + 1}`, chapter: '讲解', layout: 'content', sourceBlockIds: ['b1'], objects: [{ id: `o${index}`, type: 'text', content: `第${index + 1}步的画面`, language: '' }], narration: [{ id: `u${index}`, text: '讲解', showObjectIds: [`o${index}`], focusObjectId: '' }] },
    utterances: [{ utteranceId: `u${index}`, startFrame: 8, durationFrames: 52, url: `/audio/${index}.wav`, durationSeconds: 52 / 30, hash: `h${index}`, cacheHit: false, boundaries: [] }],
  })),
};

it('plays one continuous narration track instead of also playing its source segments', () => {
  const html = renderToStaticMarkup(React.createElement(LessonVideo, { plan: { ...plan, narrationAudio: { url: '/audio/continuous.wav', durationSeconds: 4 } }, assets: [] }));
  expect(html.match(/<audio\b/g)).toHaveLength(1);
  expect(html).toContain('src="/audio/continuous.wav"');
  expect(html).not.toContain('src="/audio/0.wav"');
  expect(html).toContain('data-buffering="true"');
});

it('keeps old and partial previews audible without playing estimated clips, and shows content at frame zero', () => {
  const partial = structuredClone(plan);
  partial.scenes[1].utterances[0].estimated = true;
  const html = renderToStaticMarkup(React.createElement(LessonVideo, { plan: partial, assets: [] }));
  expect(html.match(/<audio\b/g)).toHaveLength(1);
  expect(html).toContain('src="/audio/0.wav"');
  expect(html).not.toContain('src="/audio/1.wav"');
  expect(html).toContain('第1步的画面');
  expect(html).not.toContain('opacity:0');
  expect(html).toContain('data-premount="30"');
});

it('draws structured preset diagrams and keeps legacy Markdown diagrams readable', () => {
  const preview = structuredClone(plan);
  preview.scenes[0].scene.objects[0] = { id: 'o0', type: 'diagram', language: 'diagram-json', content: JSON.stringify({ nodes: [{ id: 'a', label: '文稿' }, { id: 'b', label: '视频' }], edges: [{ from: 'a', to: 'b', label: '生成' }] }) };
  preview.scenes[1].scene.objects[0] = { id: 'o1', type: 'diagram', language: '', content: '旧版关系 **依然可读**' };
  const html = renderToStaticMarkup(React.createElement(LessonVideo, { plan: preview, assets: [] }));
  expect(html).toContain('data-diagram-node="a"');
  expect(html).toContain('<polyline');
  expect(html).not.toContain('&quot;nodes&quot;');
  expect(html).toContain('旧版关系 <strong>依然可读</strong>');
});
