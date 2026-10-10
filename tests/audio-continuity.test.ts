import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { copyFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import type { RenderPlan, RenderUtterance, Scene } from '../src/shared/schema';
import { assembleNarrationAudio, narrationAudioSegments } from '../src/engine/narration-audio';
import { normalizeSpeechText, probeAudioDuration, SPEECH_SAMPLE_RATE, synthesizeSpeech, trimSpeechAudio } from '../src/engine/speech';
import * as processes from '../src/engine/process';

const storage = vi.hoisted(() => ({ directory: '', published: [] as string[] }));
vi.mock('../src/server/artifacts', () => ({
  cacheDirectory: (name: string) => { const directory = path.join(storage.directory, name); mkdirSync(directory, { recursive: true }); return directory; },
  publishFile: async (file: string, mime: string, name: string, projectId: string) => {
    const output = path.join(storage.directory, `published-${storage.published.length}.wav`);
    await copyFile(file, output); storage.published.push(output);
    return { id: '00000000-0000-4000-8000-000000000004', url: '/api/artifacts/00000000-0000-4000-8000-000000000004', path: output, mime, name, projectId };
  },
  artifactRecord: async () => { throw new Error('Test must supply its fixture artifacts'); },
}));
let temporary: string;
beforeEach(async () => { temporary = await mkdtemp(path.join(os.tmpdir(), 'opentutor-continuity-test-')); storage.directory = temporary; storage.published = []; });
afterEach(async () => { vi.restoreAllMocks(); await rm(temporary, { recursive: true, force: true }); });

function pcmFixture(parts: { seconds: number; frequency?: number }[]): Buffer {
  const samples = parts.reduce((sum, part) => sum + Math.round(part.seconds * SPEECH_SAMPLE_RATE), 0);
  const pcm = Buffer.alloc(samples * 2);
  let offset = 0;
  for (const part of parts) for (let i = 0; i < Math.round(part.seconds * SPEECH_SAMPLE_RATE); i++) pcm.writeInt16LE(part.frequency ? Math.round(Math.sin(2 * Math.PI * part.frequency * i / SPEECH_SAMPLE_RATE) * 8000) : 0, (offset++) * 2);
  const header = Buffer.alloc(44);
  header.write('RIFF'); header.writeUInt32LE(36 + pcm.length, 4); header.write('WAVE', 8); header.write('fmt ', 12); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22); header.writeUInt32LE(SPEECH_SAMPLE_RATE, 24); header.writeUInt32LE(SPEECH_SAMPLE_RATE * 2, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34); header.write('data', 36); header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}
function wavPcm(bytes: Buffer): Buffer {
  expect(bytes.toString('ascii', 0, 4)).toBe('RIFF');
  for (let offset = 12; offset + 8 <= bytes.length;) {
    const size = bytes.readUInt32LE(offset + 4);
    if (bytes.toString('ascii', offset, offset + 4) === 'data') return bytes.subarray(offset + 8, offset + 8 + size);
    offset += 8 + size + size % 2;
  }
  throw new Error('No PCM data chunk');
}
const owner = '00000000-0000-4000-8000-000000000001';
const artifactId = '00000000-0000-4000-8000-000000000002';
const scene: Scene = { id: 's1', title: '连续音轨测试', chapter: '测试', layout: 'content', sourceBlockIds: ['b1'], objects: [{ id: 'o1', type: 'text', content: '学习重点', language: '' }], narration: [0, 1, 2].map(i => ({ id: `u${i}`, text: '测试音频', showObjectIds: ['o1'], focusObjectId: '' })) };
function renderFixture(): RenderPlan {
  const utterances: RenderUtterance[] = [0, 1, 2].map(i => ({ utteranceId: `u${i}`, startFrame: i, durationFrames: 1, url: `/api/artifacts/${artifactId}`, durationSeconds: 0.015, boundaries: [{ kind: 'utterance', text: '测试音频', startSeconds: 0, endSeconds: 0.015 }], cacheHit: false, hash: 'fixture', estimated: false }));
  return { schemaVersion: '0.1', revision: 1, title: '连续音轨测试', fps: 29, width: 1280, height: 720, theme: 'sage', previewMode: 'aligned', totalFrames: 3, scenes: [{ scene, startFrame: 0, durationFrames: 3, utterances }] };
}

describe('continuous PCM narration', () => {
  it('trims only outside silence and preserves every internal sample and sentence timing', async () => {
    const original = pcmFixture([{ seconds: 0.3 }, { seconds: 0.4, frequency: 440 }, { seconds: 0.5 }, { seconds: 0.4, frequency: 880 }, { seconds: 0.6 }]);
    const input = path.join(temporary, 'source.wav'); const output = path.join(temporary, 'trimmed.wav'); await writeFile(input, original);
    const result = await trimSpeechAudio(input, output, [{ kind: 'sentence', text: '第一句', startSeconds: 0.3, endSeconds: 0.7 }, { kind: 'sentence', text: '第二句', startSeconds: 1.2, endSeconds: 1.6 }], '第一句第二句');
    expect(result.trimStartSeconds).toBeCloseTo(0.22, 2);
    expect(result.trimEndSeconds).toBeCloseTo(0.45, 2);
    expect(result.durationSeconds).toBeCloseTo(1.53, 2);
    expect(result.boundaries[1].startSeconds).toBeCloseTo(1.2 - result.trimStartSeconds, 5);
    const trimmedPcm = wavPcm(await readFile(output));
    const startSample = Math.round(result.trimStartSeconds * SPEECH_SAMPLE_RATE);
    const endSample = startSample + trimmedPcm.length / 2;
    expect(trimmedPcm.equals(wavPcm(original).subarray(startSample * 2, endSample * 2))).toBe(true);
    const pauseStart = Math.round((0.7 - result.trimStartSeconds) * SPEECH_SAMPLE_RATE);
    expect(trimmedPcm.subarray(pauseStart * 2, (pauseStart + 24_000) * 2).equals(Buffer.alloc(48_000))).toBe(true);
  });
  it('assembles real FFmpeg PCM with absolute frame rounding, without cumulative sample drift', async () => {
    const input = path.join(temporary, 'clip.wav'); await writeFile(input, pcmFixture([{ seconds: 0.015, frequency: 440 }]));
    const plan = renderFixture();
    const result = await assembleNarrationAudio(plan, owner, AbortSignal.timeout(10_000), { artifactRecord: async () => ({ id: artifactId, url: `/api/artifacts/${artifactId}`, path: input, mime: 'audio/wav', name: 'fixture.wav', projectId: owner }) });
    const samples = wavPcm(await readFile(storage.published[0])).length / 2;
    expect(samples).toBe(Math.round(3 * SPEECH_SAMPLE_RATE / 29));
    expect(samples).not.toBe(3 * Math.round(SPEECH_SAMPLE_RATE / 29));
    expect(result.durationSeconds).toBeCloseTo(samples / SPEECH_SAMPLE_RATE, 5);
    expect(narrationAudioSegments(plan).segments.map(s => s.samples)).toEqual([1655, 1655, 1656]);
  });
  it('reprocesses the existing v2 MP3 cache into WAV without TTS and leaves its original bytes unchanged', async () => {
    const directory = path.join(temporary, 'speech'); mkdirSync(directory);
    const text = '第一句。第二句。'; const voice = 'zh-CN-XiaoxiaoNeural'; const rate = 0;
    const legacyHash = createHash('sha256').update(JSON.stringify({ version: 'edge-tts-7.2.8-sentence-mp3-v2', text: normalizeSpeechText(text), voice, rate })).digest('hex');
    const input = path.join(temporary, 'original.wav'); const mp3 = path.join(directory, `${legacyHash}.mp3`);
    await writeFile(input, pcmFixture([{ seconds: 0.3 }, { seconds: 0.4, frequency: 440 }, { seconds: 0.5 }, { seconds: 0.4, frequency: 880 }, { seconds: 0.6 }]));
    await processes.runProcess('ffmpeg', ['-v', 'error', '-y', '-i', input, '-c:a', 'libmp3lame', mp3]);
    const durationSeconds = await probeAudioDuration(mp3);
    const legacyMetadata = JSON.stringify({ version: 'edge-tts-7.2.8-sentence-mp3-v2', hash: legacyHash, durationSeconds, boundaries: [{ kind: 'sentence', text, startSeconds: 0.1, endSeconds: durationSeconds }] });
    await writeFile(path.join(directory, `${legacyHash}.json`), legacyMetadata);
    const originalBytes = await readFile(mp3);
    const actualRun = processes.runProcess;
    const spy = vi.spyOn(processes, 'runProcess').mockImplementation(async (command, args, options) => {
      if (command.includes('python')) throw new Error('This cache-upgrade test must not contact TTS');
      return actualRun(command, args, options);
    });
    const result = await synthesizeSpeech(text, voice, rate, { ownerProjectId: owner, signal: AbortSignal.timeout(10_000) });
    expect(result.cacheHit).toBe(true);
    expect(result.durationSeconds).toBeLessThan(durationSeconds);
    expect(wavPcm(await readFile(storage.published[0])).length).toBeGreaterThan(0);
    expect((await readFile(mp3)).equals(originalBytes)).toBe(true);
    expect(await readFile(path.join(directory, `${legacyHash}.json`), 'utf8')).toBe(legacyMetadata);
    expect(spy.mock.calls.some(([command]) => command.includes('python'))).toBe(false);
  });
  it('rejects estimated input and cancellation without publishing a silent placeholder', async () => {
    const bad = renderFixture(); bad.scenes[0].utterances[0].estimated = true;
    await expect(assembleNarrationAudio(bad, owner, AbortSignal.timeout(1000))).rejects.toThrow('未完成');
    const controller = new AbortController(); controller.abort();
    await expect(assembleNarrationAudio(renderFixture(), owner, controller.signal)).rejects.toBeDefined();
    expect(storage.published).toHaveLength(0);
  });
});
