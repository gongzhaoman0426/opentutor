import type { Diagnostic, Lesson } from '../shared/schema';
import { loadCustomRuntime, renderCustomFrame } from '../video/custom-runtime';
import { resolvePalette } from '../shared/visual-style';

export async function validateCustomLesson(lesson: Lesson): Promise<Diagnostic[]> {
  const diagnostics: Diagnostic[] = [];
  const objects = lesson.scenes.flatMap(scene => scene.objects.filter(object => object.type === 'custom').map(object => ({ scene, object })));
  if (!objects.length) return diagnostics;
  const runtime = await loadCustomRuntime();
  for (const { scene, object } of objects) {
    try {
      for (const progress of [0, 0.25, 0.5, 0.75, 1]) renderCustomFrame(runtime, object.content, { frame: Math.round(progress * 300), fps: 30, width: scene.layout === 'compare' ? 520 : 1104, height: 286, progress, theme: resolvePalette('sage', lesson.palette) });
    } catch (error) { diagnostics.push({ code: 'CUSTOM_COMPONENT_INVALID', severity: 'error', sceneId: scene.id, message: `自定义组件 ${object.id}：${error instanceof Error ? error.message : '无法执行'}` }); }
  }
  return diagnostics;
}
