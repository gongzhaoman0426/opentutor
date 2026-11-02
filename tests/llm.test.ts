import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { chatJson, extractJson, ModelTurnLimitError, sanitizeModelError, type CallConfig } from '../src/engine/llm';
import { ProviderInputSchema, providerPresets } from '../src/shared/llm';
import { decryptSecret, encryptSecret } from '../src/server/secrets';

interface Seen { auth?: string; body: Record<string, any> }
let server: http.Server; let base: string; let seen: Seen[] = []; let handler: (request: Seen, response: http.ServerResponse) => void;
const config = (patch: Partial<CallConfig['provider']['options']> = {}, kind: CallConfig['provider']['kind'] = 'custom', model = 'test-model'): CallConfig => ({ model, provider: { id: `p-${Math.random()}`, name: 't', kind, baseUrl: `${base}/v1`, apiKey: 'sk-secret-key-123456', options: { ...providerPresets[kind].options, ...patch } } });
const sse = (response: http.ServerResponse, chunks: object[]) => { response.writeHead(200, { 'content-type': 'text/event-stream' }); for (const chunk of chunks) response.write(`data: ${JSON.stringify(chunk)}\n\n`); response.end('data: [DONE]\n\n'); };
const delta = (content: string, finish: string | null = null) => ({ choices: [{ delta: { content }, finish_reason: finish }] });

beforeAll(async () => {
  server = http.createServer((request, response) => {
    let raw = '';
    request.on('data', chunk => { raw += chunk; });
    request.on('end', () => { const entry = { auth: request.headers.authorization, body: raw ? JSON.parse(raw) : {} }; seen.push(entry); handler(entry, response); });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>(resolve => server.close(() => resolve())));

describe('OpenAI-compatible runner', () => {
  it('streams a completion, sends the bearer key and requests json_schema when the provider supports it', async () => {
    seen = []; handler = (_r, response) => sse(response, [{ choices: [{ delta: { reasoning_content: '思考' } }] }, delta('{"ok":'), delta('true}', 'stop')]);
    const result = await chatJson(config({ jsonMode: 'json_schema' }), { prompt: 'hello', schema: { type: 'object' }, images: [], signal: AbortSignal.timeout(5000) });
    expect(JSON.parse(result.text)).toEqual({ ok: true });
    expect(result.mode).toBe('json_schema');
    expect(seen[0].auth).toBe('Bearer sk-secret-key-123456');
    expect(seen[0].body.response_format.type).toBe('json_schema');
    expect(seen[0].body.stream).toBe(true);
    expect(seen[0].body.messages[1].content).toBe('hello');
  });

  it('uses json_object for GLM/DeepSeek style providers and embeds the schema in the system prompt', async () => {
    seen = []; handler = (_r, response) => sse(response, [delta('```json\n{"a":1}\n```', 'stop')]);
    const result = await chatJson(config({}, 'deepseek', 'deepseek-chat'), { prompt: 'x', schema: { type: 'object', title: 'MARKER' }, images: [], signal: AbortSignal.timeout(5000) });
    expect(JSON.parse(result.text)).toEqual({ a: 1 });
    expect(seen[0].body.response_format).toEqual({ type: 'json_object' });
    expect(seen[0].body.messages[0].content).toContain('MARKER');
    expect(seen[0].body.max_tokens).toBeLessThanOrEqual(8192);
  });

  it('downgrades json_schema → json_object → prompt when the gateway rejects response_format, and remembers it', async () => {
    seen = [];
    handler = (request, response) => {
      const type = request.body.response_format?.type;
      if (type) { response.writeHead(400, { 'content-type': 'application/json' }); response.end(JSON.stringify({ error: { message: `response_format type ${type} is unavailable` } })); return; }
      sse(response, [delta('{"done":true}', 'stop')]);
    };
    const call = config({ jsonMode: 'json_schema' });
    const events: string[] = [];
    const first = await chatJson(call, { prompt: 'x', schema: {}, images: [], signal: AbortSignal.timeout(5000), onEvent: message => events.push(message) });
    expect(first.mode).toBe('prompt');
    expect(seen.map(entry => entry.body.response_format?.type)).toEqual(['json_schema', 'json_object', undefined]);
    expect(events.some(message => message.includes('降级'))).toBe(true);
    seen = [];
    await chatJson(call, { prompt: 'x', schema: {}, images: [], signal: AbortSignal.timeout(5000) });
    expect(seen).toHaveLength(1);
  });

  it('accepts non-streaming JSON responses from gateways that ignore stream:true', async () => {
    handler = (_r, response) => { response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify({ choices: [{ message: { content: '{"v":2}' }, finish_reason: 'stop' }] })); };
    expect(JSON.parse((await chatJson(config(), { prompt: 'x', schema: {}, images: [], signal: AbortSignal.timeout(5000) })).text)).toEqual({ v: 2 });
  });

  it('reports length truncation as a batch-splittable limit error', async () => {
    handler = (_r, response) => sse(response, [delta('{"a":', 'length')]);
    await expect(chatJson(config(), { prompt: 'x', schema: {}, images: [], signal: AbortSignal.timeout(5000) })).rejects.toBeInstanceOf(ModelTurnLimitError);
  });

  it('maps authentication failures to a readable message without leaking the key', async () => {
    handler = (_r, response) => { response.writeHead(401, { 'content-type': 'application/json' }); response.end(JSON.stringify({ error: { message: 'Incorrect API key provided: sk-secret-key-123456' } })); };
    const error = await chatJson(config(), { prompt: 'x', schema: {}, images: [], signal: AbortSignal.timeout(5000) }).then(() => new Error('resolved'), (reason: Error) => reason);
    expect(error.message).toContain('API Key');
    expect(error.message).not.toContain('sk-secret-key-123456');
  });

  it('propagates caller cancellation instead of wrapping it', async () => {
    handler = () => { /* never answers */ };
    const controller = new AbortController();
    const pending = chatJson(config(), { prompt: 'x', schema: {}, images: [], signal: controller.signal });
    setTimeout(() => controller.abort(new Error('user_cancelled')), 50);
    await expect(pending).rejects.toThrow('user_cancelled');
  });

  describe('images', () => {
    let directory: string; let file: string;
    beforeAll(async () => { directory = await mkdtemp(path.join(os.tmpdir(), 'llm-test-')); file = path.join(directory, 'a.png'); await writeFile(file, await sharp({ create: { width: 8, height: 8, channels: 3, background: '#f00' } }).png().toBuffer()); });
    afterAll(() => rm(directory, { recursive: true, force: true }));
    it('sends data URIs by default and raw base64 for providers that require it', async () => {
      seen = []; handler = (_r, response) => sse(response, [delta('{}', 'stop')]);
      const image = { assetId: '00000000-0000-4000-8000-000000000002', path: file, mime: 'image/png' as const, hash: 'h' };
      await chatJson(config(), { prompt: 'look', schema: {}, images: [image], signal: AbortSignal.timeout(5000) });
      await chatJson(config({ imageFormat: 'base64' }, 'glm', 'glm-4.6v'), { prompt: 'look', schema: {}, images: [image], signal: AbortSignal.timeout(5000) });
      const part = (entry: Seen) => entry.body.messages[1].content.find((item: any) => item.type === 'image_url').image_url.url as string;
      expect(part(seen[0])).toMatch(/^data:image\/png;base64,/);
      expect(part(seen[1])).not.toMatch(/^data:/);
      expect(seen[0].body.messages[1].content[0].text).toContain(image.assetId);
    });
  });
});

describe('helpers', () => {
  it('extracts JSON from fences, think tags and chatter', () => {
    expect(JSON.parse(extractJson('<think>hmm {x}</think>\n```json\n{"a":1}\n```'))).toEqual({ a: 1 });
    expect(JSON.parse(extractJson('Here you go: {"a":{"b":2}} Hope it helps'))).toEqual({ a: { b: 2 } });
    expect(extractJson('not json')).toBe('not json');
  });
  it('sanitizes keys and URLs from errors', () => {
    const message = sanitizeModelError('401 for https://api.example.com/v1 with Bearer abc.def and api_key=zzz', ['zzz']);
    expect(message).not.toMatch(/example\.com|abc\.def|zzz/);
  });
  it('encrypts secrets with authenticated encryption', () => {
    process.env.OPENTUTOR_SECRET_KEY = 'unit-test-master-key';
    const encrypted = encryptSecret('sk-live-123');
    expect(encrypted).not.toContain('sk-live-123');
    expect(decryptSecret(encrypted)).toBe('sk-live-123');
    const parts = encrypted.split(':'); parts[3] = Buffer.from('tampered').toString('base64');
    expect(() => decryptSecret(parts.join(':'))).toThrow();
    delete process.env.OPENTUTOR_SECRET_KEY;
  });
  it('validates provider input', () => {
    const ok = ProviderInputSchema.parse({ name: 'GLM', kind: 'glm', baseUrl: 'https://open.bigmodel.cn/api/paas/v4/', options: providerPresets.glm.options });
    expect(ok.baseUrl).toBe('https://open.bigmodel.cn/api/paas/v4');
    expect(() => ProviderInputSchema.parse({ name: 'x', kind: 'custom', baseUrl: 'file:///etc/passwd', options: providerPresets.custom.options })).toThrow();
    expect(() => ProviderInputSchema.parse({ name: 'x', kind: 'custom', baseUrl: 'https://u:p@host/v1', options: providerPresets.custom.options })).toThrow();
  });
});
