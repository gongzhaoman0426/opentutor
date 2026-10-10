import { route } from '@/server/http';
import { getJob, getJobEvents } from '@/server/store';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const GET = route(async (request, { params }) => {
  const id = (await params).id; await getJob(id);
  const header = request.headers.get('last-event-id') || new URL(request.url).searchParams.get('after') || '0';
  let cursor = /^\d+$/.test(header) ? Number(header) : 0;
  const encoder = new TextEncoder(); let stopped = false;
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const started = Date.now();
      try {
        while (!stopped && !request.signal.aborted && Date.now() - started < 55000) {
          const [job, events] = await Promise.all([getJob(id), getJobEvents(id, cursor)]);
          if (stopped || request.signal.aborted) break;
          if (events.length) cursor = events[events.length - 1].id;
          controller.enqueue(encoder.encode(`id: ${cursor}\ndata: ${JSON.stringify({ job, events })}\n\n`));
          if (['succeeded', 'failed', 'cancelled'].includes(job.status)) break;
          await new Promise<void>(resolve => {
            const done = () => { clearTimeout(timer); request.signal.removeEventListener('abort', done); resolve(); };
            const timer = setTimeout(done, 1000);
            request.signal.addEventListener('abort', done, { once: true });
          });
        }
      } catch { if (!stopped && !request.signal.aborted) controller.enqueue(encoder.encode('event: error\ndata: {"message":"连接中断，请重新读取任务状态"}\n\n')); }
      finally { if (!stopped) { stopped = true; controller.close(); } }
    },
    cancel() { stopped = true; },
  });
  return new Response(stream, { headers: { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' } });
});
