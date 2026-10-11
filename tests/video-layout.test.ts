import { describe, expect, it } from 'vitest';
import type { Scene, TeachingObject } from '../src/shared/schema';
import { getFullFrameLayout, isVisualObject } from '../src/shared/video-layout';

function scene(types: TeachingObject['type'][], layout: Scene['layout'] = 'content'): Scene {
  return { id: 'scene', title: 'Title', chapter: '', layout, sourceBlockIds: ['source'], narration: [{ id: 'utterance', text: 'Narration', showObjectIds: ['object0'], focusObjectId: '' }], objects: types.map((type, index) => ({ id: `object${index}`, type, language: type === 'diagram' ? 'diagram-json' : '', content: '' })) };
}
describe('full frame composition geometry', () => {
  it.each(['image', 'custom', 'diagram'] as const)('gives a standalone %s component the entire frame', type => {
    expect(getFullFrameLayout(scene([type]))).toEqual({ title: null, objects: { object0: { x: 0, y: 0, width: 1280, height: 720 } } });
  });
  it('retains Markdown diagrams as readable text rather than bare graphic components', () => {
    const legacy = scene(['diagram']); legacy.objects[0].language = '';
    expect(isVisualObject(legacy.objects[0])).toBe(false);
    expect(getFullFrameLayout(legacy).title).not.toBeNull();
  });
  it('allocates compare components equal columns with no subtitle footer', () => {
    expect(Object.values(getFullFrameLayout(scene(['image', 'custom'], 'compare')).objects)).toEqual([
      { x: 0, y: 0, width: 632, height: 720 }, { x: 648, y: 0, width: 632, height: 720 },
    ]);
  });
  it.each([1, 2, 3, 4, 5, 6, 7, 8])('places %i visual components wholly inside the frame without overlaps', count => {
    const boxes = Object.values(getFullFrameLayout(scene(Array(count).fill('image'))).objects);
    boxes.forEach((box, index) => {
      expect(box.x).toBeGreaterThanOrEqual(0); expect(box.y).toBeGreaterThanOrEqual(0);
      expect(box.width).toBeGreaterThan(0); expect(box.height).toBeGreaterThan(0);
      expect(box.x + box.width).toBeLessThanOrEqual(1280); expect(box.y + box.height).toBeLessThanOrEqual(720);
      for (const other of boxes.slice(index + 1)) expect(box.x + box.width <= other.x || other.x + other.width <= box.x || box.y + box.height <= other.y || other.y + other.height <= box.y).toBe(true);
    });
  });
  it('uses stable slots for objects revealed later in the narration', () => {
    const draft = scene(['image', 'custom']);
    const before = getFullFrameLayout(draft);
    draft.narration.push({ id: 'later', text: 'Later', showObjectIds: ['object1'], focusObjectId: 'object1' });
    expect(getFullFrameLayout(draft)).toEqual(before);
  });
  it.each(['content', 'compare'] as const)('keeps mixed %s text above the subtitle safe area while visuals use more height', layout => {
    const boxes = getFullFrameLayout(scene(['image', 'text'], layout)).objects;
    expect(boxes.object1.y + boxes.object1.height).toBe(624);
    expect(boxes.object0.y + boxes.object0.height).toBeGreaterThan(624);
  });
});
