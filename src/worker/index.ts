import { Worker } from 'bullmq';
import { queueConnection, closeQueue, QUEUE_NAME } from '../server/queue';
import { addJobDiagnostic, claimJob, closeDb, failJob, flushOutbox, recoverExpiredJobs, getJob, heartbeatJob, initDb, markJobCancelled, touchWorker, updateJobProgress, updateJobPreview, completeJob } from '../server/store';
import { runPipeline } from '../engine/pipeline';
import { abortableDelay } from '../engine/process';

await initDb();
const connection = queueConnection();
connection.on('error', () => {});
const running = new Map<string, AbortController>();
let stopping = false;
const worker = new Worker(QUEUE_NAME, async queued => {
  const id: string = queued.data.jobId;
  const executionId = queued.id || id;
  const controller = new AbortController();
  running.set(executionId, controller);
  let claimed = await claimJob(id);
  // BullMQ can recover a crashed task before the database lease expires. Wait instead of acknowledging and losing it.
  for (let attempts = 0; !claimed && attempts < 26; attempts++) {
    const current = await getJob(id);
    if (['succeeded', 'failed', 'cancelled'].includes(current.status)) { running.delete(executionId); return; }
    await abortableDelay(5000, controller.signal);
    claimed = await claimJob(id);
  }
  if (!claimed) { running.delete(executionId); throw new Error('数据库任务租约尚未释放'); }
  const leaseToken = claimed.leaseToken;
  let polling = false;
  let lastHeartbeat = Date.now();
  const timer = setInterval(async () => {
    if (polling) return;
    polling = true;
    try {
      const job = await getJob(id);
      if (job.status === 'cancelling' || job.status === 'cancelled') controller.abort('user_cancelled');
      else if (Date.now() - lastHeartbeat >= 20_000) {
        if (!await heartbeatJob(id, leaseToken)) controller.abort('lease_lost');
        lastHeartbeat = Date.now();
      }
    } catch { controller.abort('storage_unavailable'); }
    finally { polling = false; }
  }, 2000);
  const timeout = setTimeout(() => controller.abort('deadline_exceeded'), Number(process.env.JOB_TIMEOUT_MS) || 3_600_000);
  try {
    const result = await runPipeline(claimed, controller.signal, {
      progress: (stage, completed, total, message, renderProgress) => updateJobProgress(id, stage, completed, total, message, leaseToken, renderProgress),
      diagnostic: diagnostic => addJobDiagnostic(id, diagnostic, leaseToken),
      preview: preview => updateJobPreview(id, preview, leaseToken),
    });
    controller.signal.throwIfAborted();
    await completeJob(id, result, leaseToken);
  } catch (error) {
    const current = await getJob(id).catch(() => null);
    if (current?.status === 'cancelling' || current?.status === 'cancelled' || controller.signal.reason === 'user_cancelled') await markJobCancelled(id, leaseToken).catch(() => {});
    else if (controller.signal.reason !== 'lease_lost') {
      const reason = controller.signal.reason;
      const message = reason === 'deadline_exceeded' ? '任务超过本次运行时限，已停止。再次生成时会复用已校验的编排和配音，无需删减文稿。' : reason === 'worker_shutdown' ? 'Worker 已停止，本次任务未完成。重新启动 Worker 后可再次提交。' : safeError(error);
      await failJob(id, message, leaseToken).catch(() => {});
    }
  } finally { clearInterval(timer); clearTimeout(timeout); running.delete(executionId); }
}, { connection, concurrency: Math.max(1, Math.min(4, Number(process.env.WORKER_CONCURRENCY) || 1)), lockDuration: 60_000, stalledInterval: 30_000 });
worker.on('error', () => console.error('Worker 连接异常，将按队列策略重连'));
worker.on('failed', () => console.error('队列调度失败，请查看项目任务状态'));
const maintenance = async () => { if (stopping) return; try { await touchWorker(); await recoverExpiredJobs(); await flushOutbox(); } catch { console.error('Worker 维护暂时失败，将重试'); } };
await maintenance();
const maintenanceTimer = setInterval(() => void maintenance(), 10_000);
console.log('OpenTutor Worker ready');

async function shutdown() {
  if (stopping) return;
  stopping = true;
  clearInterval(maintenanceTimer);
  for (const controller of running.values()) controller.abort('worker_shutdown');
  await worker.close();
  await connection.quit();
  await closeQueue();
  await closeDb();
}
process.once('SIGINT', () => void shutdown());
process.once('SIGTERM', () => void shutdown());

function safeError(error: unknown): string {
  if (!(error instanceof Error)) return '任务执行失败，请查看当前阶段后重试';
  const message = error.message.replace(/(?:sk-|Bearer\s+)[A-Za-z0-9_.-]+/gi, '[已隐藏]').replace(/https?:\/\/\S+/gi, '[服务地址]');
  return message.slice(0, 1500);
}
