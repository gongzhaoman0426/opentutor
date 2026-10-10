import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { codexEnvironment } from '../engine/codex';

export interface CodexModel { id: string; displayName: string; description: string; isDefault: boolean }
export interface ModelCatalog { models: CodexModel[]; warning: string; source: 'codex'; fetchedAt: string | null }
let cache: { value: ModelCatalog; expires: number; key: string } | undefined;
let pending: { key: string; promise: Promise<ModelCatalog> } | undefined;
const catalogNotice = '模型目录可能有缓存；实际可用性以当前账号的生成结果为准。';

/** Read Codex's own catalog without reading authentication tokens or starting an inference turn. */
export function readCodexModels(): Promise<CodexModel[]> {
  const require = createRequire(path.resolve('package.json'));
  const resolve = Reflect.get(require, 'resolve') as (id: string) => string;
  const manifest = Reflect.apply(resolve, require, ['@openai/codex/package.json']) as string;
  const command = process.env.CODEX_PATH || process.execPath;
  const args = [...(process.env.CODEX_PATH ? [] : [path.join(path.dirname(manifest), 'bin', 'codex.js')]), 'app-server', '--listen', 'stdio://', '-c', 'mcp_servers={}', '-c', 'plugins={}'];
  if (process.env.CODEX_BASE_URL) args.push('-c', `openai_base_url=${JSON.stringify(process.env.CODEX_BASE_URL)}`);
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: tmpdir(), env: codexEnvironment(), stdio: ['pipe', 'pipe', 'pipe'] });
    let settled = false; let buffer = ''; let requestId = 1; let pages = 0;
    const models: CodexModel[] = [];
    const finish = (error?: Error) => {
      if (settled) return; settled = true; clearTimeout(timer);
      child.stdin.end(); child.kill('SIGTERM');
      const force = setTimeout(() => { if (child.exitCode === null) child.kill('SIGKILL'); }, 1000); force.unref();
      if (error) reject(error); else resolve(models);
    };
    const timer = setTimeout(() => finish(new Error('Codex 模型目录读取超时')), 15000);
    const send = (message: unknown) => child.stdin.write(JSON.stringify(message) + '\n');
    child.on('error', () => finish(new Error('Codex 运行时无法启动')));
    child.stdin.on('error', () => finish(new Error('Codex 模型目录连接已关闭')));
    child.on('exit', () => { if (!settled) finish(new Error('Codex 在返回模型目录前退出')); });
    child.stderr.on('data', () => { /* Do not expose provider logs or local configuration details to the UI. */ });
    child.stdout.on('data', (chunk: Buffer) => {
      if (settled) return;
      buffer += chunk.toString('utf8');
      if (buffer.length > 2_000_000) { finish(new Error('Codex 模型目录响应过大')); return; }
      while (buffer.includes('\n')) {
        const split = buffer.indexOf('\n'); const line = buffer.slice(0, split); buffer = buffer.slice(split + 1);
        let message: { id?: number; error?: unknown; result?: { data?: unknown[]; nextCursor?: string | null } };
        try { message = JSON.parse(line); } catch { continue; }
        if (message.id !== requestId) continue;
        if (message.error) { finish(new Error('当前 Codex 运行时无法读取模型目录')); return; }
        if (requestId === 1) {
          send({ method: 'initialized', params: {} }); requestId++;
          send({ id: requestId, method: 'model/list', params: { limit: 100, includeHidden: false } });
        } else {
          if (!Array.isArray(message.result?.data)) { finish(new Error('Codex 返回了未知格式的模型目录')); return; }
          for (const entry of message.result.data) {
            if (!entry || typeof entry !== 'object') continue;
            const item = entry as Record<string, unknown>;
            const id = typeof item.model === 'string' ? item.model : typeof item.id === 'string' ? item.id : '';
            if (!id || id.length > 120 || !/^[A-Za-z0-9_.:/-]+$/.test(id) || item.hidden === true || models.some(model => model.id === id)) continue;
            models.push({ id, displayName: typeof item.displayName === 'string' ? item.displayName.slice(0, 120) : id, description: typeof item.description === 'string' ? item.description.slice(0, 600) : '', isDefault: process.env.CODEX_MODEL ? id === process.env.CODEX_MODEL : item.isDefault === true });
          }
          if (message.result.nextCursor && ++pages < 5) { requestId++; send({ id: requestId, method: 'model/list', params: { cursor: message.result.nextCursor, limit: 100, includeHidden: false } }); }
          else { finish(); return; }
        }
      }
    });
    send({ id: requestId, method: 'initialize', params: { clientInfo: { name: 'opentutor', title: 'OpenTutor', version: '0.1.0' }, capabilities: { experimentalApi: false } } });
  });
}

export function listCodexModels(): Promise<ModelCatalog> {
  const key = [process.env.CODEX_PATH, process.env.CODEX_HOME, process.env.CODEX_MODEL, process.env.CODEX_BASE_URL].join('|');
  if (cache?.key === key && cache.expires > Date.now()) return Promise.resolve(cache.value);
  if (pending?.key === key) return pending.promise;
  const promise = readCodexModels().then(models => {
    const value: ModelCatalog = { models, source: 'codex', fetchedAt: new Date().toISOString(), warning: models.length ? catalogNotice : 'Codex 没有返回可展示的模型，可继续使用服务端默认。' };
    cache = { value, key, expires: Date.now() + 300000 }; return value;
  }).catch((): ModelCatalog => ({ models: cache?.key === key ? cache.value.models : [], source: 'codex', fetchedAt: cache?.key === key ? cache.value.fetchedAt : null, warning: '暂时无法刷新 Codex 模型目录，可继续使用已保存的模型或服务端默认。' })).finally(() => { if (pending?.promise === promise) pending = undefined; });
  pending = { key, promise }; return promise;
}
