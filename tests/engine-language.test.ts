import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { compileLesson, regenerateScene, type JsonRunner } from '../src/engine/codex';
import { defaultSettings, type Asset, type GenerationSettings, type Lesson, type SpeechResult } from '../src/shared/schema';
import { parseSource } from '../src/shared/source';
import { buildRenderPlan, toSrt } from '../src/video/timeline';

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true }))); });
type Payload = { settings: GenerationSettings; sourceBlocks: { id: string }[]; chapterContext: { id: string; title: string }; chapters: { id: string; title: string }[]; currentScene: Lesson['scenes'][number] };
const payload = (prompt: string, marker = 'VIDEO_DATA='): Payload => JSON.parse(prompt.split(marker)[1].split('\nREPAIR_ERRORS=')[0]);
const image: Asset = { id: '00000000-0000-4000-8000-000000000031', name: '原始界面.png', mime: 'image/png', url: '/api/artifacts/00000000-0000-4000-8000-000000000031', hash: 'original-pixels' };
const code = 'print("Hello")';
const wording = {
  'en-US': { title: 'A greeting', chapter: 'Output', goal: 'Show the greeting', body: 'The program prints Hello.', label: 'Greeting', caption: 'The original interface', speech: 'The program prints the word Hello.' },
  'fr-FR': { title: 'Une salutation', chapter: 'Affichage', goal: 'Présenter une salutation', body: 'Le programme affiche Hello.', label: 'Salutation', caption: 'Interface originale', speech: 'Le programme affiche le mot Hello.' },
  'ja-JP': { title: 'あいさつ', chapter: '出力', goal: 'あいさつの表示', body: 'プログラムは Hello を表示します。', label: 'あいさつ', caption: '元の画面', speech: 'プログラムは Hello という語を表示します。' },
};
type Locale = keyof typeof wording;
function output(data: Payload, locale: Locale, withMaterials = false): Lesson {
  const text = wording[locale];
  const objects: Lesson['scenes'][number]['objects'] = [{ id: 'body', type: 'text', content: text.body, language: '' }];
  if (withMaterials) objects.push(
    { id: 'program', type: 'code', content: code, language: 'python' },
    { id: 'relationship', type: 'diagram', content: JSON.stringify({ nodes: [{ id: 'greeting', label: text.label }], edges: [] }), language: 'diagram-json' },
    { id: 'source-image', type: 'image', content: image.id, language: '', imagePresentation: { fit: 'contain', caption: text.caption, region: null, highlight: null } },
  );
  return { schemaVersion: '0.1', title: text.title, objectives: [text.goal], scenes: objects.map(object => ({ id: `scene-${object.id}`, chapterId: 'model-attempted-renaming', chapter: text.chapter, title: text.title, sourceBlockIds: data.sourceBlocks.map(block => block.id), layout: 'content', objects: [object], narration: [{ id: 'spoken-greeting', text: text.speech, showObjectIds: [object.id], focusObjectId: object.id }] })) };
}
function expectLanguageContract(prompt: string, locale: string) {
  expect(prompt).toContain(`TARGET VIDEO LANGUAGE: "${locale}"`);
  expect(prompt).toContain('visible SVG text, image captions and spoken narration');
  expect(prompt).toContain('Preserve original wording when exact quotations');
  expect(prompt).toContain('do not translate executable code');
  expect(prompt).toContain('object.language is a code syntax or component format identifier');
  expect(prompt).not.toContain('Unspecified language is empty');
}

describe('target video language across generation stages', () => {
  it.each(['en-US', 'fr-FR', 'ja-JP'] as const)('retains %s display text and subtitles without translating source associations, code or images', async locale => {
    const chapter = { id: 'source-chapter', title: '原始章节：输出', markdown: `程序输出一声问候。\n\n\`\`\`python\n${code}\n\`\`\`\n\n![原始界面](asset://${image.id})` };
    const source = parseSource('', [image], [chapter]); const original = structuredClone(source);
    const settings = { ...defaultSettings, language: locale };
    const partials: Lesson[] = [];
    const result = await compileLesson(chapter.markdown, settings, [image], { source, lessonTitle: chapter.title, onLesson: lesson => { partials.push(lesson); }, analyzeImages: async () => ({ analyses: [], attachments: [], diagnostics: [] }), runner: async prompt => {
      expectLanguageContract(prompt, locale);
      const data = payload(prompt);
      expect(data.chapterContext.title).toBe(chapter.title);
      expect(data.settings.language).toBe(locale);
      return JSON.stringify(output(data, locale, true));
    } });
    const text = wording[locale]; const lesson = result.lesson;
    expect(lesson.title).toBe(text.title); expect(lesson.objectives).toEqual([text.goal]);
    expect(partials.map(partial => partial.title)).toEqual([text.title]);
    expect(lesson.scenes.every(scene => scene.chapter === text.chapter && scene.chapterId === chapter.id && scene.title === text.title)).toBe(true);
    expect(lesson.scenes[0].objects[0].content).toBe(text.body);
    expect(lesson.scenes[1].objects[0]).toMatchObject({ id: 'program', content: code, language: 'python' });
    expect(JSON.parse(lesson.scenes[2].objects[0].content)).toEqual({ nodes: [{ id: 'greeting', label: text.label }], edges: [] });
    expect(lesson.scenes[3].objects[0]).toMatchObject({ id: 'source-image', content: image.id, imagePresentation: { caption: text.caption } });
    expect(lesson.scenes.every(scene => scene.narration[0].id === 'spoken-greeting' && scene.narration[0].text === text.speech)).toBe(true);
    expect(new Set(lesson.scenes.flatMap(scene => scene.sourceBlockIds))).toEqual(new Set(source.blocks.map(block => block.id)));
    expect(source).toEqual(original);
    const speech = new Map<string, SpeechResult>(lesson.scenes.map(scene => [`${scene.id}:spoken-greeting`, { url: '/audio.mp3', durationSeconds: 2, boundaries: [{ kind: 'sentence', startSeconds: 0, endSeconds: 2, text: text.speech }], cacheHit: false, hash: scene.id }]));
    const plan = buildRenderPlan(lesson, settings, speech, 1);
    expect(plan.title).toBe(text.title); expect(toSrt(plan)).toContain(text.speech);
  });

  it('keeps target language through overview, repair, cached batches and single-scene regeneration', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'opentutor-language-')); directories.push(directory);
    const chapters = [{ id: 'first', title: '原始章节一', markdown: '程序输出问候。' }, { id: 'second', title: '原始章节二', markdown: '再次显示问候。' }];
    const source = parseSource('', [], chapters); const original = structuredClone(source);
    let calls = 0; const repairPrompts: string[] = []; const overviews: string[] = [];
    const runner: JsonRunner = async prompt => {
      calls++;
      if (prompt.includes('PROJECT_DATA=')) {
        const data = payload(prompt, 'PROJECT_DATA='); const locale = data.settings.language as Locale; overviews.push(locale);
        expect(prompt).toContain(`TARGET VIDEO LANGUAGE: "${locale}"`);
        return JSON.stringify({ summary: wording[locale].body, objectives: [wording[locale].goal], chapters: data.chapters.map(chapter => ({ id: chapter.id, title: wording[locale].chapter, summary: wording[locale].body })) });
      }
      const data = payload(prompt); const locale = data.settings.language as Locale; expectLanguageContract(prompt, locale);
      const result = output(data, locale);
      if (prompt.includes('REPAIR_ERRORS=')) repairPrompts.push(prompt);
      if (calls === 2) result.scenes[0].sourceBlockIds = ['translated-source-id'];
      return JSON.stringify(result);
    };
    const run = (locale: Locale) => compileLesson('', { ...defaultSettings, language: locale }, [], { source, courseTitle: '原始项目', ownerProjectId: 'language-cache', cacheDirectory: () => directory, runner });
    const french = await run('fr-FR'); expect(calls).toBe(4); expect(repairPrompts).toHaveLength(1);
    expect(french.lesson.title).toBe(wording['fr-FR'].title);
    expect(french.lesson.scenes.map(scene => scene.chapterId)).toEqual(['first', 'second']);
    expect(french.lesson.scenes.map(scene => scene.chapter)).toEqual([wording['fr-FR'].chapter, wording['fr-FR'].chapter]);
    const cached = await run('fr-FR'); expect(calls).toBe(4); expect(cached.lesson).toEqual(french.lesson);
    const japanese = await run('ja-JP'); expect(calls).toBe(7); expect(overviews).toEqual(['fr-FR', 'ja-JP']);
    expect(japanese.lesson.title).toBe(wording['ja-JP'].title);
    let regenerationCalls = 0;
    const regenerated = await regenerateScene(french.lesson, french.lesson.scenes[0].id, '缩短表达', source, { ...defaultSettings, language: 'fr-FR' }, [], { runner: async prompt => {
      regenerationCalls++; expectLanguageContract(prompt, 'fr-FR');
      if (regenerationCalls === 2) expect(prompt).toContain('REPAIR_ERRORS=');
      const scene = structuredClone(payload(prompt).currentScene);
      scene.chapterId = 'translated-id'; scene.chapter = 'Une autre formulation'; scene.title = 'Bonjour';
      if (regenerationCalls === 1) scene.narration[0].showObjectIds = ['incorrect-target'];
      return JSON.stringify(scene);
    } });
    expect(regenerationCalls).toBe(2);
    expect(regenerated.lesson.scenes[0]).toMatchObject({ id: french.lesson.scenes[0].id, chapterId: 'first', chapter: 'Une autre formulation', title: 'Bonjour' });
    expect(regenerated.lesson.scenes[1]).toEqual(french.lesson.scenes[1]);
    expect(regenerated.lesson.title).toBe(wording['fr-FR'].title); expect(source).toEqual(original);
  });

  it('keeps localized SVG text and original motion/reference IDs when merging creative output', async () => {
    const chapter = { id: 'source-chapter', title: '原始标题', markdown: '展示问候语。' }; const source = parseSource('', [], [chapter]);
    const settings = { ...defaultSettings, language: 'ja-JP', creationMode: 'creative' as const };
    const svgCode = 'const visible = cues.greeting.started; return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1104 286"><text x="50" y="100" opacity="${visible ? 1 : 0}">こんにちは</text></svg>`;';
    const result = await compileLesson(chapter.markdown, settings, [], { source, runner: async prompt => {
      expectLanguageContract(prompt, 'ja-JP'); const lesson = output(payload(prompt), 'ja-JP');
      lesson.scenes[0].objects = [{ id: 'body', type: 'custom', language: 'javascript', content: svgCode, motion: { version: 'narration-v1', cues: [{ id: 'greeting', utteranceId: 'spoken-greeting' }] } }];
      return JSON.stringify(lesson);
    } });
    const scene = result.lesson.scenes[0]; expect(scene.id).toMatch(/^part/);
    expect(scene.objects[0]).toMatchObject({ id: 'body', language: 'javascript', content: svgCode, motion: { cues: [{ id: 'greeting', utteranceId: 'spoken-greeting' }] } });
    expect(scene.narration[0]).toMatchObject({ id: 'spoken-greeting', showObjectIds: ['body'] });
  });
});
