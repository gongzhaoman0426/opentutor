import { route } from '@/server/http';
import { getProjectRevision } from '@/server/store';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const GET = route(async (_request, { params }) => { const { id, revisionId } = await params; return Response.json({ project: await getProjectRevision(id, Number(revisionId)) }); });
