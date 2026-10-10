import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { NarrationAudio, RenderPlan, RenderUtterance } from '../shared/schema';
import { artifactRecord, publishFile, type StoredArtifact } from '../server/artifacts';
import { runProcess } from './process';
import { probeAudioDuration, SPEECH_SAMPLE_RATE } from './speech';

export type { NarrationAudio } from '../shared/schema';
export interface NarrationAudioDependencies { artifactRecord: (id: string) => Promise<StoredArtifact>; publishFile: typeof publishFile }
export interface AudioSegment { samples: number; clip?: RenderUtterance }

/** Sample positions derive from absolute frame positions rather than independently rounded clip lengths. */
export function narrationAudioSegments(plan: RenderPlan): { segments: AudioSegment[]; totalSamples: number } {
  if (plan.previewMode === 'draft' || plan.previewMode === 'partial' || !Number.isInteger(plan.fps) || plan.fps <= 0 || !Number.isInteger(plan.totalFrames) || plan.totalFrames <= 0 || !plan.scenes.length) throw new Error('只有完整配音时间轴才能合成连续音轨');
  const totalSamples = Math.round(plan.totalFrames * SPEECH_SAMPLE_RATE / plan.fps);
  if (totalSamples * 2 > 0xffffffff - 100) throw new Error('连续 WAV 音轨超过文件格式允许的长度，请按章节拆分');
  const segments: AudioSegment[] = [];
  let cursor = 0;
  for (const scene of plan.scenes) {
    if (!Number.isInteger(scene.startFrame) || scene.startFrame < 0 || !Number.isInteger(scene.durationFrames) || scene.durationFrames <= 0 || !scene.utterances.length) throw new Error('场景音频时间轴无效');
    for (const clip of scene.utterances) {
      if (clip.estimated || !/^\/api\/artifacts\/[0-9a-f-]{36}$/i.test(clip.url) || !Number.isInteger(clip.startFrame) || clip.startFrame < 0 || !Number.isInteger(clip.durationFrames) || clip.durationFrames <= 0 || !Number.isFinite(clip.durationSeconds) || clip.durationSeconds <= 0 || clip.startFrame + clip.durationFrames > scene.durationFrames || clip.durationSeconds > clip.durationFrames / plan.fps + 1 / SPEECH_SAMPLE_RATE) throw new Error('预览含有未完成或无效的配音，不能合成连续音轨');
      const start = Math.round((scene.startFrame + clip.startFrame) * SPEECH_SAMPLE_RATE / plan.fps);
      const end = Math.round((scene.startFrame + clip.startFrame + clip.durationFrames) * SPEECH_SAMPLE_RATE / plan.fps);
      if (start < cursor || end > totalSamples || end <= start) throw new Error('音频时间轴重叠或超出项目范围');
      if (start > cursor) segments.push({ samples: start - cursor });
      segments.push({ samples: end - start, clip });
      cursor = end;
    }
  }
  if (cursor < totalSamples) segments.push({ samples: totalSamples - cursor });
  return { segments, totalSamples };
}

export async function assembleNarrationAudio(plan: RenderPlan, ownerProjectId: string, signal: AbortSignal, overrides: Partial<NarrationAudioDependencies> = {}): Promise<NarrationAudio> {
  signal.throwIfAborted();
  const { segments, totalSamples } = narrationAudioSegments(plan);
  const services = { artifactRecord, publishFile, ...overrides };
  const directory = await mkdtemp(path.join(os.tmpdir(), 'opentutor-narration-'));
  const ffmpeg = process.env.FFMPEG_PATH || 'ffmpeg';
  try {
    const list: string[] = [];
    for (const [index, segment] of segments.entries()) {
      signal.throwIfAborted();
      const filename = `segment-${String(index).padStart(6, '0')}.wav`;
      const output = path.join(directory, filename);
      const filter = `apad=whole_len=${segment.samples},atrim=end_sample=${segment.samples},asetpts=N/SR/TB`;
      if (segment.clip) {
        const id = segment.clip.url.split('/').at(-1)!;
        const artifact = await services.artifactRecord(id);
        if (artifact.projectId !== ownerProjectId || !artifact.mime.startsWith('audio/')) throw new Error('音频素材不属于当前项目');
        const duration = await probeAudioDuration(artifact.path, signal);
        if (Math.abs(duration - segment.clip.durationSeconds) > Math.max(0.002, 1 / plan.fps)) throw new Error('配音素材实际时长与时间轴不一致，请重建配音');
        await runProcess(ffmpeg, ['-v', 'error', '-y', '-i', artifact.path, '-vn', '-af', `aresample=${SPEECH_SAMPLE_RATE},${filter}`, '-ar', String(SPEECH_SAMPLE_RATE), '-ac', '1', '-c:a', 'pcm_s16le', output], { signal });
      } else {
        await runProcess(ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-i', `anullsrc=r=${SPEECH_SAMPLE_RATE}:cl=mono`, '-af', filter, '-ar', String(SPEECH_SAMPLE_RATE), '-ac', '1', '-c:a', 'pcm_s16le', output], { signal });
      }
      list.push(`file '${filename}'`);
    }
    const manifest = path.join(directory, 'concat.txt');
    const output = path.join(directory, 'narration.wav');
    await writeFile(manifest, list.join('\n'), { mode: 0o600 });
    await runProcess(ffmpeg, ['-v', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', manifest, '-ar', String(SPEECH_SAMPLE_RATE), '-ac', '1', '-c:a', 'pcm_s16le', output], { signal });
    const durationSeconds = await probeAudioDuration(output, signal);
    if (Math.abs(durationSeconds - totalSamples / SPEECH_SAMPLE_RATE) > 1 / SPEECH_SAMPLE_RATE) throw new Error('连续音轨采样长度校验失败');
    signal.throwIfAborted();
    const published = await services.publishFile(output, 'audio/wav', 'narration.wav', ownerProjectId);
    signal.throwIfAborted();
    return { url: published.url, durationSeconds };
  } finally { await rm(directory, { recursive: true, force: true }); }
}
