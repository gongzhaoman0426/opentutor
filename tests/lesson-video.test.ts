import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it, vi } from 'vitest';
import type { Asset, RenderPlan, TeachingObject } from '../src/shared/schema';
import { DOMParser } from '@xmldom/xmldom';

vi.mock('remotion', () => ({
  AbsoluteFill: ({ children, style }: { children: React.ReactNode; style?: React.CSSProperties }) => React.createElement('div', { style }, children),
  Sequence: ({ children, premountFor }: { children: React.ReactNode; premountFor?: number }) => React.createElement('div', { 'data-premount': premountFor }, children),
  Audio: ({ src, pauseWhenBuffering }: { src: string; pauseWhenBuffering?: boolean }) => React.createElement('audio', { src, 'data-buffering': pauseWhenBuffering }),
  Img: ({ src, style, alt }: { src: string; style?: React.CSSProperties; alt?: string }) => React.createElement('img', { src, style, alt }),
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

const asset: Asset = { id: '11111111-1111-4111-8111-111111111111', name: 'Transparent screenshot.png', mime: 'image/png', url: '/image.png', hash: 'image', width: 1280, height: 720 };
function imagePlan(): RenderPlan {
  const preview = structuredClone(plan);
  preview.layoutVersion = 'full-frame';
  preview.scenes = [preview.scenes[0]];
  preview.scenes[0].scene.objects[0] = { id: 'o0', type: 'image', content: asset.id, language: '' };
  preview.scenes[0].utterances[0].startFrame = 0;
  preview.scenes[0].utterances[0].boundaries = [{ kind: 'sentence', text: 'A readable subtitle', startSeconds: 0, endSeconds: 1 }];
  return preview;
}
function elements(html: string, attribute: string) {
  const document = new DOMParser().parseFromString(`<root>${html}</root>`, 'application/xml');
  return Array.from(document.getElementsByTagName('*')).filter(element => element.hasAttribute(attribute));
}
function renderImage(preview = imagePlan(), image = asset, showSubtitles?: boolean) {
  return renderToStaticMarkup(React.createElement(LessonVideo, { plan: preview, assets: [image], showSubtitles }));
}

it('uses the whole video for a single image, with no opaque card or title reducing its area', () => {
  const html = renderImage();
  expect(elements(html, 'data-video-object')[0].getAttribute('style')).toBe('position:absolute;left:0;top:0;width:1280px;height:720px');
  const card = elements(html, 'data-video-card')[0].getAttribute('style');
  expect(card).toContain('padding:0;border-radius:0');
  expect(card).not.toMatch(/(?:^|;)(?:background|border|box-shadow|transform):/);
  expect(elements(html, 'data-image-viewport')[0].getAttribute('style')).toContain('width:1280px;max-width:100%;height:720px');
  expect(elements(html, 'data-image-crop')[0].getAttribute('style')).toContain('left:0;top:0;width:1280px;height:720px');
  expect(html).not.toContain('OPEN TUTOR');
  expect(html).not.toContain('<h1');
});

it('contains portrait pixels without stretching or cutting them off and scales correctly for 1080p', () => {
  const preview = imagePlan(); preview.width = 1920; preview.height = 1080;
  const html = renderImage(preview, { ...asset, width: 800, height: 1200 });
  expect(elements(html, 'data-video-object')[0].getAttribute('style')).toContain('width:1920px;height:1080px');
  expect(elements(html, 'data-image-crop')[0].getAttribute('style')).toContain('left:600px;top:0;width:720px;height:1080px');
});

it('keeps region and highlight coordinates tied to original pixels at full frame size', () => {
  const preview = imagePlan();
  preview.scenes[0].scene.objects[0].imagePresentation = { fit: 'contain', caption: 'Detail', region: { x: 0.5, y: 0, width: 0.5, height: 1 }, highlight: { x: 0.25, y: 0.25, width: 0.5, height: 0.5 } };
  const html = renderImage(preview, { ...asset, width: 800, height: 400 });
  expect(elements(html, 'data-image-crop')[0].getAttribute('style')).toContain('left:280px;top:0;width:720px;height:720px');
  expect(elements(html, 'data-image-highlight')[0].getAttribute('style')).toContain('left:0;top:180px;width:360px;height:360px');
  expect(html).toContain('width:1440px;height:720px;left:-720px');
  expect(html).toContain('<figcaption style="position:absolute');
  expect(elements(html, 'data-image-viewport')[0].getAttribute('style')).toContain('height:720px');
});

it('overlays subtitles without changing image size and supports both stored and explicit subtitle switches', () => {
  const preview = imagePlan();
  const enabled = renderImage(preview);
  const overlay = elements(enabled, 'data-video-subtitles')[0];
  expect(overlay.getAttribute('data-video-subtitles')).toBe('overlay');
  expect(overlay.getAttribute('style')).toContain('position:absolute');
  expect(overlay.getAttribute('style')).toContain('z-index:20');
  expect(enabled).toContain('A readable subtitle');
  preview.burnSubtitles = false;
  const disabled = renderImage(preview);
  expect(elements(disabled, 'data-video-subtitles')).toHaveLength(0);
  expect(elements(disabled, 'data-image-viewport')[0].getAttribute('style')).toBe(elements(enabled, 'data-image-viewport')[0].getAttribute('style'));
  expect(renderImage(preview, asset, true)).toContain('A readable subtitle');
  preview.burnSubtitles = true;
  expect(renderImage(preview, asset, false)).not.toContain('A readable subtitle');
});

it('retains the original layout and image sizes for previously saved render plans', () => {
  const preview = imagePlan(); delete preview.layoutVersion;
  const html = renderImage(preview);
  expect(html).toContain('OPEN TUTOR');
  expect(html).toContain('<h1');
  expect(elements(html, 'data-video-card')[0].getAttribute('style')).toContain('background:');
  expect(elements(html, 'data-image-viewport')[0].getAttribute('style')).toContain('width:1104px;max-width:100%;height:290px');
  expect(elements(html, 'data-video-subtitles')[0].getAttribute('data-video-subtitles')).toBe('footer');
});

it('keeps supporting text and scene titles beside the image while reserving subtitle reading space', () => {
  const preview = imagePlan();
  const text: TeachingObject = { id: 'detail', type: 'text', content: '## What changed\n\nReadable supporting detail.', language: '' };
  preview.scenes[0].scene.objects.push(text);
  preview.scenes[0].scene.narration[0].showObjectIds.push(text.id);
  const html = renderImage(preview);
  expect(html).toContain('<h1');
  expect(html).toContain('Readable supporting detail.');
  const objects = elements(html, 'data-video-object');
  expect(objects[0].getAttribute('style')).toContain('width:819px;height:720px');
  expect(objects[1].getAttribute('style')).toContain('top:128px;width:405px;height:496px');
});
