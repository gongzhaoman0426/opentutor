import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import { toString } from 'mdast-util-to-string';
import type { Root, Nodes } from 'mdast';
import type { Asset, Chapter, GenerationSettings, Lesson, RenderPlan, Scene, SpeechResult } from '../shared/schema';

/** A read-only source storyboard, never a substitute for the generated video IR. */
export function buildDraftLesson(markdown: string, title: string, assets: Asset[] = [], chapters?: Chapter[]): Lesson {
  if (chapters?.some(chapter => chapter.markdown.trim())) {
    const scenes = chapters.filter(chapter => chapter.markdown.trim()).flatMap((chapter, index) => buildDraftLesson(chapter.markdown, chapter.title, assets).scenes.map(scene => {
      const prefix = `c${index}-`;
      return { ...scene, id: `draft-${prefix}${scene.id}`, chapter: chapter.title, chapterId: chapter.id, objects: scene.objects.map(object => ({ ...object, id: prefix + object.id })), narration: scene.narration.map(utterance => ({ ...utterance, id: prefix + utterance.id, showObjectIds: utterance.showObjectIds.map(id => prefix + id), focusObjectId: utterance.focusObjectId ? prefix + utterance.focusObjectId : '' })) };
    }));
    return { schemaVersion: '0.1', title, objectives: ['原稿分镜预览；点击生成视频后自动编排与配音'], scenes };
  }
  const document = unified().use(remarkParse).use(remarkGfm).use(remarkMath).parse(markdown) as Root;
  const definitions = new Map(document.children.filter(node => node.type === 'definition').map(node => [node.identifier.toLowerCase(), node.url]));
  let chapter = title || '文稿草稿';
  const scenes: Scene[] = [];
  for (const [index, node] of document.children.entries()) {
    if (node.type === 'heading') { chapter = toString(node).slice(0, 80); continue; }
    if (node.type === 'definition') continue;
    const raw = markdown.slice(node.position?.start.offset ?? 0, node.position?.end.offset ?? 0);
    const kind = node.type === 'code' ? 'code' : node.type === 'math' ? 'formula' : node.type === 'table' ? 'table' : 'text';
    const images: { asset: Asset; alt: string }[] = [];
    const visit = (child: Nodes) => {
      const url = child.type === 'image' ? child.url : child.type === 'imageReference' ? definitions.get(child.identifier.toLowerCase()) : null;
      if (url) {
        const normalized = url.replace(/^\.\//, '');
        const matches = assets.filter(asset => url === `asset://${asset.id}` || url === asset.url || url === asset.id || normalized === asset.name);
        if (matches.length === 1) images.push({ asset: matches[0], alt: 'alt' in child ? child.alt || '' : '' });
      }
      if ('children' in child) child.children.forEach(visit);
    };
    visit(node);
    images.forEach(({ asset, alt }, imageIndex) => {
      const sceneId = `draft-${index}-image-${imageIndex}`;
      scenes.push({ id: sceneId, title: chapter, chapter, layout: 'content', sourceBlockIds: [`draft-source-${index}`], objects: [{ id: `${sceneId}-object`, type: 'image', content: asset.id, language: '', imagePresentation: { fit: 'contain', caption: alt, region: null, highlight: null } }], narration: [{ id: `${sceneId}-narration`, text: alt || asset.name, showObjectIds: [`${sceneId}-object`], focusObjectId: '' }] });
    });
    if (images.length && node.type === 'paragraph' && node.children.every(child => child.type === 'image' || child.type === 'imageReference' || child.type === 'text' && !child.value.trim())) continue;
    const body = node.type === 'code' || node.type === 'math' ? node.value : images.length ? toString(node) : raw;
    const fragments = kind === 'formula' ? [body] : splitDraftText(body, kind === 'code' ? 8 : 6);
    for (const [part, content] of fragments.entries()) {
      const sceneId = `draft-${index}-${part}`;
      scenes.push({
        id: sceneId, title: chapter, chapter, layout: kind === 'code' ? 'code' : 'content',
        sourceBlockIds: [`draft-source-${index}`],
        objects: [{ id: `${sceneId}-object`, type: kind, content, language: node.type === 'code' ? node.lang ?? '' : '' }],
        narration: [{ id: `${sceneId}-narration`, text: content.slice(0, 400) || chapter, showObjectIds: [`${sceneId}-object`], focusObjectId: '' }],
      });
    }
  }
  if (!scenes.length) scenes.push({ id: 'draft-intro', title: chapter || '开始制作视频', chapter: '文稿草稿', layout: 'title', sourceBlockIds: ['draft-source-empty'], objects: [{ id: 'draft-intro-text', type: 'text', content: markdown.trim() ? '继续补充章节正文，点击生成视频后自动编排与配音。' : '导入 Markdown 文件或输入文稿。画面预览会立即更新。', language: '' }], narration: [{ id: 'draft-intro-narration', text: '写好文稿后，点击生成视频。', showObjectIds: ['draft-intro-text'], focusObjectId: '' }] });
  return { schemaVersion: '0.1', title: title || chapter || '文稿草稿', objectives: ['原稿分镜预览；正式分镜编排由中间表示生成步骤完成'], scenes };
}

function splitDraftText(text: string, linesPerCard: number): string[] {
  const fragments: string[] = [];
  let current = '';
  let units = 0;
  let lines = 1;
  for (const char of text) {
    const nextUnits = units + (/[^\x00-\x7F]/.test(char) ? 1 : 0.55);
    if (current && (nextUnits > 165 || (char === '\n' && lines >= linesPerCard))) {
      fragments.push(current); current = ''; units = 0; lines = 1;
    }
    current += char; units += /[^\x00-\x7F]/.test(char) ? 1 : 0.55;
    if (char === '\n') lines++;
  }
  if (current.trim()) fragments.push(current.trim());
  return fragments.length ? fragments : [text];
}

/** Missing speech uses explicitly estimated, silent timing for the interactive preview only. */
export function buildPreviewPlan(lesson: Lesson, settings: GenerationSettings, revision: number, audioPlan?: RenderPlan | null, speech: Map<string, SpeechResult> = new Map()): RenderPlan {
  const fps = 30;
  const matchingVoice = audioPlan?.voice === settings.voice && audioPlan?.rate === settings.rate;
  let startFrame = 0;
  let ready = 0;
  let pending = 0;
  const scenes = lesson.scenes.map(scene => {
    const oldScene = matchingVoice ? audioPlan?.scenes.find(s => s.scene.id === scene.id) : undefined;
    let localFrame = 0;
    const utterances = scene.narration.map(utterance => {
      const oldText = oldScene?.scene.narration.find(u => u.id === utterance.id)?.text;
      const oldAudio = oldText === utterance.text ? oldScene?.utterances.find(u => u.utteranceId === utterance.id && !u.estimated && u.url) : undefined;
      const candidate = speech.get(`${scene.id}:${utterance.id}`) ?? oldAudio;
      const audio = candidate?.url && Number.isFinite(candidate.durationSeconds) && candidate.durationSeconds > 0 ? candidate : undefined;
      const durationSeconds = audio?.durationSeconds ?? Math.max(3, Math.min(90, [...utterance.text].length / (settings.language === 'zh-CN' ? 4.3 : 12)));
      const durationFrames = Math.ceil(durationSeconds * fps);
      if (audio) ready++; else pending++;
      const clip = { ...(audio ?? { url: '', durationSeconds, boundaries: [{ kind: 'utterance' as const, text: utterance.text, startSeconds: 0, endSeconds: durationSeconds }], hash: '', cacheHit: false }), utteranceId: utterance.id, startFrame: localFrame, durationFrames, estimated: !audio };
      localFrame += durationFrames;
      return clip;
    });
    const rendered = { scene, startFrame, durationFrames: localFrame, utterances };
    startFrame += rendered.durationFrames;
    return rendered;
  });
  // Visual edits can reuse a track. Reordered speech or changed audio/timing cannot.
  const sameAudioTimeline = matchingVoice && !pending && audioPlan?.totalFrames === startFrame && audioPlan.fps === fps && audioPlan.scenes.length === scenes.length && scenes.every((scene, i) => {
    const previous = audioPlan.scenes[i];
    return previous.scene.id === scene.scene.id && previous.startFrame === scene.startFrame && previous.durationFrames === scene.durationFrames && previous.utterances.length === scene.utterances.length && scene.utterances.every((clip, j) => {
      const old = previous.utterances[j];
      return old.utteranceId === clip.utteranceId && old.url === clip.url && old.hash === clip.hash && old.startFrame === clip.startFrame && old.durationFrames === clip.durationFrames && old.durationSeconds === clip.durationSeconds;
    });
  });
  return { schemaVersion: '0.1', revision, title: lesson.title, fps, width: settings.resolution === '1080p' ? 1920 : 1280, height: settings.resolution === '1080p' ? 1080 : 720, theme: settings.theme, ...(lesson.palette ? { palette: lesson.palette } : {}), totalFrames: Math.max(1, startFrame), scenes, voice: settings.voice, rate: settings.rate, previewMode: pending ? ready ? 'partial' : 'draft' : 'aligned', ...(sameAudioTimeline && audioPlan?.narrationAudio ? { narrationAudio: audioPlan.narrationAudio } : {}) };
}
