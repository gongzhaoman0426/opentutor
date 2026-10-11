import { route } from '@/server/http';
import { submitVideoVersionExport } from '@/server/store';
export const runtime = 'nodejs';
export const POST = route(async (request, { params }) => {
  const { id, versionId } = await params;
  const job = await submitVideoVersionExport(id, versionId, request.headers.get('idempotency-key') || undefined);
  return Response.json({ job }, { status: job.status === 'succeeded' ? 200 : 202 });
});
