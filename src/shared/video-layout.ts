import type { Scene, TeachingObject } from './schema';
import { DIAGRAM_LANGUAGE } from './diagram';

export type FrameBox = { x: number; y: number; width: number; height: number };
export type FullFrameLayout = { title: FrameBox | null; objects: Record<string, FrameBox> };

export function isVisualObject(object: TeachingObject): boolean {
  return object.type === 'image' || object.type === 'custom' || (object.type === 'diagram' && object.language === DIAGRAM_LANGUAGE);
}

function placeGrid(objects: TeachingObject[], bounds: FrameBox, columns: number, target: Record<string, FrameBox>) {
  if (!objects.length) return;
  const rows = Math.ceil(objects.length / columns);
  const gap = 16;
  const height = (bounds.height - (rows - 1) * gap) / rows;
  objects.forEach((object, index) => {
    const row = Math.floor(index / columns);
    const rowColumns = Math.min(columns, objects.length - row * columns);
    const width = (bounds.width - (rowColumns - 1) * gap) / rowColumns;
    target[object.id] = { x: bounds.x + (index % columns) * (width + gap), y: bounds.y + row * (height + gap), width, height };
  });
}

/** Logical video pixels. Use every object, including unrevealed ones, so narration never shifts existing content. */
export function getFullFrameLayout(scene: Scene, width = 1280, height = 720): FullFrameLayout {
  const objects: Record<string, FrameBox> = {};
  const visuals = scene.objects.filter(isVisualObject);
  const text = scene.objects.filter(object => !isVisualObject(object));
  if (!text.length) {
    placeGrid(visuals, { x: 0, y: 0, width, height }, visuals.length > 1 ? 2 : 1, objects);
    return { title: null, objects };
  }
  if (visuals.length && scene.layout !== 'compare') {
    const visualWidth = Math.round(width * 0.64);
    placeGrid(visuals, { x: 0, y: 0, width: visualWidth, height }, visuals.length > 2 ? 2 : 1, objects);
    const x = visualWidth + 24;
    const textWidth = width - x - 32;
    placeGrid(text, { x, y: 128, width: textWidth, height: height - 224 }, 1, objects);
    return { title: { x, y: 32, width: textWidth, height: 76 }, objects };
  }
  const margin = 48;
  const title = { x: margin, y: 36, width: width - margin * 2, height: 76 };
  placeGrid(scene.objects, { x: margin, y: 132, width: width - margin * 2, height: height - (visuals.length ? 164 : 228) }, scene.layout === 'compare' || scene.objects.length > 2 ? 2 : 1, objects);
  // Only text needs a reading safe area; imagery continues behind the subtitle overlay.
  for (const object of text) {
    const box = objects[object.id];
    box.height = Math.min(box.height, height - 96 - box.y);
  }
  return { title, objects };
}
