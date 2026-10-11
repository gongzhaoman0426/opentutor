/**
 * Real Codex coverage for different video purposes. Saves exact prompts, model
 * output, diagnostics, and silent Remotion keyframes; never creates projects,
 * generates speech, or renders MP4. Semantic/visual review remains explicit.
 * npx tsx --env-file-if-exists=.env scripts/smoke-general-prompts.ts
 *   --cases product,story,briefing,atmosphere,explainer
 * --dry-run writes only the short source inputs and generation settings.
 */
import assert from 'node:assert/strict';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { bundle } from '@remotion/bundler';
import { renderStill, selectComposition } from '@remotion/renderer';
import { DOMParser } from '@xmldom/xmldom';
import { codexJsonRunner, compileLesson, generationProfile, type JsonRunner } from '../src/engine/codex';
import { SettingsSchema, type GenerationSettings, type RenderPlan } from '../src/shared/schema';
import { DIAGRAM_LANGUAGE } from '../src/shared/diagram';
import { getMotionCueStates, resolveMotionCues } from '../src/shared/motion';
import { resolvePalette } from '../src/shared/visual-style';
import { loadCustomRuntime, renderCustomFrame } from '../src/video/custom-runtime';
import { buildPreviewPlan } from '../src/video/preview';

const examples = [
  {
    id: 'product', markdown: '# 拾光\n\n拾光是一款离线相册整理工具。导入照片后，可按拍摄日期分组，也可以添加标签。挑选照片后可打包导出 ZIP，方便自己备份。所有整理操作在本机完成。',
    settings: { videoIntent: 'product', theme: 'ocean', creativeBrief: '面向第一次使用的人介绍这款工具，清楚呈现用途和特点；控制在1–2个场景。' },
    reviewQuestions: ['是否呈现产品用途与特点，而非课堂讲义？', '是否仅使用文稿给出的功能，没有新增识别、同步、效率或价格承诺？'],
  },
  {
    id: 'story', markdown: '# 书页里的航线\n\n这是一个虚构的短故事。小满翻开旧书，书中的插图画着一条弯曲的河。她把那条河想象成回家的路，将一片落叶夹进书页。窗外的雨停了，她合上书离开。',
    settings: { videoIntent: 'story', theme: 'sunset', creativeBrief: '安静温暖地讲述这个虚构故事，保留人物与意象。控制在1–2个场景。' },
    reviewQuestions: ['是否保留书中插图与河流这一叙事事实，没有误判成缺失素材或导航指令？', '是否呈现人物、意象和事件，而非讲解绘图或编程？'],
  },
  {
    id: 'briefing', markdown: '# 本周进展\n\n本周完成8项任务，2项仍在进行。新增12条用户反馈。图片上传偶发超时，原因尚未查明。下周先修复上传，再完善错误提示，完成日期未定。',
    settings: { videoIntent: 'briefing', theme: 'ink', creativeBrief: '做一则简短信息汇报，突出进展、当前问题与后续安排；保留原始数值和不确定性。控制在1–2个场景。' },
    reviewQuestions: ['8项完成、2项进行中、12条反馈是否对应正确标签？', '是否保留原因未明和完成日期未定，没有虚构结果、比例或日期？'],
  },
  {
    id: 'atmosphere', markdown: '# 呼吸的光\n\n深蓝背景中，半透明圆环缓慢扩张与收缩。两条柔和的曲线逐渐交汇，再分开。整体安静、克制，像潮汐一样循环。',
    settings: { videoIntent: 'auto', theme: 'ocean', creativeBrief: '创作抽象氛围短片，明确使用几何形状、缓慢脉冲和循环运动来营造平静感。旁白只需一句“让呼吸慢下来”。控制在1–2个场景。' },
    reviewQuestions: ['是否把几何、慢脉冲和循环作为明确请求的氛围表达，而非禁止或强行解释？', '是否没有被强制加入编程、知识步骤、数据实体或教学结论？'],
  },
  {
    id: 'explainer', markdown: '# 水的三态\n\n冰是固态，液态水可以流动，水蒸气是气态。冰融化成水，水蒸发成为水蒸气；水蒸气遇冷凝结成水，水继续冷却会凝固成冰。',
    settings: { videoIntent: 'explainer', theme: 'sage', creativeBrief: '用清晰的关系图展示三种状态和文稿中四种转换，帮助理解；控制在1–2个场景。' },
    reviewQuestions: ['在知识讲解适用时，是否仍能主动画出有信息的图示？', '固液气及融化、蒸发、凝结、凝固的方向和标签是否正确？'],
  },
] satisfies Array<{ id: string; markdown: string; settings: Partial<GenerationSettings>; reviewQuestions: string[] }>;

const { values } = parseArgs({ options: {
  cases: { type: 'string', default: examples.map(example => example.id).join(',') },
  model: { type: 'string', default: '' }, output: { type: 'string', default: '.data/verification/general-prompts' },
  concurrency: { type: 'string', default: '2' },
  'dry-run': { type: 'boolean', default: false }, 'skip-frames': { type: 'boolean', default: false },
} });

/** Extract actual SVG text at every cue, not numbers hidden in JS coordinates. */
async function sampleVisuals(plan: RenderPlan) {
  const runtime = await loadCustomRuntime();
  const text: string[] = [];
  const animationSamples: Array<{ sceneId: string; objectId: string; cueId: string; changes: boolean }> = [];
  for (const value of plan.scenes) {
    const scene = value.scene;
    text.push(scene.title, ...scene.narration.map(unit => unit.text));
    for (const object of scene.objects) {
      if (object.type !== 'custom') { text.push(object.content); continue; }
      assert(object.motion, 'Every newly generated custom component needs the narration motion contract');
      const resolved = resolveMotionCues(object.motion, value.utterances, plan.fps);
      const geometry = { fps: plan.fps, width: scene.layout === 'compare' ? 520 : 1104, height: 286, theme: resolvePalette(plan.theme, plan.palette) };
      for (const cue of resolved) {
        const outputs = [.15, .45, .8].map(fraction => {
          const frame = cue.startFrame + Math.floor(cue.durationFrames * fraction);
          const svg = renderCustomFrame(runtime, object.content, { ...geometry, cues: getMotionCueStates(resolved, frame) });
          text.push(new DOMParser().parseFromString(svg, 'image/svg+xml').documentElement?.textContent || '');
          return svg;
        });
        animationSamples.push({ sceneId: scene.id, objectId: object.id, cueId: cue.id, changes: new Set(outputs).size > 1 });
      }
    }
  }
  return { text: text.join('\n'), animationSamples };
}

async function main() {
  const selected = [...new Set(values.cases!.split(',').map(id => id.trim()))].map(id => {
    const example = examples.find(candidate => candidate.id === id);
    assert(example, `Unknown case ${id}; choose ${examples.map(candidate => candidate.id).join(', ')}`);
    assert(example.markdown.length <= 300, 'Each source fixture must stay below 300 characters');
    return example;
  });
  const directory = path.resolve(values.output!);
  const concurrency = Number(values.concurrency);
  assert(Number.isInteger(concurrency) && concurrency >= 1 && concurrency <= 2, '--concurrency must be 1 or 2');
  await mkdir(directory, { recursive: true });
  const previous: unknown = await readFile(path.join(directory, 'report.json'), 'utf8').then(JSON.parse).catch(() => []);
  const report: Array<Record<string, unknown>> = Array.isArray(previous) ? previous.filter(entry => entry && typeof entry === 'object' && !selected.some(example => example.id === entry.id)) : [];
  let serveUrl: string | undefined;
  let bundlePromise: Promise<string> | undefined;
  let reportWriting = Promise.resolve();
  try {
    const runExample = async (example: typeof examples[number]) => {
      const caseDirectory = path.join(directory, example.id);
      await mkdir(caseDirectory, { recursive: true });
      const settings = SettingsSchema.parse({ creationMode: 'creative', ...example.settings, model: values.model });
      await writeFile(path.join(caseDirectory, 'source.md'), example.markdown + '\n');
      await writeFile(path.join(caseDirectory, 'input.json'), JSON.stringify({ markdown: example.markdown, settings, assets: [], reviewQuestions: example.reviewQuestions }, null, 2));
      console.log(JSON.stringify({ case: example.id, characters: example.markdown.length, intent: settings.videoIntent, dryRun: values['dry-run'] }));
      if (values['dry-run']) return;
      const started = Date.now();
      let attempts = 0;
      try {
        const runner: JsonRunner = async (...args) => {
          const [prompt, schema] = args;
          const attempt = ++attempts;
          await writeFile(path.join(caseDirectory, `attempt-${attempt}.prompt.txt`), prompt);
          await writeFile(path.join(caseDirectory, `attempt-${attempt}.schema.json`), JSON.stringify(schema, null, 2));
          const repairLine = prompt.split('\n').find(line => line.startsWith('REPAIR_ERRORS='));
          const repairErrors: unknown = repairLine ? JSON.parse(repairLine.slice('REPAIR_ERRORS='.length)) : [];
          try {
            const response = await codexJsonRunner(...args);
            await writeFile(path.join(caseDirectory, `attempt-${attempt}.response.txt`), response);
            await writeFile(path.join(caseDirectory, `attempt-${attempt}.diagnostics.json`), JSON.stringify({ repairErrors }, null, 2));
            return response;
          } catch (error) {
            await writeFile(path.join(caseDirectory, `attempt-${attempt}.diagnostics.json`), JSON.stringify({ repairErrors, error: error instanceof Error ? error.message : String(error) }, null, 2));
            throw error;
          }
        };
        const result = await compileLesson(example.markdown, settings, [], {
          runner, signal: AbortSignal.timeout(Number(process.env.CODEX_TIMEOUT_MS || process.env.CODEX_TURN_TIMEOUT_MS) || 240_000),
          onProgress: (done, total, message) => { console.log(JSON.stringify({ case: example.id, done, total, message })); },
        });
        const plan = buildPreviewPlan(result.lesson, settings, 1);
        await writeFile(path.join(caseDirectory, 'output.json'), JSON.stringify({ settings, ...result, plan }, null, 2));
        const objects = result.lesson.scenes.flatMap(scene => scene.objects);
        const visual = await sampleVisuals(plan);
        await writeFile(path.join(caseDirectory, 'sampled-visual-text.txt'), visual.text);
        const checks: string[] = [];
        assert(!result.diagnostics.some(diagnostic => diagnostic.severity === 'error'), 'Generated structure failed validation'); checks.push('valid-generated-contract');
        assert(!objects.some(object => object.type === 'image'), 'No image assets were supplied; invented image references are invalid'); checks.push('no-invented-assets');
        assert(result.lesson.scenes.length <= 2, 'The explicit creative brief requested at most two scenes'); checks.push('requested-scene-limit');
        assert(!/(?:Python|square\s*\(|mul\s*\(|局部帧|环境图|Online Python Tutor|Edit this code)/i.test(visual.text), 'Unrelated programming example leaked into this non-programming fixture'); checks.push('no-specific-programming-leak');
        if (example.id !== 'explainer') {
          assert(!/(?:学习目标|本课目标|课后练习)/.test(visual.text), 'An unrelated classroom heading was added'); checks.push('no-specific-classroom-heading');
        }
        if (example.id === 'product') {
          assert(visual.text.includes('拾光') && /ZIP/i.test(visual.text), 'The supplied product name or ZIP capability disappeared'); checks.push('product-name-and-format-present');
        }
        if (example.id === 'story') {
          assert(/书/.test(visual.text) && /河/.test(visual.text) && /落叶/.test(visual.text), 'The provided narrative objects were removed');
          assert(!/(?:缺少原图|请上传原图|无法展示插图|未提供插图)/.test(visual.text), 'An ordinary story object was mistaken for a missing required asset'); checks.push('story-objects-preserved-without-missing-asset-message');
        }
        if (example.id === 'briefing') {
          const numbers = visual.text.replace(/十二/g, '12').replace(/八/g, '8').replace(/两|二/g, '2');
          for (const number of [8, 2, 12]) assert(new RegExp(`(^|[^0-9])${number}([^0-9]|$)`).test(numbers), `Source value ${number} is absent from visible/spoken content`);
          checks.push('source-values-8-2-12-present');
        }
        if (example.id === 'atmosphere') {
          assert(objects.some(object => object.type === 'custom'), 'The explicit geometric motion request needs a custom graphic');
          assert(visual.animationSamples.some(sample => sample.changes), 'The explicitly requested motion is static at all sampled cue times'); checks.push('requested-custom-graphic-changes-over-time');
        }
        if (example.id === 'explainer') {
          assert(objects.some(object => object.type === 'custom' || object.type === 'diagram' && object.language === DIAGRAM_LANGUAGE), 'The explicitly requested relation diagram is absent'); checks.push('requested-diagram-present');
        }
        const frames: Array<{ sceneId: string; sceneTitle: string; frame: number; path: string }> = [];
        if (!values['skip-frames']) {
          serveUrl = await (bundlePromise ??= bundle({ entryPoint: path.resolve('src/video/entry.tsx') }));
          const inputProps = { plan, assets: [] };
          const composition = await selectComposition({ serveUrl, id: 'OpenTutorLesson', inputProps });
          for (const [index, scene] of plan.scenes.entries()) {
            const fractions = example.id === 'atmosphere' ? [.25, .7] : [.7];
            for (const fraction of fractions) {
              const frame = scene.startFrame + Math.min(scene.durationFrames - 1, Math.max(8, Math.floor(scene.durationFrames * fraction)));
              const output = path.join(caseDirectory, `scene-${index + 1}-${Math.round(fraction * 100)}.png`);
              await renderStill({ serveUrl, composition, inputProps, frame, output, imageFormat: 'png' });
              frames.push({ sceneId: scene.scene.id, sceneTitle: scene.scene.title, frame, path: output });
            }
          }
        }
        report.push({ id: example.id, automatedStatus: 'passed', reviewStatus: 'pending', reviewQuestions: example.reviewQuestions, elapsedMs: Date.now() - started,
          modelProfile: JSON.parse(await generationProfile(settings.model)), attempts, checks, diagnostics: result.diagnostics, animationSamples: visual.animationSamples,
          scenes: result.lesson.scenes.map(scene => ({ title: scene.title, types: scene.objects.map(object => object.type), narration: scene.narration.map(unit => unit.text) })), frames,
          limitations: 'Automated checks cover explicit fields, selected source facts, timing contract and concrete contamination strings; they do not determine semantic or visual quality. Timing is estimated silent preview, not synthesized speech.' });
        console.log(JSON.stringify({ case: example.id, automatedStatus: 'passed', reviewStatus: 'pending', attempts, scenes: result.lesson.scenes.length, frames: frames.length }));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        report.push({ id: example.id, automatedStatus: 'failed', reviewStatus: 'pending', reviewQuestions: example.reviewQuestions, elapsedMs: Date.now() - started, attempts, error: message });
        process.exitCode = 1;
        console.error(JSON.stringify({ case: example.id, automatedStatus: 'failed', error: message }));
      }
      reportWriting = reportWriting.then(() => writeFile(path.join(directory, 'report.json'), JSON.stringify(report, null, 2)));
      await reportWriting;
    };
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(concurrency, selected.length) }, async () => {
      while (next < selected.length) await runExample(selected[next++]);
    }));
    await reportWriting;
  } finally {
    if (serveUrl) await rm(serveUrl, { recursive: true, force: true });
  }
  console.log(JSON.stringify({ directory, report: values['dry-run'] ? null : path.join(directory, 'report.json') }));
}

main().catch(error => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; });
