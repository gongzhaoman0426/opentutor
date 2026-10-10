import { describe, expect, it } from 'vitest';
import { renderChromiumOptions, renderConcurrency } from '../src/video/render-config';

const gib = 1024 ** 3;
describe('export resource budget', () => {
  it('lets Chrome choose its graphics backend with a software compatibility override', () => {
    expect(renderChromiumOptions({})).toEqual({ gl: null });
    expect(renderChromiumOptions({ RENDER_GL: 'auto' })).toEqual({ gl: null });
    expect(renderChromiumOptions({ RENDER_GL: 'swangle' })).toEqual({ gl: 'swangle' });
    expect(() => renderChromiumOptions({ RENDER_GL: 'typo' })).toThrow(/RENDER_GL/);
  });
  it('uses spare cores on a desktop and caps large servers', () => {
    expect(renderConcurrency({}, { cpus: 10, memoryBytes: 32 * gib })).toBe(5);
    expect(renderConcurrency({}, { cpus: 64, memoryBytes: 128 * gib })).toBe(8);
  });
  it('shares the budget across workers and preserves small machine support', () => {
    expect(renderConcurrency({ WORKER_CONCURRENCY: '2' }, { cpus: 10, memoryBytes: 32 * gib })).toBe(2);
    expect(renderConcurrency({ WORKER_CONCURRENCY: '1.5' }, { cpus: 10, memoryBytes: 32 * gib })).toBe(2);
    expect(renderConcurrency({}, { cpus: 8, memoryBytes: 4 * gib })).toBe(1);
    expect(renderConcurrency({}, { cpus: 1, memoryBytes: gib })).toBe(1);
  });
  it('accepts explicit tuning within the available CPU limit', () => {
    expect(renderConcurrency({ RENDER_CONCURRENCY: ' 3 ' }, { cpus: 10, memoryBytes: 32 * gib })).toBe(3);
    expect(renderConcurrency({ RENDER_CONCURRENCY: '20' }, { cpus: 10, memoryBytes: 32 * gib })).toBe(10);
    for (const value of ['0', '-1', '2.5', 'NaN', '50%', 'Infinity']) expect(() => renderConcurrency({ RENDER_CONCURRENCY: value })).toThrow(/正整数/);
  });
});
