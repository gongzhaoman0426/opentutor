import { expect, it } from 'vitest';
import { imageGeometry, isNormalizedBox } from '../src/shared/images';
import { validateLesson, type Asset, type Lesson, type SourceDocument } from '../src/shared/schema';

it('places highlight on original pixels, excluding contain letterboxing', () => {
  const geometry = imageGeometry(1000, 300, 800, 400, null, { x: 0.5, y: 0.25, width: 0.25, height: 0.5 });
  expect(geometry).toEqual({ left: 200, top: 0, width: 600, height: 300, image: { width: 600, height: 300, left: -0, top: -0 }, highlight: { left: 300, top: 75, width: 150, height: 150 } });
});

it('crops the source region without distorting it and clips a partially overlapping highlight', () => {
  const geometry = imageGeometry(600, 300, 800, 400, { x: 0.5, y: 0, width: 0.5, height: 1 }, { x: 0.25, y: 0.25, width: 0.5, height: 0.5 });
  expect(geometry.width).toBe(300);
  expect(geometry.left).toBe(150);
  expect(geometry.image.left).toBe(-300);
  expect(geometry.highlight).toEqual({ left: 0, top: 75, width: 150, height: 150 });
  expect(imageGeometry(600, 300, 800, 400, { x: 0.8, y: 0, width: 0.8, height: 1 }).width).toBe(600);
  expect(isNormalizedBox({ x: 0, y: 0, width: Number.NaN, height: 1 })).toBe(false);
});

it('requires each referenced image to be shown alongside narration of its own source block', () => {
  const asset: Asset = { id: 'e471e6bd-f1ed-4616-a4b4-c9da7a6c656d', name: '图.png', mime: 'image/png', hash: 'a', url: '/image' };
  const source: SourceDocument = { title: '课程', hash: 'a', blocks: ['b1', 'b2'].map(id => ({ id, type: 'paragraph', text: '图', markdown: '图', start: 0, end: 1, chapter: '一' })), diagnostics: [], imageOccurrences: ['b1', 'b2'].map(id => ({ id, assetId: asset.id, sourceBlockId: id, chapterId: 'c1', alt: '图', caption: '' })) };
  const lesson: Lesson = { schemaVersion: '0.1', title: '课程', objectives: ['理解图片'], scenes: [{ id: 's1', title: '图', chapter: '一', sourceBlockIds: ['b1'], layout: 'content', objects: [{ id: 'o1', type: 'image', content: asset.id, language: '' }], narration: [{ id: 'u1', text: '观察图中关系。', showObjectIds: ['o1'], focusObjectId: '' }] }] };
  expect(validateLesson(lesson, source, [asset], 'summary').filter(d => d.code === 'UNUSED_SOURCE_IMAGE').map(d => d.sourceBlockId)).toEqual(['b2']);
  lesson.scenes[0].sourceBlockIds.push('b2');
  expect(validateLesson(lesson, source, [asset], 'full').filter(d => d.severity === 'error')).toEqual([]);
  lesson.scenes[0].narration[0].showObjectIds = [];
  expect(validateLesson(lesson, source, [asset], 'full').filter(d => d.code === 'UNUSED_SOURCE_IMAGE')).toHaveLength(2);
});
