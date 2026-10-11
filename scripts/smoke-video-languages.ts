/**
 * Real Chinese-source -> English/Japanese video generation and Microsoft TTS.
 * No projects/jobs or MP4s are created. Two unowned speech artifacts are allowed.
 * npx tsx --env-file-if-exists=.env scripts/smoke-video-languages.ts
 * Add --frames-only later to render keyframes from saved outputs with one bundle.
 * Automated language checks are deliberately limited; review the saved prose/SVGs.
 */
import assert from 'node:assert/strict';
import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { DOMParser } from '@xmldom/xmldom';
import { bundle } from '@remotion/bundler';
import { renderStill, selectComposition } from '@remotion/renderer';
import { compileLesson, codexJsonRunner, generationProfile, type JsonRunner } from '../src/engine/codex';
import { probeAudioDuration, synthesizeSpeech } from '../src/engine/speech';
import { artifactRecord } from '../src/server/artifacts';
import { closeDb } from '../src/server/db';
import { SettingsSchema, type GenerationSettings, type Lesson, type RenderPlan } from '../src/shared/schema';
import { parseSource } from '../src/shared/source';
import { parseDiagram } from '../src/shared/diagram';
import { getMotionCueStates, resolveMotionCues } from '../src/shared/motion';
import { resolvePalette } from '../src/shared/visual-style';
import { buildPreviewPlan } from '../src/video/preview';
import { loadCustomRuntime, renderCustomFrame } from '../src/video/custom-runtime';

const chapter = { id: 'original-photo-workflow', title: '照片整理流程', markdown: '# 离线照片整理\n\nPhotoBox 是一款离线相册整理工具。先导入照片，再按拍摄日期分组，最后导出 ZIP。所有整理操作都在本机完成。' };
const examples = [
  { id: 'en-US-stable', language: 'en-US', voice: 'en-US-AriaNeural', creationMode: 'stable', creativeBrief: '制作简短产品介绍。控制在1–2个场景，全部旁白合计不超过70个英文单词。用预设图解清晰展示导入、分组、导出三个步骤；其他内容用简短旁白概括。' },
  { id: 'ja-JP-creative', language: 'ja-JP', voice: 'ja-JP-NanamiNeural', creationMode: 'creative', creativeBrief: '制作简短产品介绍。控制在1–2个场景，全部旁白合计不超过150个日文字符。使用自定义SVG呈现导入、分组、导出三个步骤，画面采用简短日语标签，语义变化绑定各自旁白；其他内容用简短旁白概括。' },
] satisfies Array<{ id: string; language: string; voice: string; creationMode: GenerationSettings['creationMode']; creativeBrief: string }>;
const { values } = parseArgs({ options: { output: { type: 'string', default: '.data/verification/video-languages' }, cases: { type: 'string', default: examples.map(example => example.id).join(',') }, model: { type: 'string', default: '' }, 'frames-only': { type: 'boolean', default: false }, 'dry-run': { type: 'boolean', default: false } } });
type Saved = { lesson: Lesson; settings: GenerationSettings; plan: RenderPlan };

async function collectText(plan: RenderPlan, directory: string) {
  const runtime = await loadCustomRuntime();
  const visible: string[] = [plan.title];
  for (const [sceneIndex, value] of plan.scenes.entries()) {
    const { scene } = value;
    visible.push(scene.title, scene.chapter);
    for (const object of scene.objects) {
      if (object.type === 'diagram' && object.language === 'diagram-json') {
        const diagram = parseDiagram(object.content);
        visible.push(...diagram.nodes.flatMap(node => [node.label, node.detail || '']), ...diagram.edges.map(edge => edge.label || ''));
      } else if (object.type === 'custom') {
        assert(object.motion, 'New custom SVG must keep the narration timing contract');
        const cues = resolveMotionCues(object.motion, value.utterances, plan.fps);
        for (const [index, cue] of cues.entries()) {
          const frame = cue.startFrame + Math.floor(cue.durationFrames * 0.75);
          const svg = renderCustomFrame(runtime, object.content, { fps: plan.fps, width: scene.layout === 'compare' ? 520 : 1104, height: 286, theme: resolvePalette(plan.theme, plan.palette), cues: getMotionCueStates(cues, frame) });
          await writeFile(path.join(directory, `scene-${sceneIndex + 1}-cue-${index + 1}.svg`), svg);
          visible.push(new DOMParser().parseFromString(svg, 'image/svg+xml').documentElement?.textContent || '');
        }
      } else if (object.type !== 'image') visible.push(object.content);
      if (object.imagePresentation?.caption) visible.push(object.imagePresentation.caption);
    }
  }
  const narration = plan.scenes.flatMap(value => value.scene.narration.map(unit => unit.text));
  return { visible, narration };
}

async function main() {
  const selected = values.cases!.split(',').map(id => { const example = examples.find(example => example.id === id); assert(example, `Unknown case ${id}`); return example; });
  const root = path.resolve(values.output!); await mkdir(root, { recursive: true });
  if (values['frames-only']) {
    const serveUrl = await bundle({ entryPoint: path.resolve('src/video/entry.tsx') });
    try {
      for (const example of selected) {
        const directory = path.join(root, example.id);
        const saved = JSON.parse(await readFile(path.join(directory, 'output.json'), 'utf8')) as Saved;
        const inputProps = { plan: saved.plan, assets: [] };
        const composition = await selectComposition({ serveUrl, id: 'OpenTutorLesson', inputProps });
        const frames: Array<{ frame: number; path: string }> = [];
        for (const [index, value] of saved.plan.scenes.slice(0, 2).entries()) {
          const frame = value.startFrame + Math.floor((value.durationFrames - 1) * 0.9);
          const output = path.join(directory, `scene-${index + 1}.png`);
          await renderStill({ serveUrl, composition, inputProps, frame, output, imageFormat: 'png' });
          frames.push({ frame, path: output });
        }
        const reportPath = path.join(directory, 'report.json');
        const report = JSON.parse(await readFile(reportPath, 'utf8'));
        await writeFile(reportPath, JSON.stringify({ ...report, frames }, null, 2));
        console.log(JSON.stringify({ case: example.id, frames }));
      }
    } finally { await rm(serveUrl, { recursive: true, force: true }); }
    return;
  }
  for (const example of selected) {
    const directory = path.join(root, example.id); await mkdir(directory, { recursive: true });
    const settings = SettingsSchema.parse({ ...example, model: values.model, audience: '第一次了解这款产品的普通观众', videoIntent: 'product', theme: 'ocean' });
    const source = parseSource('', [], [chapter]); const before = JSON.stringify(source);
    await writeFile(path.join(directory, 'source.md'), chapter.markdown + '\n');
    await writeFile(path.join(directory, 'input.json'), JSON.stringify({ chapter, settings, source }, null, 2));
    if (values['dry-run']) continue;
    const started = Date.now(); let attempts = 0;
    try {
      const runner: JsonRunner = async (...args) => {
        const attempt = ++attempts;
        await writeFile(path.join(directory, `attempt-${attempt}.prompt.txt`), args[0]);
        await writeFile(path.join(directory, `attempt-${attempt}.schema.json`), JSON.stringify(args[1], null, 2));
        const response = await codexJsonRunner(...args);
        await writeFile(path.join(directory, `attempt-${attempt}.response.json`), response);
        return response;
      };
      const result = await compileLesson(chapter.markdown, settings, [], { source, lessonTitle: chapter.title, runner, signal: AbortSignal.timeout(480_000), onProgress: (done, total, message) => { console.log(JSON.stringify({ case: example.id, done, total, message })); } });
      const plan = buildPreviewPlan(result.lesson, settings, 1);
      await writeFile(path.join(directory, 'output.json'), JSON.stringify({ ...result, settings, plan }, null, 2));
      const text = await collectText(plan, directory);
      await writeFile(path.join(directory, 'generated-text.json'), JSON.stringify(text, null, 2));
      assert(result.lesson.scenes.length <= 2, 'Requested at most 2 scenes');
      assert.equal(JSON.stringify(source), before, 'Original source metadata changed');
      assert.deepEqual(new Set(result.lesson.scenes.flatMap(scene => scene.sourceBlockIds)), new Set(source.blocks.map(block => block.id)));
      assert(result.lesson.scenes.every(scene => scene.chapterId === chapter.id && scene.chapter !== chapter.title), 'Source association or localized chapter label is wrong');
      const allText = [...text.visible, ...text.narration].join('\n');
      assert(allText.includes('PhotoBox') && allText.includes('ZIP'), 'Product name or format disappeared');
      if (example.language === 'en-US') {
        assert(!/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(allText), 'Chinese source or unrelated script leaked into English output');
        assert(result.lesson.scenes.some(scene => scene.objects.some(object => object.type === 'diagram' && object.language === 'diagram-json')), 'Requested stable diagram missing');
        assert(text.narration.join(' ').split(/\s+/).length <= 70, 'Narration exceeded the short English brief');
      } else {
        assert(text.narration.every(text => /[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(text)), 'Expected Japanese speech');
        assert(result.lesson.scenes.some(scene => scene.objects.some(object => object.type === 'custom')), 'Requested SVG missing');
        assert(text.narration.join('').length <= 150, 'Narration exceeded the short Japanese brief');
      }
      const first = result.lesson.scenes[0].narration[0];
      const speech = await synthesizeSpeech(first.text, settings.voice, settings.rate, { signal: AbortSignal.timeout(180_000) });
      const artifact = await artifactRecord(speech.url.split('/').at(-1)!);
      assert.equal(artifact.projectId, null, 'Test audio must not belong to a production project');
      const audioPath = path.join(directory, 'first-narration.wav'); await copyFile(artifact.path, audioPath);
      const measuredDuration = await probeAudioDuration(audioPath);
      assert(measuredDuration > 0 && Math.abs(measuredDuration - speech.durationSeconds) < 0.002, 'Actual audio duration differs from TTS metadata');
      await writeFile(path.join(directory, 'speech.json'), JSON.stringify({ text: first.text, voice: settings.voice, ...speech, audioPath, measuredDuration }, null, 2));
      await writeFile(path.join(directory, 'report.json'), JSON.stringify({ id: example.id, automatedStatus: 'passed', reviewStatus: 'pending', elapsedMs: Date.now() - started, attempts, modelProfile: JSON.parse(await generationProfile(settings.model)), checks: ['target-script-smoke', 'localized-chapter-display', 'unchanged-source-and-ids', 'requested-component', 'short-narration', 'real-microsoft-tts', 'probe-duration'], text, diagnostics: result.diagnostics, speech: { text: first.text, voice: settings.voice, measuredDuration, audioPath }, limitations: 'Automated script checks do not establish translation quality; read the actual prose and SVG. Only the first narration unit is synthesized. Keyframes use explicitly estimated silent timing; no MP4 is rendered.' }, null, 2));
      console.log(JSON.stringify({ case: example.id, automatedStatus: 'passed', attempts, scenes: result.lesson.scenes.length, measuredDuration }));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await writeFile(path.join(directory, 'report.json'), JSON.stringify({ id: example.id, automatedStatus: 'failed', reviewStatus: 'pending', elapsedMs: Date.now() - started, attempts, error: message }, null, 2));
      console.error(JSON.stringify({ case: example.id, error: message })); process.exitCode = 1;
    }
  }
}
main().catch(error => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; }).finally(closeDb);
