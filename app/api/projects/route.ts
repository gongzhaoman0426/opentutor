import { route, jsonBody } from '@/server/http';
import { listProjects, createProject } from '@/server/store';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const GET = route(async () => Response.json({ projects: await listProjects() }));
export const POST = route(async request => Response.json({ project: await createProject(await jsonBody(request)) }, { status: 201 }));
