import type { Diagnostic, Lesson, RenderUtterance } from '../shared/schema';
import { loadCustomRuntime, renderCustomFrame } from '../video/custom-runtime';
import { resolvePalette } from '../shared/visual-style';
import { getMotionCueStates, resolveMotionCues } from '../shared/motion';

export async function validateCustomLesson(lesson: Lesson): Promise<Diagnostic[]> {
  const diagnostics: Diagnostic[] = [];
  const objects = lesson.scenes.flatMap(scene => scene.objects.filter(object => object.type === 'custom').map(object => ({ scene, object })));
  if (!objects.length) return diagnostics;
  const runtime = await loadCustomRuntime();
  for (const { scene, object } of objects) {
    try {
      const geometry = { fps: 30, width: scene.layout === 'compare' ? 520 : 1104, height: 286, theme: resolvePalette('sage', lesson.palette) };
      if (object.motion) {
        // Exercise every declared transition, not only five arbitrary fractions
        // of a scene. Real start times replace these fixtures after synthesis.
        let cursor = 0;
        const utterances: RenderUtterance[] = scene.narration.map((unit, index) => {
          const durationFrames = 97 + (index % 3) * 61;
          const clip = { utteranceId: unit.id, startFrame: cursor, durationFrames, durationSeconds: durationFrames / 30, url: '', hash: '', cacheHit: false, boundaries: [{ kind: 'sentence' as const, text: unit.text, startSeconds: 0.08, endSeconds: durationFrames / 30 }] };
          cursor += durationFrames;
          return clip;
        });
        const resolved = resolveMotionCues(object.motion, utterances, 30);
        const frames = new Set([0, cursor, ...resolved.flatMap(cue => [cue.startFrame - 1, cue.startFrame, cue.startFrame + Math.floor(cue.durationFrames / 2), cue.startFrame + cue.durationFrames])]);
        for (const frame of frames) renderCustomFrame(runtime, object.content, { ...geometry, cues: getMotionCueStates(resolved, frame) });
      } else {
        for (const progress of [0, 0.25, 0.5, 0.75, 1]) renderCustomFrame(runtime, object.content, { ...geometry, frame: Math.round(progress * 300), progress });
      }
    } catch (error) { diagnostics.push({ code: 'CUSTOM_COMPONENT_INVALID', severity: 'error', sceneId: scene.id, message: `自定义组件 ${object.id}：${error instanceof Error ? error.message : '无法执行'}` }); }
  }
  return diagnostics;
}
