import { spawn } from 'node:child_process';

export async function runProcess(command: string, args: string[], options: { input?: string; signal?: AbortSignal; timeoutMs?: number; maxBytes?: number; env?: NodeJS.ProcessEnv } = {}): Promise<string> {
  options.signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'], shell: false, env: options.env });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', abort);
      if (error) reject(error); else resolve(stdout);
    };
    const stop = (error: Error) => { child.kill('SIGTERM'); setTimeout(() => child.kill('SIGKILL'), 1000).unref(); finish(error); };
    const abort = () => stop(new Error('任务已取消', { cause: options.signal?.reason }));
    const timer = setTimeout(() => stop(new Error(`${command} 执行超时`)), options.timeoutMs ?? 120_000);
    options.signal?.addEventListener('abort', abort, { once: true });
    child.stdout.on('data', (data: Buffer) => {
      stdout += data.toString('utf8');
      if (Buffer.byteLength(stdout) > (options.maxBytes ?? 4_000_000)) stop(new Error('子进程输出超过允许大小'));
    });
    child.stderr.on('data', (data: Buffer) => { if (stderr.length < 2000) stderr += data.toString('utf8'); });
    child.once('error', () => finish(new Error(`无法启动 ${command}，请检查运行依赖`)));
    child.once('close', code => {
      // Only controlled Python bridge errors may reach users; arbitrary process stderr can contain environment details.
      if (code !== 0) finish(new Error(command.includes('python') && stderr.includes('ModuleNotFoundError') ? '语音依赖尚未安装，请先执行 npm run speech:setup' : `${command} 执行失败（退出码 ${code ?? 'unknown'}）`));
      else finish();
    });
    child.stdin.on('error', () => {});
    child.stdin.end(options.input ?? '');
    if (options.signal?.aborted) abort();
  });
}

export function abortableDelay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(new Error('任务已取消')); };
    const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve(); }, milliseconds);
    signal?.addEventListener('abort', abort, { once: true });
  });
}

export async function withAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  signal.throwIfAborted();
  let abort: () => void = () => {};
  const cancelled = new Promise<never>((_, reject) => {
    abort = () => reject(new Error('任务已取消'));
    signal.addEventListener('abort', abort, { once: true });
  });
  try { return await Promise.race([promise, cancelled]); }
  finally { signal.removeEventListener('abort', abort); }
}
