import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { Pool } from 'pg';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { providerPresets } from '../src/shared/llm';
import { CUSTOM_EXAMPLES } from '../src/shared/custom';
import { defaultSettings } from '../src/shared/schema';

const schema = `test_${randomUUID().replaceAll('-', '')}`;
let admin: Pool; let dataDir: string; let server: http.Server; let base: string; let lastAuth = ''; let lastModel = ''; let lastBody: Record<string, any> = {};
let store: typeof import('../src/server/llm-store'); let db: typeof import('../src/server/db'); let llm: typeof import('../src/engine/llm');

beforeAll(async () => {
  const url0 = process.env.DATABASE_URL || 'postgresql://opentutor:opentutor@127.0.0.1:54329/opentutor';
  admin = new Pool({ connectionString: url0 }); await admin.query(`CREATE SCHEMA ${schema}`);
  const url = new URL(url0); url.searchParams.set('options', `-c search_path=${schema}`);
  process.env.DATABASE_URL = url.toString();
  dataDir = await mkdtemp(path.join(os.tmpdir(), 'opentutor-llm-store-')); process.env.OPENTUTOR_DATA_DIR = dataDir;
  server = http.createServer((request, response) => {
    let raw = ''; request.on('data', chunk => { raw += chunk; });
    request.on('end', () => {
      const body = JSON.parse(raw || '{}');
      lastAuth = String(request.headers.authorization); lastModel = body.model; lastBody = body;
      const prompt = String(body.messages?.[1]?.content ?? '');
      let content = '{"fromDb":true}';
      if (prompt.includes('LECTURE_DATA=')) {
        // Behaves like a model: reads the supplied source blocks and answers with a canvas opening + a viz scene.
        const data = JSON.parse(prompt.slice(prompt.indexOf('LECTURE_DATA=') + 13).split('\n')[0]);
        const ids: string[] = data.sourceBlocks.map((block: { id: string }) => block.id);
        const scene = (id: string, layout: string, objects: object[]) => ({ id, title: '标题', chapter: '', chapterId: null, layout, sourceBlockIds: ids, objects, narration: [{ id: `${id}n`, text: '一段旁白。', showObjectIds: (objects as { id: string }[]).map(o => o.id), focusObjectId: '' }] });
        content = JSON.stringify({ schemaVersion: '0.1', title: 'x', objectives: ['o'], palette: null, scenes: [
          scene('a', 'canvas', [{ id: 'hero', type: 'custom', content: CUSTOM_EXAMPLES[1].code, language: '', imagePresentation: null }]),
          scene('b', 'content', [{ id: 'chart', type: 'viz', content: JSON.stringify({ kind: 'bar', items: [{ label: 'A', value: 3 }, { label: 'B', value: 5 }] }), language: '', imagePresentation: null }]),
        ] });
      }
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ choices: [{ message: { content }, finish_reason: 'stop' }] }));
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
  store = await import('../src/server/llm-store'); db = await import('../src/server/db'); llm = await import('../src/engine/llm');
  await db.initDb();
});
afterAll(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()));
  await db?.closeDb(); await admin?.query(`DROP SCHEMA ${schema} CASCADE`); await admin?.end(); await rm(dataDir, { recursive: true, force: true });
});

describe('provider storage', () => {
  it('stores the API key encrypted, never returns it, and keeps it when an update leaves the key blank', async () => {
    const saved = await store.saveProvider({ name: '本地网关', kind: 'custom', baseUrl: base, apiKey: 'sk-database-secret-9999', options: providerPresets.custom.options });
    expect(saved).toMatchObject({ hasKey: true, keyHint: '…9999' });
    expect(JSON.stringify(saved)).not.toContain('sk-database-secret');
    const raw = (await admin.query(`SELECT api_key_enc FROM ${schema}.llm_providers WHERE id=$1`, [saved.id])).rows[0].api_key_enc as string;
    expect(raw).toMatch(/^v1:/); expect(raw).not.toContain('sk-database-secret');
    const renamed = await store.saveProvider({ id: saved.id, name: '改名后', kind: 'custom', baseUrl: base, options: providerPresets.custom.options });
    expect(renamed).toMatchObject({ name: '改名后', hasKey: true, keyHint: '…9999' });
    expect((await store.getSecretProvider(saved.id)).apiKey).toBe('sk-database-secret-9999');
  });

  it('resolves the configured model for the runner, honours per-chapter overrides and clears roles when a provider is deleted', async () => {
    const provider = (await store.listProviders())[0];
    await store.saveLlmSettings({ text: { providerId: provider.id, model: 'glm-4.6' }, vision: null, textSupportsImages: false });
    const run = await llm.modelJsonRunner('hello', { type: 'object' }, AbortSignal.timeout(5000));
    expect(JSON.parse(run)).toEqual({ fromDb: true });
    expect(lastAuth).toBe('Bearer sk-database-secret-9999'); expect(lastModel).toBe('glm-4.6');
    await llm.modelJsonRunner('hello', {}, AbortSignal.timeout(5000), undefined, [], { model: 'glm-4.5-air' });
    expect(lastModel).toBe('glm-4.5-air');
    // Images with no vision-capable model configured fail with an actionable message instead of silently dropping pixels.
    await expect(llm.resolveCall('vision')).rejects.toThrow('图片理解模型');
    await store.saveLlmSettings({ text: { providerId: provider.id, model: 'glm-4.6' }, vision: { providerId: provider.id, model: 'glm-4.6v' }, textSupportsImages: false });
    expect((await llm.resolveCall('vision', 'ignored-chapter-model')).model).toBe('glm-4.6v');
    const profile = await llm.describeModels('glm-4.5-air');
    expect(profile).toMatchObject({ model: 'glm-4.5-air', vision: expect.stringContaining('glm-4.6v') });
    await store.deleteProvider(provider.id);
    expect(await store.getLlmSettings()).toMatchObject({ text: null, vision: null });
    await expect(llm.resolveCall('director')).rejects.toThrow('尚未配置模型');
  });

  it('compiles a creative lesson end to end through the configured OpenAI-compatible endpoint', async () => {
    const provider = await store.saveProvider({ name: 'GLM 模拟', kind: 'glm', baseUrl: base, apiKey: 'sk-glm-0000', options: { ...providerPresets.glm.options, jsonMode: 'json_object' } });
    await store.saveLlmSettings({ text: { providerId: provider.id, model: 'glm-4.6' }, vision: null, textSupportsImages: false });
    const { compileLesson } = await import('../src/engine/director');
    const compiled = await compileLesson('# 标题\n\n这是一段需要被制作成视频的正文。', { ...defaultSettings, creationMode: 'creative' }, [], { ownerProjectId: randomUUID() });
    expect(compiled.lesson.scenes.map(scene => scene.layout)).toEqual(['canvas', 'content']);
    expect(lastBody.response_format).toEqual({ type: 'json_object' });
    expect(lastBody.max_tokens).toBe(16384);
    expect(lastBody.messages[0].content).toContain('JSON Schema');
    const prompt = String(lastBody.messages[1].content);
    expect(prompt).toContain('CREATIVE MODE'); expect(prompt).toContain('canvas'); expect(prompt).toContain('stagger');
    // A stable-mode request must not advertise canvas or model-written code.
    await compileLesson('# 标题\n\n这是一段需要被制作成视频的正文。', { ...defaultSettings, creationMode: 'stable' }, [], { ownerProjectId: randomUUID() }).catch(() => undefined);
    expect(String(lastBody.messages[1].content)).toContain('STABLE MODE');
    expect(JSON.stringify(lastBody.messages[0].content)).not.toContain('"canvas"');
    await store.deleteProvider(provider.id);
  });

  it('rejects settings that point at a missing provider', async () => {
    await expect(store.saveLlmSettings({ text: { providerId: randomUUID(), model: 'x' }, vision: null, textSupportsImages: false })).rejects.toThrow();
  });
});
