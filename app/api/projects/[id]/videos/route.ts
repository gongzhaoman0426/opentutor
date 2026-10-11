import { route } from '@/server/http';
import { listVideoVersions } from '@/server/store';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const GET = route(async (request, { params }) => Response.json({ versions: await listVideoVersions((await params).id, new URL(request.url).searchParams.get('chapterId') ?? undefined) }));
