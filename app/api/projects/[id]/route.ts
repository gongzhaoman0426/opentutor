import { route, jsonBody } from '@/server/http';
import { getProject, updateProject, deleteProject } from '@/server/store';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const GET = route(async (_request, { params }) => Response.json({ project: await getProject((await params).id) }));
export const PATCH = route(async (request, { params }) => Response.json({ project: await updateProject((await params).id, await jsonBody(request)) }));
export const DELETE = route(async (_request, { params }) => { await deleteProject((await params).id); return Response.json({ deleted: true }); });
