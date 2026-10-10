import { Queue } from 'bullmq';
import { Redis } from 'ioredis';

export const QUEUE_NAME = process.env.OPENTUTOR_QUEUE_NAME || 'opentutor';
const state = globalThis as typeof globalThis & { opentutorRedis?: Redis; opentutorQueue?: Queue };
export function queueConnection() {
  return new Redis(process.env.REDIS_URL || 'redis://127.0.0.1:6389', { maxRetriesPerRequest: null, enableReadyCheck: false, connectTimeout: 3000 });
}
export function getRedis() {
  if (!state.opentutorRedis) {
    // Producers fail promptly during outages; the durable outbox retries later.
    // BullMQ Worker connections use queueConnection() and retry indefinitely.
    state.opentutorRedis = new Redis(process.env.REDIS_URL || 'redis://127.0.0.1:6389', { maxRetriesPerRequest: 1, enableReadyCheck: false, connectTimeout: 3000 });
    state.opentutorRedis.on('error', () => {});
  }
  return state.opentutorRedis;
}
export function getQueue() {
  if (!state.opentutorQueue) state.opentutorQueue = new Queue(QUEUE_NAME, { connection: getRedis(), defaultJobOptions: { attempts: 2, backoff: { type: 'exponential', delay: 3000 }, removeOnComplete: 1000, removeOnFail: 1000 } });
  return state.opentutorQueue;
}
export async function closeQueue() {
  await state.opentutorQueue?.close();
  if (state.opentutorRedis) await state.opentutorRedis.quit();
  delete state.opentutorQueue;
  delete state.opentutorRedis;
}
