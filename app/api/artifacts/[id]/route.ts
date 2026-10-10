import { stat } from 'node:fs/promises';
import { route } from '@/server/http';
import { artifactRecord } from '@/server/artifacts';
import { serveArtifact } from '@/server/media';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const GET = route(async (request, { params }) => serveArtifact(request, (await params).id));
export const HEAD = route(async (_request, { params }) => { const artifact = await artifactRecord((await params).id); const info = await stat(artifact.path); return new Response(null, { headers: { 'Content-Type': artifact.mime, 'Content-Length': String(info.size), 'Accept-Ranges': 'bytes', 'Cache-Control': 'private, max-age=3600', 'X-Content-Type-Options': 'nosniff' } }); });
