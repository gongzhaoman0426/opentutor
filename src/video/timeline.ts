import type { Asset, GenerationSettings, Lesson, RenderPlan, SpeechResult } from '../shared/schema';

export function buildRenderPlan(lesson: Lesson, settings: GenerationSettings, speech: Map<string, SpeechResult>, revision: number): RenderPlan {
  const fps = 30;
  let globalFrame = 0;
  const scenes = lesson.scenes.map(scene => {
    let localFrame = 0;
    const utterances = scene.narration.map(u => {
      const result = speech.get(`${scene.id}:${u.id}`);
      if (!result?.url || !Number.isFinite(result.durationSeconds) || result.durationSeconds <= 0) throw new Error(`场景 ${scene.title} 缺少有效配音：${u.id}`);
      const durationFrames = Math.ceil(result.durationSeconds * fps);
      const clip = { ...result, utteranceId: u.id, startFrame: localFrame, durationFrames };
      localFrame += durationFrames;
      return clip;
    });
    const durationFrames = localFrame;
    const result = { scene, startFrame: globalFrame, durationFrames, utterances };
    globalFrame += durationFrames;
    return result;
  });
  return { schemaVersion: '0.1', revision, title: lesson.title, fps, width: settings.resolution === '1080p' ? 1920 : 1280, height: settings.resolution === '1080p' ? 1080 : 720, theme: settings.theme, ...(lesson.palette ? { palette: lesson.palette } : {}), totalFrames: globalFrame, scenes, previewMode: 'aligned', voice: settings.voice, rate: settings.rate };
}

export function toSrt(plan: RenderPlan): string {
  let index = 0;
  const entries: string[] = [];
  for (const scene of plan.scenes) for (const clip of scene.utterances) {
    const clipStart = (scene.startFrame + clip.startFrame) / plan.fps;
    for (const boundary of clip.boundaries) {
      const start = clipStart + Math.max(0, boundary.startSeconds);
      const end = clipStart + Math.min(clip.durationSeconds, boundary.endSeconds);
      if (!boundary.text.trim() || end <= start) continue;
      entries.push(`${++index}\n${srtTime(start)} --> ${srtTime(end)}\n${boundary.text.replace(/\r?\n/g, ' ')}\n`);
    }
  }
  return entries.join('\n');
}

function srtTime(seconds: number): string {
  const ms = Math.round(seconds * 1000);
  return `${String(Math.floor(ms / 3600000)).padStart(2, '0')}:${String(Math.floor(ms / 60000) % 60).padStart(2, '0')}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')},${String(ms % 1000).padStart(3, '0')}`;
}

export function replaceAssetUrls(plan: RenderPlan, assets: Asset[], resolve: (url: string) => string): { plan: RenderPlan; assets: Asset[] } {
  return { plan: { ...plan, ...(plan.narrationAudio ? { narrationAudio: { ...plan.narrationAudio, url: resolve(plan.narrationAudio.url) } } : {}), scenes: plan.scenes.map(s => ({ ...s, utterances: s.utterances.map(u => ({ ...u, url: resolve(u.url) })) })) }, assets: assets.map(a => ({ ...a, url: resolve(a.url) })) };
}
