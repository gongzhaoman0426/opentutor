/**
 * Reproduce the saved scene's early result, then verify a narration-anchored
 * copy in the actual Player and Remotion still renderer. Read-only database
 * access; no project changes, model inference, TTS, or MP4 generation.
 * npx tsx --env-file-if-exists=.env scripts/smoke-motion-sync.ts
 */
import assert from 'node:assert/strict';
import { createReadStream } from 'node:fs';
import { mkdir, rm, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { bundle } from '@remotion/bundler';
import { renderStill, selectComposition } from '@remotion/renderer';
import { chromium, expect } from '@playwright/test';
import sharp from 'sharp';
import { getPool, closeDb } from '../src/server/db';
import { parseRange } from '../src/server/artifacts';
import { getChapterSourceKey } from '../src/shared/chapters';
import type { Project } from '../src/shared/schema';
import { getMotionCueStates, resolveMotionCues } from '../src/shared/motion';
import { resolvePalette } from '../src/shared/visual-style';
import { loadCustomRuntime, renderCustomFrame } from '../src/video/custom-runtime';
import { replaceAssetUrls } from '../src/video/timeline';

const { values } = parseArgs({ options: {
  project: { type: 'string', default: 'bb1bb278-8fc8-4955-9921-feb4e9aa2579' },
  chapter: { type: 'string', default: 'chapter-10e74ecc-9cf2-407d-be30-60c4a4dd92d4' },
  scene: { type: 'string', default: 'part2884a56170c614c9-scene5' },
  object: { type: 'string', default: 'visual_5' }, utterance: { type: 'string', default: 'narration_5c' },
  output: { type: 'string', default: '.data/verification/motion-sync/fixed' },
  'base-url': { type: 'string', default: process.env.OPENTUTOR_BASE_URL || 'http://127.0.0.1:3330' },
  'skip-browser': { type: 'boolean', default: false },
} });

async function main() {
  const directory = path.resolve(values.output!);
  const row = await getPool().query<{ data: Project }>('SELECT data FROM projects WHERE id=$1', [values.project]);
  const source = row.rows[0]?.data;
  assert(source, 'Saved source project does not exist');
  const chapter = source.chapters?.find(item => item.id === values.chapter);
  const video = source.chapterVideos?.[values.chapter!];
  assert(chapter && video?.renderPlan, 'Saved chapter has no render plan');
  const original = structuredClone(video.renderPlan);
  assert.equal(original.previewMode, 'aligned');
  assert(original.narrationAudio?.url, 'This test requires the actual continuous audio track');
  const scene = original.scenes.find(item => item.scene.id === values.scene);
  const object = scene?.scene.objects.find(item => item.id === values.object);
  const speech = scene?.utterances.find(item => item.utteranceId === values.utterance);
  assert(scene && object && speech, 'Saved target scene, object or narration no longer matches this regression');
  assert.equal(object.type, 'custom');
  assert.equal(object.motion, undefined, 'The original reproduction should use the old progress clock');
  assert.equal(object.content.split('progress>=0.55').length - 1, 1, 'Expected exactly one result threshold in the original SVG');
  const fixed = structuredClone(original);
  const fixedScene = fixed.scenes.find(item => item.scene.id === scene.scene.id)!;
  const fixedObject = fixedScene.scene.objects.find(item => item.id === object.id)!;
  fixedObject.content = object.content.replace('progress>=0.55', 'cues.result.started');
  fixedObject.motion = { version: 'narration-v1', cues: [{ id: 'result', utteranceId: speech.utteranceId }] };
  const restored = structuredClone(fixed);
  const restoredObject = restored.scenes.find(item => item.scene.id === scene.scene.id)!.scene.objects.find(item => item.id === object.id)!;
  restoredObject.content = object.content; delete restoredObject.motion;
  assert.deepEqual(restored, original, 'Only the single trigger expression and its motion declaration may change');
  const resolved = resolveMotionCues(fixedObject.motion, fixedScene.utterances, fixed.fps);
  assert.equal(resolved[0].startFrame, 1013, 'Saved true speech onset changed; inspect the fixture before altering this expected value');
  const frames = [751, 752, 1012, 1013];
  const runtime = await loadCustomRuntime();
  const geometry = { fps: original.fps, width: 1104, height: 286, theme: resolvePalette(original.theme, original.palette) };
  const sampled = frames.map(frame => {
    const before = renderCustomFrame(runtime, object.content, { ...geometry, frame, progress: frame / (scene.durationFrames - 1) });
    const after = renderCustomFrame(runtime, fixedObject.content, { ...geometry, cues: getMotionCueStates(resolved, frame) });
    const beforeResult = before.includes('Return value: 4'), afterResult = after.includes('Return value: 4');
    assert.equal(beforeResult, frame >= 752); assert.equal(afterResult, frame >= 1013);
    return { frame, chapterFrame: scene.startFrame + frame, beforeResult, afterResult };
  });
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, 'original-plan.json'), JSON.stringify(original, null, 2));
  await writeFile(path.join(directory, 'fixed-plan.json'), JSON.stringify(fixed, null, 2));
  await writeFile(path.join(directory, 'original-component.js'), object.content + '\n');
  await writeFile(path.join(directory, 'fixed-component.js'), fixedObject.content + '\n');

  // Resolve only existing artifacts owned by this project. No publish/init calls.
  const assets = video.previewAssets;
  const urls = [...assets.map(asset => asset.url), ...original.scenes.flatMap(item => item.utterances.map(clip => clip.url)), original.narrationAudio.url];
  const ids = [...new Set(urls.map(url => url.split('/').at(-1)!))];
  const artifacts = await getPool().query<{ id: string; path: string; mime: string }>('SELECT id,path,mime FROM artifacts WHERE id=ANY($1::uuid[]) AND (project_id=$2 OR project_id IS NULL)', [ids, source.id]);
  const files = new Map(artifacts.rows.map(item => [item.id, item]));
  assert.equal(files.size, ids.length, 'Some frozen source artifacts are unavailable');
  const server = createServer(async (request, response) => {
    const file = files.get(request.url?.split('?')[0].slice(1) || '');
    if (!file) { response.writeHead(404).end(); return; }
    try {
      const size = (await stat(file.path)).size;
      const range = parseRange(request.headers.range || null, size);
      const start = range?.start ?? 0, end = range?.end ?? size - 1;
      response.writeHead(range ? 206 : 200, { 'Content-Type': file.mime, 'Content-Length': end - start + 1, 'Access-Control-Allow-Origin': '*', 'Accept-Ranges': 'bytes', ...(range ? { 'Content-Range': `bytes ${start}-${end}/${size}` } : {}) });
      const stream = createReadStream(file.path, { start, end });
      stream.on('error', () => response.destroy()); response.on('close', () => stream.destroy()); stream.pipe(response);
    } catch { response.writeHead(500).end(); }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  let serveUrl: string | undefined;
  const report = { projectId: source.id, chapterId: chapter.id, sceneId: scene.scene.id, sceneTitle: scene.scene.title, objectId: object.id,
    previewRevision: video.previewRevision, cue: resolved[0], originalVisualStartSeconds: 752 / original.fps, fixedVisualStartSeconds: 1013 / original.fps,
    sentence: speech.boundaries[0], narrationPreserved: true, speechAndMasterTrackPreserved: true, planUnchangedExceptSingleCue: true,
    method: 'Read-only saved project; literal replacement of one progress threshold plus motion declaration. Original real audio reused. No model/TTS/project mutation.',
    sampled, exportedFrames: [] as Array<Record<string, unknown>>, browser: [] as Array<Record<string, unknown>>, pixelComparisons: [] as Array<Record<string, unknown>> };
  try {
    const address = server.address(); assert(address && typeof address === 'object');
    const resolve = (url: string) => `http://127.0.0.1:${address.port}/${url.split('/').at(-1)}`;
    const inputs = { before: replaceAssetUrls(original, assets, resolve), after: replaceAssetUrls(fixed, assets, resolve) };
    serveUrl = await bundle({ entryPoint: path.resolve('src/video/entry.tsx') });
    for (const [version, inputProps] of Object.entries(inputs)) {
      const composition = await selectComposition({ serveUrl, id: 'OpenTutorLesson', inputProps });
      for (const sample of sampled) {
        const output = path.join(directory, `${version}-${sample.frame}.png`);
        await renderStill({ serveUrl, composition, inputProps, frame: sample.chapterFrame, output, imageFormat: 'png' });
        report.exportedFrames.push({ version, ...sample, path: output });
      }
    }
    for (const sample of sampled) {
      const before = await sharp(path.join(directory, `before-${sample.frame}.png`)).raw().toBuffer();
      const after = await sharp(path.join(directory, `after-${sample.frame}.png`)).raw().toBuffer();
      const identical = before.equals(after);
      assert.equal(identical, sample.beforeResult === sample.afterResult, `Unexpected exported pixel comparison at frame ${sample.frame}`);
      report.pixelComparisons.push({ frame: sample.frame, identical });
    }
    if (!values['skip-browser']) {
      const browser = await chromium.launch({ headless: true });
      try {
        const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
        const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
        const projectId = 'afeed000-0000-4000-8000-000000000002';
        const project: Project = { ...structuredClone(source), id: projectId, title: '[隔离验证] 动效与旁白同步', markdown: chapter.markdown, chapters: [chapter],
          sourceMode: 'chapters', settings: video.settings, revision: video.previewRevision, lesson: null, renderPlan: null, previewRevision: null,
          chapterJobs: {}, latestJob: null, latestExport: null, chapterVideos: {} };
        project.chapterVideos![chapter.id] = { ...video, latestExport: null, sourceKey: getChapterSourceKey(project, chapter), current: true,
          lesson: { ...video.lesson, scenes: fixed.scenes.map(item => item.scene) }, renderPlan: inputs.after.plan, previewAssets: inputs.after.assets };
        await page.route('**/api/**', route => {
          if (route.request().method() !== 'GET') return route.abort('blockedbyclient');
          if (new URL(route.request().url()).pathname === `/api/projects/${projectId}`) return route.fulfill({ json: { project } });
          return route.continue();
        });
        await page.goto(`${values['base-url']}/projects/${projectId}`);
        await page.getByRole('tab', { name: '视频', exact: true }).click();
        for (const sample of [...sampled, sampled[2]]) {
          const slider = page.getByRole('slider', { name: '预览播放位置' });
          await slider.evaluate((element, frame) => {
            Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(element, String(frame));
            element.dispatchEvent(new Event('input', { bubbles: true })); element.dispatchEvent(new Event('change', { bubbles: true }));
          }, sample.chapterFrame);
          await expect(page.locator('.creation-player-area').getByRole('heading', { name: scene.scene.title, exact: true })).toBeVisible();
          const graphic = page.locator('.creation-player-area').getByRole('img', { name: 'AI 自定义图形组件' });
          await expect(graphic).toHaveCount(1); await expect(graphic).toBeVisible();
          if (sample.afterResult) await expect(graphic).toContainText('Return value: 4');
          else await expect(graphic).not.toContainText('Return value: 4');
          const output = path.join(directory, `browser-after-${sample.frame}.png`);
          await page.locator('.creation-player-area').screenshot({ path: output });
          report.browser.push({ frame: sample.frame, chapterFrame: sample.chapterFrame, resultVisible: (await graphic.textContent())!.includes('Return value: 4'), path: output });
        }
        assert.deepEqual(errors, []);
      } finally { await browser.close(); }
    }
    await writeFile(path.join(directory, 'report.json'), JSON.stringify({ status: 'passed', ...report }, null, 2));
    console.log(JSON.stringify({ status: 'passed', report: path.join(directory, 'report.json'), frames: sampled, browserSamples: report.browser.length, pixelComparisons: report.pixelComparisons }));
  } catch (error) {
    await writeFile(path.join(directory, 'report.json'), JSON.stringify({ status: 'failed', error: error instanceof Error ? error.message : String(error), ...report }, null, 2));
    throw error;
  } finally {
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    if (serveUrl) await rm(serveUrl, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; }).finally(closeDb);
