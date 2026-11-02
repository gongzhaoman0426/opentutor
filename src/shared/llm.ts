import { z } from 'zod';

/** Provider presets shared by the Web UI and the server. Only OpenAI-compatible Chat Completions endpoints are used. */
export const providerKinds = ['glm', 'deepseek', 'openai', 'custom'] as const;
export type ProviderKind = (typeof providerKinds)[number];
export const jsonModes = ['json_schema', 'json_object', 'prompt'] as const;
export type JsonMode = (typeof jsonModes)[number];
export const imageFormats = ['data-uri', 'base64'] as const;

export const ProviderOptionsSchema = z.object({
  jsonMode: z.enum(jsonModes).default('json_object'),
  maxTokens: z.number().int().min(256).max(131072).default(8192),
  imageFormat: z.enum(imageFormats).default('data-uri'),
  temperature: z.number().min(0).max(2).nullable().default(null),
}).strict();
export type ProviderOptions = z.infer<typeof ProviderOptionsSchema>;

export interface ProviderPreset {
  kind: ProviderKind; label: string; baseUrl: string; textModels: string[]; visionModels: string[]; options: ProviderOptions; note: string;
}
export const providerPresets: Record<ProviderKind, ProviderPreset> = {
  glm: {
    kind: 'glm', label: '智谱 GLM', baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    textModels: ['glm-4.6', 'glm-4.5', 'glm-4.5-air'], visionModels: ['glm-4.6v', 'glm-4.5v'],
    options: { jsonMode: 'json_object', maxTokens: 16384, imageFormat: 'base64', temperature: null },
    note: 'GLM-4.6 负责编排；图片理解使用 GLM-4.6V / 4.5V。',
  },
  deepseek: {
    kind: 'deepseek', label: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1',
    textModels: ['deepseek-chat', 'deepseek-reasoner'], visionModels: [],
    options: { jsonMode: 'json_object', maxTokens: 8192, imageFormat: 'data-uri', temperature: null },
    note: 'DeepSeek 不接收图片：含图片的章节需另外配置“图片理解模型”（例如 GLM-4.6V）。',
  },
  openai: {
    kind: 'openai', label: 'OpenAI', baseUrl: 'https://api.openai.com/v1',
    textModels: ['gpt-4.1', 'gpt-4.1-mini', 'gpt-4o'], visionModels: ['gpt-4.1', 'gpt-4o'],
    options: { jsonMode: 'json_schema', maxTokens: 16384, imageFormat: 'data-uri', temperature: null },
    note: '官方接口，支持结构化输出与图片。',
  },
  custom: {
    kind: 'custom', label: '自定义（OpenAI 兼容）', baseUrl: '', textModels: [], visionModels: [],
    options: { jsonMode: 'json_schema', maxTokens: 8192, imageFormat: 'data-uri', temperature: null },
    note: '任何提供 /chat/completions 的网关，例如 OpenRouter、硅基流动、本地 vLLM / Ollama。结构化输出不支持时会自动降级。',
  },
};

const BaseUrl = z.string().trim().max(300).refine(value => {
  try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash; }
  catch { return false; }
}, '接口地址需要是有效的 http(s) 地址，不能包含账号、查询参数或锚点').transform(value => value.replace(/\/+$/, ''));

export const ProviderInputSchema = z.object({
  id: z.string().uuid().optional(),
  name: z.string().trim().min(1).max(60),
  kind: z.enum(providerKinds),
  baseUrl: BaseUrl,
  /** Empty or omitted keeps the stored key on update. */
  apiKey: z.string().trim().max(600).optional(),
  clearKey: z.boolean().optional(),
  options: ProviderOptionsSchema,
}).strict();
export type ProviderInput = z.infer<typeof ProviderInputSchema>;

/** What the browser may see. The key itself never leaves the server. */
export interface PublicProvider { id: string; name: string; kind: ProviderKind; baseUrl: string; hasKey: boolean; keyHint: string; options: ProviderOptions; updatedAt: string }

const ModelId = z.string().trim().min(1).max(120).regex(/^[A-Za-z0-9_.:/@+-]+$/, '模型名只能包含字母、数字和 _ . : / @ + -');
export const ModelRoleSchema = z.object({ providerId: z.string().uuid(), model: ModelId }).strict();
export type ModelRole = z.infer<typeof ModelRoleSchema>;
export const LlmSettingsSchema = z.object({
  text: ModelRoleSchema.nullable().default(null),
  /** Dedicated image-understanding model. When empty the text model must accept images itself. */
  vision: ModelRoleSchema.nullable().default(null),
  textSupportsImages: z.boolean().default(false),
}).strict();
export type LlmSettings = z.infer<typeof LlmSettingsSchema>;
export const defaultLlmSettings: LlmSettings = LlmSettingsSchema.parse({});

export const TestRequestSchema = z.object({ providerId: z.string().uuid().optional(), draft: ProviderInputSchema.optional(), model: ModelId, vision: z.boolean().default(false) }).strict()
  .refine(value => value.providerId || value.draft, '需要指定已保存的供应商或填写草稿');

export interface ModelListing { models: { id: string; displayName: string; isDefault?: boolean }[]; source: 'remote' | 'preset' | 'none'; warning: string }
