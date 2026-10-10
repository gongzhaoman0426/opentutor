import { spawn } from 'node:child_process';

const migrate = spawn(process.execPath, ['--import', 'tsx', 'scripts/migrate.ts'], { stdio: 'inherit' });
const code = await new Promise<number | null>(resolve => migrate.once('exit', resolve));
if (code !== 0) {
  console.error('数据库初始化失败。请先执行 npm run infra:up，并检查 .env 的 DATABASE_URL。');
  process.exit(1);
}
const children = [
  spawn(process.execPath, ['--import', 'tsx', 'src/worker/index.ts'], { stdio: 'inherit', detached: process.platform !== 'win32' }),
  spawn(process.execPath, ['node_modules/next/dist/bin/next', 'dev', '--hostname', '127.0.0.1', '--port', process.env.PORT || '3000'], { stdio: 'inherit', detached: process.platform !== 'win32' }),
];
let stopping = false;
function stop(exitCode: number) {
  if (stopping) return;
  stopping = true;
  for (const child of children) {
    if (child.pid) {
      try { process.kill(process.platform === 'win32' ? child.pid : -child.pid, 'SIGTERM'); } catch { /* Already exited. */ }
    }
  }
  setTimeout(() => {
    for (const child of children) if (child.pid) {
      try { process.kill(process.platform === 'win32' ? child.pid : -child.pid, 'SIGKILL'); } catch { /* Already exited. */ }
    }
    process.exit(exitCode);
  }, 3000).unref();
}
for (const child of children) child.once('exit', code => stop(code ?? 1));
process.on('SIGINT', () => stop(0));
process.on('SIGTERM', () => stop(0));
