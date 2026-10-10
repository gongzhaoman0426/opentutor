import { route } from '@/server/http';
import { revisionDownload } from '@/server/store';
import { serveArtifact } from '@/server/media';
import { AppError } from '@/server/errors';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const GET = route(async (request, { params }) => {
  const { id, revisionId } = await params; const kind = new URL(request.url).searchParams.get('kind') || 'video';
  if (kind !== 'video' && kind !== 'subtitles') throw new AppError(400, 'INVALID_DOWNLOAD', '下载类型应为 video 或 subtitles');
  return serveArtifact(request, await revisionDownload(id, Number(revisionId), kind), true);
});
