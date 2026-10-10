import { availableParallelism, totalmem } from 'node:os';

interface RenderResources { cpus: number; memoryBytes: number }
type RenderEnvironment = Record<string, string | undefined>;

export function renderChromiumOptions(env: RenderEnvironment = process.env): { gl: 'swangle' | null } {
  const gl = env.RENDER_GL?.trim() || 'auto';
  if (gl !== 'auto' && gl !== 'swangle') throw new Error('RENDER_GL 仅支持 auto 或 swangle');
  return { gl: gl === 'swangle' ? 'swangle' : null };
}

export function renderConcurrency(env: RenderEnvironment = process.env, resources: RenderResources = { cpus: availableParallelism(), memoryBytes: totalmem() }): number {
  const cpus = Math.max(1, Math.floor(resources.cpus));
  const explicit = env.RENDER_CONCURRENCY?.trim();
  if (explicit) {
    if (!/^[1-9]\d*$/.test(explicit) || !Number.isSafeInteger(Number(explicit))) throw new Error('RENDER_CONCURRENCY 必须为正整数');
    return Math.min(cpus, Number(explicit));
  }
  const workers = Math.max(1, Math.min(4, Math.ceil(Number(env.WORKER_CONCURRENCY) || 1)));
  // Keep CPU capacity for the web app and encoder; budget 2 GiB per page plus 2 GiB for the app.
  // Total memory is intentional: macOS free memory excludes reclaimable caches.
  const cpuBudget = Math.floor(cpus / (2 * workers));
  const memoryBudget = Math.floor((resources.memoryBytes / 1024 ** 3 - 2) / (2 * workers));
  return Math.max(1, Math.min(8, cpuBudget, memoryBudget));
}
