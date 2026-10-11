import { route } from '@/server/http';
import { getVideoVersion } from '@/server/store';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const GET = route(async (_request, { params }) => {
  const { id, versionId } = await params;
  return Response.json({ version: await getVideoVersion(id, versionId) });
});
