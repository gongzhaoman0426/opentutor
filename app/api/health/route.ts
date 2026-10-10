import { Redis } from 'ioredis';
import { route } from '@/server/http';
import { getPool, initDb } from '@/server/db';
import { workerHealth } from '@/server/store';
import { codexHealth } from '@/engine/codex';
import { speechHealth } from '@/engine/speech';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
type Check = { ready: boolean; error?: string; lastSeen?: string | null };
let runtimeChecks: { expiresAt: number; promise: Promise<{ codex: Check; speech: Check }> } | undefined;
async function checkDatabase(): Promise<Check> { try { await initDb(); await getPool().query('SELECT 1'); return { ready: true }; } catch { return { ready: false, error: 'PostgreSQL 连接失败，请启动数据库并检查 DATABASE_URL' }; } }
async function checkRedis(): Promise<Check> {
  const redis = new Redis(process.env.REDIS_URL || 'redis://127.0.0.1:6389', { lazyConnect: true, maxRetriesPerRequest: 1, retryStrategy: () => null, connectTimeout: 2000, commandTimeout: 2000 });
  redis.on('error', () => {});
  try { await redis.connect(); await redis.ping(); return { ready: true }; }
  catch { return { ready: false, error: 'Redis 连接失败，请启动队列服务并检查 REDIS_URL' }; }
  finally { redis.disconnect(); }
}
export const GET = route(async () => {
  if (!runtimeChecks || runtimeChecks.expiresAt < Date.now()) {
    runtimeChecks = { expiresAt: Date.now() + 30000, promise: Promise.all([codexHealth(), speechHealth()]).then(([codex, speech]) => ({ codex, speech })) };
  }
  const [database, redis, worker, runtimes] = await Promise.all([checkDatabase(), checkRedis(), workerHealth().catch(() => ({ ready: false, lastSeen: null })), runtimeChecks.promise]);
  const checks = { database, redis, worker, ...runtimes };
  return Response.json({ ready: Object.values(checks).every(c => c.ready), checks });
});
