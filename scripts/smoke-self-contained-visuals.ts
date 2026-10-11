/**
 * Compile image-free source examples with the real Codex harness, then render
 * silent preview keyframes. Does not write projects, jobs, speech, or MP4 files.
 * npx tsx --env-file-if-exists=.env scripts/smoke-self-contained-visuals.ts
 *   --cases environment-creative,process-creative,process-stable
 * Add --dry-run to write/inspect inputs without calling Codex or Chromium.
 */
import assert from 'node:assert/strict';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { bundle } from '@remotion/bundler';
import { renderStill, selectComposition } from '@remotion/renderer';
import { codexJsonRunner, compileLesson, type JsonRunner } from '../src/engine/codex';
import { SettingsSchema, type GenerationSettings } from '../src/shared/schema';
import { DIAGRAM_LANGUAGE, parseDiagram } from '../src/shared/diagram';
import { buildPreviewPlan } from '../src/video/preview';

// Verbatim paragraphs selected from the affected chapter, with a new heading.
// The missing book diagram and its interaction instructions are deliberately kept.
const environmentSource = `# 逐行观察环境图

在 Python 中，对一个表达式求值的环境由一系列帧（frame）组成，我们通常把帧画成一个个方框。每个帧里存放着一系列的绑定（binding）：名称 → 对应的值。存在一个单独的全局帧（global frame）。赋值和导入语句都会往当前环境的第一个帧（也就是全局帧）里添加绑定。目前，我们的环境只包含全局帧。

环境图（environment diagram）显示了当前环境中的绑定，还有名称所绑定的值。本书中的环境图是交互式的：你可以逐步执行左侧程序的每一行，然后在右侧查看环境的变化。你还可以单击“Edit this code”以将示例加载到 Online Python Tutor 中，它是由 Philip Guo 创建的用于生成环境图的工具。希望你能够自己去创建示例，研究对应生成的环境图。

函数也会出现在环境图中。import 语句将名称与内置函数绑定。def 语句将名称与用户自定义的函数绑定。导入 mul 并定义 square 后的结果环境如下所示：

每个函数都是一行以 func 开头的文本，后面紧跟函数名和形式参数。内置函数（如 mul）没有明确的形式参数名，所以统一写成 ...。

接下来，调用 square 函数并传入参数 -2。此时，系统会创建一个新帧，并将形参 x 绑定到数值 -2。

随后，程序会在当前环境中查找名称 x。当前环境由图中所示的两个帧组成。在这两处位置，x 的求值结果均为 -2，因此 square 函数返回结果 4。

需要注意的是，square() 帧中的“返回值（Return value）”并不是一种名称绑定，它仅表示创建该帧的函数调用所返回的结果。`;

const processSource = `# 照片归档流程

使用手册中的流程图如下所示。请点击图中的下一步按钮查看每个环节。

照片从相机导入本地工作区，随后按照拍摄日期分组。用户挑选需要保留的照片，最后将选中的照片打包成 ZIP 文件，保存到自己的备份目录。整个流程在本机完成。`;

const cases = [
  { id: 'environment-creative', markdown: environmentSource, settings: { creationMode: 'creative', theme: 'ocean', audience: '初学者', creativeBrief: '面向编程初学者的教学视频' } },
  { id: 'process-creative', markdown: processSource, settings: { creationMode: 'creative', theme: 'ink', videoIntent: 'product', creativeBrief: '介绍照片归档工具的使用流程' } },
  { id: 'process-stable', markdown: processSource, settings: { creationMode: 'stable', theme: 'sage', videoIntent: 'product', creativeBrief: '介绍照片归档工具的使用流程' } },
] satisfies Array<{ id: string; markdown: string; settings: Partial<GenerationSettings> }>;

const { values } = parseArgs({ options: {
  cases: { type: 'string', default: cases.map(item => item.id).join(',') },
  model: { type: 'string', default: '' }, output: { type: 'string', default: '.data/verification/self-contained-visuals' },
  'dry-run': { type: 'boolean', default: false }, 'skip-frames': { type: 'boolean', default: false },
} });

async function main() {
  const selected = [...new Set(values.cases!.split(',').map(id => id.trim()))].map(id => {
    const item = cases.find(candidate => candidate.id === id);
    if (!item) throw new Error(`Unknown case ${id}; choose ${cases.map(candidate => candidate.id).join(', ')}`);
    return item;
  });
  const directory = path.resolve(values.output!);
  await mkdir(directory, { recursive: true });
  const previous: unknown = await readFile(path.join(directory, 'report.json'), 'utf8').then(JSON.parse).catch(() => []);
  const report: Array<Record<string, unknown>> = Array.isArray(previous)
    ? previous.filter(entry => entry && typeof entry === 'object' && !selected.some(item => item.id === entry.id)) : [];
  let serveUrl: string | undefined;
  try {
    for (const item of selected) {
      const settings = SettingsSchema.parse({ ...item.settings, model: values.model });
      await writeFile(path.join(directory, `${item.id}.md`), item.markdown + '\n');
      console.log(JSON.stringify({ case: item.id, mode: settings.creationMode, model: settings.model || 'configured-default', characters: item.markdown.length, assets: 0, dryRun: values['dry-run'] }));
      if (values['dry-run']) continue;
      const started = Date.now();
      try {
        let attempt = 0;
        const runner: JsonRunner = async (...args) => {
          const [prompt] = args;
          const log = path.join(directory, `${item.id}-attempt-${++attempt}.json`);
          const repairLine = prompt.split('\n').find(line => line.startsWith('REPAIR_ERRORS='));
          const repairErrors: unknown = repairLine ? JSON.parse(repairLine.slice('REPAIR_ERRORS='.length)) : [];
          try {
            const response = await codexJsonRunner(...args);
            await writeFile(log, JSON.stringify({ repairErrors, response }, null, 2));
            return response;
          } catch (error) {
            await writeFile(log, JSON.stringify({ repairErrors, error: error instanceof Error ? error.message : String(error) }, null, 2));
            throw error;
          }
        };
        const compiled = await compileLesson(item.markdown, settings, [], {
          signal: AbortSignal.timeout(900_000),
          runner,
          onProgress: (done, total, message) => { console.log(JSON.stringify({ case: item.id, done, total, message })); },
        });
        const lesson = compiled.lesson;
        const objects = lesson.scenes.flatMap(scene => scene.objects);
        const spokenAndVisible = lesson.scenes.map(scene => [scene.title, ...scene.narration.map(utterance => utterance.text), ...scene.objects.filter(object => object.type !== 'custom' && object.type !== 'code').map(object => object.content)].join('\n')).join('\n');
        const custom = objects.filter(object => object.type === 'custom');
        const diagrams = objects.filter(object => object.type === 'diagram' && object.language === DIAGRAM_LANGUAGE);
        // Save AI output before assertions so failures remain inspectable.
        const plan = buildPreviewPlan(lesson, settings, 1);
        await writeFile(path.join(directory, `${item.id}.json`), JSON.stringify({ settings, ...compiled, plan }, null, 2));
        assert(!compiled.diagnostics.some(diagnostic => diagnostic.severity === 'error'), 'Generated lesson contains validation errors');
        assert(!objects.some(object => object.type === 'image'), 'No assets were supplied; image UUIDs must not be invented');
        assert(!/书中(?:的|所示)|本书(?:的|中)|点击.{0,12}(?:下一步|Next|Edit this code)|单击.{0,12}(?:下一步|Next|Edit this code)|(?:原文|手册)(?:中的|的)[^。！？\n]{0,16}(?:图|交互)/i.test(spokenAndVisible), 'The video still narrates an unavailable source diagram or interaction');
        if (settings.creationMode === 'creative') assert(custom.length > 0, 'Creative source-based visualization must contain an actual custom SVG component');
        else {
          assert.equal(custom.length, 0, 'Stable mode must not execute custom JavaScript');
          assert(diagrams.some(object => parseDiagram(object.content).edges.length > 0), 'Stable mode must draw the process with connected preset nodes');
        }
        const frames: Array<{ sceneId: string; title: string; frame: number; path: string }> = [];
        if (!values['skip-frames']) {
          serveUrl ??= await bundle({ entryPoint: path.resolve('src/video/entry.tsx') });
          const inputProps = { plan, assets: [] };
          const composition = await selectComposition({ serveUrl, id: 'OpenTutorLesson', inputProps });
          for (const [index, scene] of plan.scenes.entries()) {
            const frame = scene.startFrame + Math.min(scene.durationFrames - 1, Math.max(10, Math.floor(scene.durationFrames * 0.7)));
            const output = path.join(directory, `${item.id}-${index + 1}.png`);
            await renderStill({ serveUrl, composition, inputProps, frame, output, imageFormat: 'png' });
            frames.push({ sceneId: scene.scene.id, title: scene.scene.title, frame, path: output });
          }
        }
        report.push({ id: item.id, status: 'passed', elapsedMs: Date.now() - started, scenes: lesson.scenes.map(scene => ({ title: scene.title, types: scene.objects.map(object => object.type), narration: scene.narration.map(utterance => utterance.text) })), customObjects: custom.length, presetDiagrams: diagrams.length, diagnostics: compiled.diagnostics, frames, checks: ['real-codex', 'no-source-images', 'self-contained-narration', settings.creationMode === 'creative' ? 'generated-svg' : 'preset-svg-without-javascript', 'silent-preview-keyframes-only'] });
        console.log(JSON.stringify({ case: item.id, status: 'passed', scenes: lesson.scenes.length, customObjects: custom.length, presetDiagrams: diagrams.length, frames: frames.length }));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        report.push({ id: item.id, status: 'failed', elapsedMs: Date.now() - started, error: message });
        console.error(JSON.stringify({ case: item.id, status: 'failed', error: message }));
        process.exitCode = 1;
      }
      await writeFile(path.join(directory, 'report.json'), JSON.stringify(report, null, 2));
    }
  } finally {
    if (serveUrl) await rm(serveUrl, { recursive: true, force: true });
  }
  console.log(JSON.stringify({ output: directory, report: values['dry-run'] ? null : path.join(directory, 'report.json') }));
}

main().catch(error => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; });
