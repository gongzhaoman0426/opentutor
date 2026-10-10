import path from 'node:path';
import { writeFile } from 'node:fs/promises';
import { synthesizeSpeech } from '../src/engine/speech';
import { closeDb } from '../src/server/store';
import { cacheDirectory } from '../src/server/artifacts';
import { buildRenderPlan, renderVideo, toSrt } from '../src/video/export';
import { defaultSettings, type Lesson } from '../src/shared/schema';
import { parseSource } from '../src/shared/source';

// Infrastructure smoke check: an explicit hand-authored scene, never presented as AI output.
const markdown = '# 勾股定理\n\n直角边为 3 和 4 时，斜边为 5。';
const source = parseSource(markdown);
const text = '直角三角形，三平方加四平方，等于五平方。';
const lesson: Lesson = { schemaVersion: '0.1', title: '媒体链路验证', objectives: ['验证真实音频同步与编码'], scenes: [{ id: 's1', chapter: '勾股定理', title: '从两条直角边，找到斜边', layout: 'content', sourceBlockIds: source.blocks.map(b => b.id), objects: [{ id: 'equation', type: 'formula', language: '', content: '3^2 + 4^2 = 5^2' }, { id: 'explanation', type: 'text', language: '', content: '**勾股定理**：直角三角形中，两条直角边的平方和等于斜边的平方。' }], narration: [{ id: 'u1', text, showObjectIds: ['equation', 'explanation'], focusObjectId: 'equation' }] }] };
try {
  const signal = AbortSignal.timeout(300000);
  const speech = await synthesizeSpeech(text, defaultSettings.voice, 0, { signal });
  const plan = buildRenderPlan(lesson, defaultSettings, new Map([['s1:u1', speech]]), 1);
  const output = path.join(cacheDirectory('verification'), 'speech-render.mp4');
  await renderVideo(plan, [], output, signal);
  await writeFile(output.replace(/\.mp4$/, '.srt'), toSrt(plan));
  console.log(JSON.stringify({ output, audioSeconds: speech.durationSeconds, frames: plan.totalFrames, fps: plan.fps, cacheHit: speech.cacheHit }));
} finally { await closeDb(); }
