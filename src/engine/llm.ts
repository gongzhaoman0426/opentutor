import { readFile } from 'node:fs/promises';
import { getLlmSettings, getSecretProvider, type SecretProvider } from '../server/llm-store';
import { providerPresets, type JsonMode, type LlmSettings, type ModelListing } from '../shared/llm';
import { abortableDelay } from './process';
import type { ImageAttachment } from './images';

/**
 * OpenAI-compatible Chat Completions client. It replaces the former agent harness: the model gets one
 * prompt (+ optional images), may use no tools, and must return one JSON object.
 */
export interface RunOptions { model?: string; purpose?: 'director' | 'vision' }
export type JsonRunner = (prompt: string, schema: unknown, signal: AbortSignal, onEvent?: (message: string) => void, images?: ImageAttachment[], runOptions?: RunOptions) => Promise<string>;

/** Thrown when one call exceeded its time or output budget, so the caller can retry with a smaller batch. */
export class ModelTurnLimitError extends Error {
  readonly code = 'MODEL_TURN_LIMIT';
  constructor(reason: 'timeout' | 'length' = 'timeout') { super(reason === 'length' ? '模型输出被长度上限截断' : '模型当前片段生成超时'); this.name = 'ModelTurnLimitError'; }
}
class FormatUnsupported extends Error {}

export interface CallConfig { provider: SecretProvider; model: string }
const modeOrder: JsonMode[] = ['json_schema', 'json_object', 'prompt'];
// Providers that reject a response_format are remembered for the process lifetime instead of failing every batch.
const downgraded = new Map<string, JsonMode>();

function envProvider(): SecretProvider | null {
  const baseUrl = process.env.LLM_BASE_URL?.trim(); const apiKey = process.env.LLM_API_KEY?.trim();
  if (!baseUrl || !apiKey) return null;
  const jsonMode = (['json_schema', 'json_object', 'prompt'] as const).find(mode => mode === process.env.LLM_JSON_MODE) ?? 'json_object';
  return { id: 'env', name: '环境变量', kind: 'custom', baseUrl: baseUrl.replace(/\/+$/, ''), apiKey, options: { ...providerPresets.custom.options, jsonMode, maxTokens: Number(process.env.LLM_MAX_TOKENS) || 8192 } };
}

export async function resolveCall(purpose: 'director' | 'vision', override?: string): Promise<CallConfig> {
  const settings: LlmSettings = await getLlmSettings();
  const env = envProvider();
  if (!settings.text && !settings.vision && env && process.env.LLM_MODEL) {
    return { provider: env, model: (purpose === 'vision' ? process.env.LLM_VISION_MODEL : '') || override?.trim() || process.env.LLM_MODEL };
  }
  if (purpose === 'vision') {
    if (settings.vision) return { provider: await getSecretProvider(settings.vision.providerId), model: settings.vision.model };
    if (settings.text && settings.textSupportsImages) return { provider: await getSecretProvider(settings.text.providerId), model: override?.trim() || settings.text.model };
    throw new Error('当前章节含图片，但没有可看图的模型：请在“模型设置”里配置“图片理解模型”（如 GLM-4.6V），或勾选文本模型支持图片。');
  }
  if (!settings.text) throw new Error('尚未配置模型：请先在“模型设置”里添加供应商（GLM / DeepSeek / OpenAI 兼容）并选择生成模型。');
  return { provider: await getSecretProvider(settings.text.providerId), model: override?.trim() || settings.text.model };
}

export async function llmSettingsReady(): Promise<{ ready: boolean; error?: string }> {
  try { await resolveCall('director'); return { ready: true }; }
  catch (error) { return { ready: false, error: error instanceof Error ? error.message : '模型尚未配置' }; }
}

/** Stable identity of the active models; part of every generation cache key. */
export async function describeModels(selectedModel?: string): Promise<{ provider: string; endpoint: string; model: string; jsonMode: string; vision: string }> {
  try {
    const text = await resolveCall('director', selectedModel);
    const vision = await resolveCall('vision', selectedModel).then(call => `${new URL(call.provider.baseUrl).hostname}/${call.model}`, () => 'none');
    return { provider: text.provider.kind, endpoint: new URL(text.provider.baseUrl).hostname, model: text.model, jsonMode: text.provider.options.jsonMode, vision };
  } catch { return { provider: 'unconfigured', endpoint: '', model: selectedModel?.trim() || 'unconfigured', jsonMode: '', vision: 'none' }; }
}

function timeoutMs() { return Number(process.env.LLM_TIMEOUT_MS) || 300_000; }
function maxTokensFor(call: CallConfig): number {
  const configured = call.provider.options.maxTokens;
  if (call.provider.kind !== 'deepseek') return configured;
  // deepseek-chat accepts at most 8192 output tokens, deepseek-reasoner counts reasoning tokens as well.
  return /reasoner/i.test(call.model) ? Math.max(configured, 32768) : Math.min(configured, 8192);
}

export function sanitizeModelError(message: string, secrets: string[] = []): string {
  let cleaned = message.replace(/(?:sk-|Bearer\s+)[A-Za-z0-9_.-]+/gi, '[已隐藏]').replace(/https?:\/\/\S+/gi, '[服务地址]').replace(/((?:api[_-]?key|authorization|access[_-]?token)\s*["']?\s*[=:]\s*["']?)[^\s,;"']+/gi, '$1[已隐藏]');
  for (const secret of [...secrets, process.env.LLM_API_KEY, process.env.AUTH_TOKEN]) if (secret && secret.length > 4) cleaned = cleaned.split(secret).join('[已隐藏]');
  return cleaned.slice(0, 1200);
}

/** Models sometimes wrap JSON in fences or reasoning tags; return the JSON text when it can be found. */
export function extractJson(text: string): string {
  let value = text.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(value);
  if (fenced) value = fenced[1].trim();
  try { JSON.parse(value); return value; } catch { /* Try to locate the object below. */ }
  const start = value.indexOf('{'); const end = value.lastIndexOf('}');
  if (start >= 0 && end > start) {
    const slice = value.slice(start, end + 1);
    try { JSON.parse(slice); return slice; } catch { /* Return the original text so the repair loop can report it. */ }
  }
  return value;
}

interface ChatRequest { prompt: string; schema: unknown; images: ImageAttachment[]; signal: AbortSignal; onEvent?: (message: string) => void }

async function imageParts(call: CallConfig, images: ImageAttachment[]) {
  const parts: unknown[] = [];
  for (const image of images) {
    const bytes = await readFile(image.path);
    const base64 = bytes.toString('base64');
    parts.push({ type: 'image_url', image_url: { url: call.provider.options.imageFormat === 'base64' ? base64 : `data:${image.mime};base64,${base64}` } });
  }
  return parts;
}

function buildBody(call: CallConfig, mode: JsonMode, request: ChatRequest, userContent: unknown) {
  const system = 'You are a JSON generation API. Reply with exactly one JSON object and nothing else: no Markdown code fences, no commentary, no reasoning text outside the JSON.'
    + (mode === 'json_schema' ? '' : `\nThe JSON object MUST conform to this JSON Schema:\n${JSON.stringify(request.schema)}`);
  const body: Record<string, unknown> = {
    model: call.model, stream: true,
    messages: [{ role: 'system', content: system }, { role: 'user', content: userContent }],
    [call.provider.kind === 'openai' ? 'max_completion_tokens' : 'max_tokens']: maxTokensFor(call),
  };
  if (call.provider.options.temperature !== null) body.temperature = call.provider.options.temperature;
  if (mode === 'json_schema') body.response_format = { type: 'json_schema', json_schema: { name: 'opentutor_output', schema: request.schema, strict: false } };
  else if (mode === 'json_object') body.response_format = { type: 'json_object' };
  return body;
}

const retryable = new Set([408, 425, 429, 500, 502, 503, 504, 529]);
async function postWithRetry(call: CallConfig, body: unknown, signal: AbortSignal): Promise<Response> {
  let last: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    signal.throwIfAborted();
    try {
      const response = await fetch(`${call.provider.baseUrl}/chat/completions`, { method: 'POST', signal, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${call.provider.apiKey}` }, body: JSON.stringify(body) });
      if (response.ok || !retryable.has(response.status) || attempt === 2) return response;
      last = new Error(`HTTP ${response.status}`);
      await response.body?.cancel().catch(() => {});
    } catch (error) {
      if (signal.aborted) throw error;
      last = error;
      if (attempt === 2) throw error;
    }
    await abortableDelay(1500 * (attempt + 1), signal);
  }
  throw last instanceof Error ? last : new Error('模型服务无响应');
}

async function failure(call: CallConfig, response: Response): Promise<Error> {
  const raw = (await response.text().catch(() => '')).slice(0, 3000);
  let detail = raw;
  try { const parsed = JSON.parse(raw); detail = parsed?.error?.message || parsed?.message || parsed?.error || raw; } catch { /* Keep the raw text. */ }
  detail = typeof detail === 'string' ? detail : JSON.stringify(detail);
  if ([400, 422].includes(response.status) && /response_format|json_schema|json_object|structured|schema|text\.format/i.test(detail)) return new FormatUnsupported(detail);
  const secrets = [call.provider.apiKey];
  const hint: Record<number, string> = { 401: '身份验证失败，请检查 API Key', 403: '没有权限访问该模型，请检查账号权限或区域', 402: '账户余额不足', 404: '接口地址或模型名不存在，请检查接口地址与模型名', 429: '请求过于频繁或额度用尽' };
  return new Error(`模型服务返回 ${response.status}：${hint[response.status] ? `${hint[response.status]}（${sanitizeModelError(detail, secrets).slice(0, 300)}）` : sanitizeModelError(detail, secrets)}`);
}

async function readCompletion(response: Response, signal: AbortSignal, onEvent?: (message: string) => void): Promise<{ content: string; finish: string }> {
  const contentType = response.headers.get('content-type') || '';
  if (!contentType.includes('text/event-stream')) {
    const json = await response.json().catch(() => null) as { choices?: { message?: { content?: unknown }; finish_reason?: string }[] } | null;
    const choice = json?.choices?.[0];
    const content = typeof choice?.message?.content === 'string' ? choice.message.content : Array.isArray(choice?.message?.content) ? (choice!.message!.content as { text?: string }[]).map(part => part.text ?? '').join('') : '';
    return { content, finish: choice?.finish_reason ?? '' };
  }
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = ''; let content = ''; let reasoning = 0; let finish = ''; let lastReport = 0;
  const report = () => {
    if (Date.now() - lastReport < 2500) return;
    lastReport = Date.now();
    onEvent?.(content.length ? `模型正在生成（已接收 ${content.length} 字）` : reasoning ? `模型正在思考（${reasoning} 字）` : '模型正在规划旁白与画面');
  };
  for (;;) {
    signal.throwIfAborted();
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let newline: number;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline).trim(); buffer = buffer.slice(newline + 1);
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (!data || data === '[DONE]') continue;
      let chunk: { choices?: { delta?: { content?: unknown; reasoning_content?: unknown }; finish_reason?: string | null }[]; error?: { message?: string } };
      try { chunk = JSON.parse(data); } catch { continue; }
      if (chunk.error) throw new Error(`模型服务中断：${chunk.error.message ?? '未知错误'}`);
      const choice = chunk.choices?.[0];
      if (typeof choice?.delta?.content === 'string') content += choice.delta.content;
      if (typeof choice?.delta?.reasoning_content === 'string') reasoning += choice.delta.reasoning_content.length;
      if (choice?.finish_reason) finish = choice.finish_reason;
      report();
    }
  }
  return { content, finish };
}

/** One JSON generation. Returns the raw JSON text and the structured-output mode that worked. */
export async function chatJson(call: CallConfig, request: ChatRequest): Promise<{ text: string; mode: JsonMode }> {
  const key = `${call.provider.id}:${call.model}`;
  let mode = downgraded.get(key) ?? call.provider.options.jsonMode;
  const turnSignal = AbortSignal.any([request.signal, AbortSignal.timeout(timeoutMs())]);
  const content = request.images.length ? [{ type: 'text', text: `${request.prompt}\nATTACHED_IMAGES=${JSON.stringify(request.images.map((image, index) => ({ imageNumber: index + 1, assetId: image.assetId, hash: image.hash })))}` }, ...await imageParts(call, request.images)] : request.prompt;
  try {
    for (;;) {
      try {
        const response = await postWithRetry(call, buildBody(call, mode, request, content), turnSignal);
        if (!response.ok) throw await failure(call, response);
        request.onEvent?.('模型已开始响应');
        const { content: text, finish } = await readCompletion(response, turnSignal, request.onEvent);
        if (finish === 'length') throw new ModelTurnLimitError('length');
        if (!text.trim()) throw new Error('模型返回了空内容，请检查模型名与接口是否支持当前请求');
        return { text: extractJson(text), mode };
      } catch (error) {
        const next = modeOrder[modeOrder.indexOf(mode) + 1];
        if (error instanceof FormatUnsupported && next) {
          mode = next; downgraded.set(key, mode);
          request.onEvent?.(`该接口不支持当前结构化输出，已降级为 ${mode}`);
          continue;
        }
        throw error;
      }
    }
  } catch (error) {
    if (request.signal.aborted) throw request.signal.reason instanceof Error ? request.signal.reason : new Error('模型任务已取消');
    if (turnSignal.aborted) throw new ModelTurnLimitError('timeout');
    if (error instanceof ModelTurnLimitError) throw error;
    const message = error instanceof Error ? error.message : '模型调用失败';
    throw new Error(sanitizeModelError(message.startsWith('fetch failed') || error instanceof TypeError ? `无法连接模型服务（${(error as Error & { cause?: Error }).cause?.message ?? message}）；如需代理请设置 NODE_USE_ENV_PROXY=1 与 HTTPS_PROXY` : message, [call.provider.apiKey]));
  }
}

export const modelJsonRunner: JsonRunner = async (prompt, schema, signal, onEvent, images = [], runOptions = {}) => {
  const purpose = runOptions.purpose ?? (images.length ? 'vision' : 'director');
  const call = await resolveCall(purpose, runOptions.model);
  let attachments = images;
  if (images.length && purpose === 'director') {
    // Director batches carry image analyses as text. Raw pixels are optional context for models that can see.
    const settings = await getLlmSettings();
    if (!settings.textSupportsImages && !(!settings.text && envProvider())) attachments = [];
  }
  return (await chatJson(call, { prompt, schema, images: attachments, signal, onEvent })).text;
};

export async function listProviderModels(provider: SecretProvider): Promise<ModelListing> {
  const preset = providerPresets[provider.kind];
  const fallback = (warning: string): ModelListing => {
    const ids = [...new Set([...preset.textModels, ...preset.visionModels])];
    return { models: ids.map(id => ({ id, displayName: id })), source: ids.length ? 'preset' : 'none', warning };
  };
  try {
    const response = await fetch(`${provider.baseUrl}/models`, { headers: { Authorization: `Bearer ${provider.apiKey}` }, signal: AbortSignal.timeout(10_000) });
    if (!response.ok) return fallback(`该接口没有开放模型目录（HTTP ${response.status}），已显示常用模型，也可手动输入。`);
    const json = await response.json() as { data?: { id?: unknown }[] };
    const ids = (json.data ?? []).map(item => item.id).filter((id): id is string => typeof id === 'string' && /^[A-Za-z0-9_.:/@+-]{1,120}$/.test(id) && !/embed|whisper|tts|dall-e|moderation|rerank|audio|image-gen|stable-diffusion/i.test(id));
    if (!ids.length) return fallback('模型目录为空，已显示常用模型，也可手动输入。');
    return { models: [...new Set(ids)].sort().map(id => ({ id, displayName: id })), source: 'remote', warning: '' };
  } catch { return fallback('暂时无法读取模型目录，已显示常用模型，也可手动输入。'); }
}

export async function testModel(call: CallConfig, vision: boolean): Promise<{ ok: true; mode: JsonMode; latencyMs: number; sample: string }> {
  const started = Date.now();
  let images: ImageAttachment[] = [];
  const { mkdtemp, rm, writeFile } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const path = await import('node:path');
  const directory = await mkdtemp(path.join(tmpdir(), 'opentutor-llm-test-'));
  try {
    if (vision) {
      // A real solid-red PNG verifies that the model receives pixels, not just that the endpoint answers.
      const sharp = (await import('sharp')).default;
      const file = path.join(directory, 'red.png'); await writeFile(file, await sharp({ create: { width: 96, height: 96, channels: 3, background: { r: 220, g: 20, b: 20 } } }).png().toBuffer());
      images = [{ assetId: 'test', path: file, mime: 'image/png', hash: 'test' }];
    }
    const schema = { type: 'object', properties: { ok: { type: 'boolean' }, answer: { type: 'string' } }, required: ['ok', 'answer'], additionalProperties: false };
    const prompt = vision ? 'Look at the attached image and return JSON {"ok": true, "answer": "<its dominant color in one English word>"}.' : 'Return JSON {"ok": true, "answer": "pong"}.';
    const result = await chatJson(call, { prompt, schema, images, signal: AbortSignal.timeout(60_000) });
    let parsed: { ok?: boolean; answer?: string } | null = null;
    try { parsed = JSON.parse(result.text); } catch { /* Reported below. */ }
    if (!parsed || typeof parsed.answer !== 'string') throw new Error(`模型能连通，但返回内容不是预期的 JSON：${result.text.slice(0, 120)}`);
    if (vision && !/red|红/i.test(parsed.answer)) throw new Error(`模型能连通，但没有正确识别图片内容（回答：${parsed.answer.slice(0, 60)}）。请确认所选模型支持图片输入。`);
    return { ok: true, mode: result.mode, latencyMs: Date.now() - started, sample: parsed.answer.slice(0, 80) };
  } finally { await rm(directory, { recursive: true, force: true }); }
}
