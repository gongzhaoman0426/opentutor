import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { type Boundary, type SpeechResult } from '../shared/schema';
import { cacheDirectory, publishFile } from '../server/artifacts';
import { abortableDelay, runProcess, withAbort } from './process';

export interface Voice { name: string; locale: string; gender: string; displayName: string }
interface RawBoundary { kind: 'word' | 'sentence'; text: string; offsetTicks: number; durationTicks: number }
const ADAPTER_VERSION = 'edge-tts-7.2.8-pcm-trim-v3';
const LEGACY_VERSION = 'edge-tts-7.2.8-sentence-mp3-v2';
export const SPEECH_SAMPLE_RATE = 48_000;
const VoiceSchema = z.object({ name: z.string(), locale: z.string(), gender: z.string(), displayName: z.string() });
const CachedSpeechSchema = z.object({ version: z.literal(ADAPTER_VERSION), hash: z.string(), durationSeconds: z.number().positive().max(3600), boundaries: z.array(z.object({ kind: z.enum(['word', 'sentence', 'utterance']), text: z.string(), startSeconds: z.number().nonnegative(), endSeconds: z.number().positive() })).min(1) });
const LegacySpeechSchema = CachedSpeechSchema.extend({ version: z.literal(LEGACY_VERSION) });
let voiceCache: { expiresAt: number; voices: Voice[] } | undefined;
const inFlight = new Map<string, Promise<void>>();

function pythonPath(): string { return process.env.PYTHON_PATH || path.resolve('.venv/bin/python'); }
async function bridge(input: Record<string, unknown>, signal?: AbortSignal, timeoutMs = 90_000): Promise<unknown> {
  const output = await runProcess(pythonPath(), [path.resolve('scripts/speech_bridge.py')], { input: JSON.stringify(input), signal, timeoutMs });
  try { return JSON.parse(output); } catch { throw new Error('微软免费 TTS 返回了无法解析的数据'); }
}

export async function speechHealth(): Promise<{ ready: boolean; error?: string }> {
  try {
    await bridge({ action: 'health' }, undefined, 5000);
    await runProcess(process.env.FFPROBE_PATH || 'ffprobe', ['-version'], { timeoutMs: 5000 });
    await runProcess(process.env.FFMPEG_PATH || 'ffmpeg', ['-version'], { timeoutMs: 5000 });
    return { ready: true };
  } catch { return { ready: false, error: '语音运行依赖不可用，请检查 .venv、edge-tts、ffprobe 与 ffmpeg' }; }
}

export async function listVoices(signal?: AbortSignal): Promise<Voice[]> {
  signal?.throwIfAborted();
  if (voiceCache && voiceCache.expiresAt > Date.now()) return voiceCache.voices;
  const result = z.object({ voices: z.array(VoiceSchema).min(1) }).parse(await bridge({ action: 'voices' }, signal, 40_000));
  voiceCache = { expiresAt: Date.now() + 6 * 60 * 60 * 1000, voices: result.voices };
  return result.voices;
}

export function normalizeSpeechText(text: string): string {
  return text.normalize('NFC').replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, ' ').replace(/\s+/g, ' ').trim();
}

export function speechCacheKey(text: string, voice: string, rate: number): string {
  return cacheKey(ADAPTER_VERSION, text, voice, rate);
}
function cacheKey(version: string, text: string, voice: string, rate: number): string { return createHash('sha256').update(JSON.stringify({ version, text: normalizeSpeechText(text), voice, rate })).digest('hex'); }

export interface AudioTrimResult { durationSeconds: number; boundaries: Boundary[]; trimStartSeconds: number; trimEndSeconds: number; originalDurationSeconds: number }
export function shiftTrimmedBoundaries(boundaries: Boundary[], startSeconds: number, durationSeconds: number, text: string): Boundary[] {
  const shifted = boundaries.map(boundary => ({ ...boundary, startSeconds: Math.max(0, boundary.startSeconds - startSeconds), endSeconds: Math.min(durationSeconds, boundary.endSeconds - startSeconds) })).filter(boundary => boundary.endSeconds > boundary.startSeconds && boundary.startSeconds < durationSeconds);
  if (!shifted.length || shifted.some((boundary, index) => !Number.isFinite(boundary.startSeconds) || !Number.isFinite(boundary.endSeconds) || (index > 0 && boundary.startSeconds < shifted[index - 1].endSeconds))) return [{ kind: 'utterance', text, startSeconds: 0, endSeconds: durationSeconds }];
  return shifted;
}
export async function probeAudioDuration(file: string, signal?: AbortSignal): Promise<number> {
  const duration = Number((await runProcess(process.env.FFPROBE_PATH || 'ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', file], { signal, timeoutMs: 10_000 })).trim());
  if (!Number.isFinite(duration) || duration <= 0) throw new Error('音频实际时长无效');
  return duration;
}

/** Decode once to PCM; remove only outer silence while preserving every internal pause/sample. */
export async function trimSpeechAudio(input: string, output: string, boundaries: Boundary[], text: string, signal?: AbortSignal): Promise<AudioTrimResult> {
  signal?.throwIfAborted();
  const directory = await mkdtemp(path.join(os.tmpdir(), 'opentutor-speech-trim-'));
  const decoded = path.join(directory, 'decoded.wav');
  const ffmpeg = process.env.FFMPEG_PATH || 'ffmpeg';
  try {
    await runProcess(ffmpeg, ['-v', 'error', '-y', '-i', input, '-vn', '-ar', String(SPEECH_SAMPLE_RATE), '-ac', '1', '-c:a', 'pcm_s16le', decoded], { signal });
    const originalDurationSeconds = await probeAudioDuration(decoded, signal);
    const metadata = await runProcess(ffmpeg, ['-v', 'error', '-i', decoded, '-af', 'silencedetect=noise=-40dB:d=0.03,ametadata=mode=print:file=-', '-f', 'null', '-'], { signal, maxBytes: 2_000_000 });
    const intervals: { start: number; end?: number }[] = [];
    for (const match of metadata.matchAll(/lavfi\.silence_(start|end)=([\d.eE+-]+)/g)) {
      const value = Number(match[2]);
      if (!Number.isFinite(value)) continue;
      if (match[1] === 'start') intervals.push({ start: value });
      else if (intervals.length) intervals[intervals.length - 1].end = value;
    }
    const first = intervals[0];
    const last = intervals.at(-1);
    const firstEnd = first?.end ?? (first?.start === 0 ? originalDurationSeconds : 0);
    const leading = first && first.start <= 1 / SPEECH_SAMPLE_RATE ? firstEnd : 0;
    const trailing = last && (last.end === undefined || last.end >= originalDurationSeconds - 1 / SPEECH_SAMPLE_RATE) ? originalDurationSeconds - last.start : 0;
    const startSample = Math.max(0, Math.floor((leading - 0.08) * SPEECH_SAMPLE_RATE));
    const endSample = Math.min(Math.round(originalDurationSeconds * SPEECH_SAMPLE_RATE), Math.ceil((originalDurationSeconds - Math.max(0, trailing - 0.15)) * SPEECH_SAMPLE_RATE));
    if (endSample <= startSample || (leading >= originalDurationSeconds - 0.03 && trailing >= originalDurationSeconds - 0.03)) throw new Error('语音音频没有可用的发声，不能输出静音占位音频');
    await runProcess(ffmpeg, ['-v', 'error', '-y', '-i', decoded, '-af', `atrim=start_sample=${startSample}:end_sample=${endSample},asetpts=N/SR/TB`, '-ar', String(SPEECH_SAMPLE_RATE), '-ac', '1', '-c:a', 'pcm_s16le', output], { signal });
    const durationSeconds = await probeAudioDuration(output, signal);
    const trimStartSeconds = startSample / SPEECH_SAMPLE_RATE;
    return { durationSeconds, originalDurationSeconds, trimStartSeconds, trimEndSeconds: originalDurationSeconds - endSample / SPEECH_SAMPLE_RATE, boundaries: shiftTrimmedBoundaries(boundaries, trimStartSeconds, durationSeconds, text) };
  } catch (error) {
    await rm(output, { force: true });
    signal?.throwIfAborted();
    throw new Error(error instanceof Error ? `语音首尾处理失败：${error.message}` : '语音首尾处理失败，请检查 FFmpeg');
  } finally { await rm(directory, { recursive: true, force: true }); }
}

export function normalizeBoundaries(raw: RawBoundary[], durationSeconds: number, text: string): Boundary[] {
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) throw new Error('语音时长无效');
  const fallback = (): Boundary[] => [{ kind: 'utterance', text, startSeconds: 0, endSeconds: durationSeconds }];
  if (!raw.length) return fallback();
  const result: Boundary[] = [];
  let previousEnd = 0;
  for (const boundary of raw) {
    const start = boundary.offsetTicks / 10_000_000;
    const end = (boundary.offsetTicks + boundary.durationTicks) / 10_000_000;
    // Microsoft's sentence metadata can overlap by 50ms at natural transitions. Trim small overlaps,
    // retaining the reported sentence end; large overlaps/corrupt data still downgrade honestly.
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < previousEnd - 0.12 || start < 0 || end <= start || start >= durationSeconds || end > durationSeconds + 0.4) return fallback();
    const startSeconds = Math.max(start, previousEnd);
    const endSeconds = Math.min(end, durationSeconds);
    if (endSeconds <= startSeconds) return fallback();
    result.push({ kind: boundary.kind, text: boundary.text, startSeconds, endSeconds });
    previousEnd = endSeconds;
  }
  return result;
}

export async function synthesizeSpeech(text: string, voice: string, rate: number, options: { signal?: AbortSignal; ownerProjectId?: string; onWarning?: (message: string) => void | Promise<void> } = {}): Promise<SpeechResult> {
  const speechText = normalizeSpeechText(text);
  if (!speechText || speechText.length > 2000) throw new Error('单段讲稿须包含 1–2000 个字符，请拆分为语义段');
  if (!/^[a-z]{2,3}-[A-Z]{2}-[A-Za-z0-9]+Neural$/.test(voice) || !Number.isInteger(rate) || rate < -50 || rate > 100) throw new Error('音色或语速配置无效');
  options.signal?.throwIfAborted();
  const hash = speechCacheKey(speechText, voice, rate);
  const directory = await cacheDirectory('speech');
  const audioPath = path.join(directory, `${hash}.wav`);
  const metadataPath = path.join(directory, `${hash}.json`);
  const readCache = async () => {
    try {
      const cached = CachedSpeechSchema.parse(JSON.parse(await readFile(metadataPath, 'utf8')));
      if (cached.hash !== hash || (await stat(audioPath)).size < 100) return null;
      if (cached.boundaries.some((b, index) => b.endSeconds > cached.durationSeconds || b.startSeconds >= b.endSeconds || (index > 0 && b.startSeconds < cached.boundaries[index - 1].endSeconds))) return null;
      const duration = await probeAudioDuration(audioPath, options.signal);
      if (Math.abs(duration - cached.durationSeconds) > 2 / SPEECH_SAMPLE_RATE) return null;
      return cached;
    } catch { return null; }
  };
  let cached = await readCache();
  let cacheHit = !!cached || inFlight.has(hash);
  if (!cached) {
    const existing = inFlight.get(hash);
    if (existing) {
      try { await withAbort(existing, options.signal); }
      catch {
        options.signal?.throwIfAborted();
        // Another request's cancellation must not cancel this request. Retry under this caller's signal.
        return synthesizeSpeech(speechText, voice, rate, options);
      }
    } else {
      const generate = async () => {
        await runProcess(process.env.FFMPEG_PATH || 'ffmpeg', ['-version'], { signal: options.signal, timeoutMs: 5000 });
        const token = randomUUID();
        const rawAudio = path.join(directory, `${hash}-${token}.raw.mp3`);
        const temporaryAudio = path.join(directory, `${hash}-${token}.wav`);
        const temporaryMeta = `${temporaryAudio}.json`;
        let input = rawAudio;
        let originalBoundaries: Boundary[] | undefined;
        try {
          const legacyHash = cacheKey(LEGACY_VERSION, speechText, voice, rate);
          const legacyPath = path.join(directory, `${legacyHash}.mp3`);
          try {
            const legacy = LegacySpeechSchema.parse(JSON.parse(await readFile(path.join(directory, `${legacyHash}.json`), 'utf8')));
            const actual = await probeAudioDuration(legacyPath, options.signal);
            if (legacy.hash === legacyHash && Math.abs(actual - legacy.durationSeconds) < 0.002 && (await stat(legacyPath)).size > 100 && !legacy.boundaries.some(b => b.startSeconds >= b.endSeconds || b.endSeconds > actual)) {
              input = legacyPath; originalBoundaries = legacy.boundaries; cacheHit = true;
            }
          } catch { options.signal?.throwIfAborted(); /* Missing/invalid v2 input is a cache miss; existing files stay untouched. */ }
          if (!originalBoundaries) {
            for (let attempt = 0; attempt < 3; attempt++) {
              options.signal?.throwIfAborted();
              try {
                const response = z.object({ boundaries: z.array(z.object({ kind: z.enum(['word', 'sentence']), text: z.string(), offsetTicks: z.number(), durationTicks: z.number() })) }).parse(await bridge({ action: 'synthesize', text: speechText, voice, rate, output: rawAudio }, options.signal));
                const duration = await probeAudioDuration(rawAudio, options.signal);
                if (duration > 3600) throw new Error('微软 TTS 音频实际时长无效');
                originalBoundaries = normalizeBoundaries(response.boundaries, duration, speechText);
                break;
              } catch (error) {
                await rm(rawAudio, { force: true });
                options.signal?.throwIfAborted();
                if (attempt === 2) throw new Error('微软免费 TTS 生成失败（已重试 2 次），请检查网络后重试；未切换付费语音服务', { cause: error });
                await abortableDelay(1000 * 2 ** attempt, options.signal);
              }
            }
          }
          if (!originalBoundaries) throw new Error('语音原始边界缺失');
          // Processing failure stops the job. Untrimmed MP3 is never silently substituted for the PCM result.
          const processed = await trimSpeechAudio(input, temporaryAudio, originalBoundaries, speechText, options.signal);
          const metadata = CachedSpeechSchema.parse({ version: ADAPTER_VERSION, hash, durationSeconds: processed.durationSeconds, boundaries: processed.boundaries });
          await writeFile(temporaryMeta, JSON.stringify(metadata), { mode: 0o600 });
          options.signal?.throwIfAborted();
          await rename(temporaryAudio, audioPath);
          await rename(temporaryMeta, metadataPath);
        } finally { await Promise.all([rm(rawAudio, { force: true }), rm(temporaryAudio, { force: true }), rm(temporaryMeta, { force: true })]); }
      };
      const pending = generate();
      inFlight.set(hash, pending);
      try { await pending; } finally { inFlight.delete(hash); }
    }
    cached = await readCache();
  }
  if (!cached) throw new Error('语音缓存校验失败');
  options.signal?.throwIfAborted();
  if (cached.boundaries.every(b => b.kind === 'utterance')) await options.onWarning?.('微软 TTS 未提供可用的精细边界，本段使用真实音频的整段同步');
  const artifact = await publishFile(audioPath, 'audio/wav', `speech-${hash.slice(0, 12)}.wav`, options.ownerProjectId);
  return { url: artifact.url, durationSeconds: cached.durationSeconds, boundaries: cached.boundaries, cacheHit, hash };
}

export async function previewVoice(voice: string, rate: number, text?: string, signal?: AbortSignal): Promise<SpeechResult> {
  return synthesizeSpeech((text || (voice.startsWith('zh-') ? '欢迎来到 OpenTutor。用文字和图片，创作属于你的视频。' : 'Welcome to OpenTutor. Turn your words and images into expressive videos.')).slice(0, 300), voice, rate, { signal });
}
