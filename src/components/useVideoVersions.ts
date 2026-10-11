'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { VideoVersionDetail, VideoVersionSummary } from '@/shared/schema';
import { api, errorMessage } from './api';
import { useI18n } from '@/i18n/provider';

/** Selection belongs to a chapter; late list/detail responses never change it. */
export function useVideoVersions(projectId: string, chapterId: string, refreshKey: string) {
  const { locale } = useI18n();
  const scope = `${projectId}:${chapterId}`;
  const currentScope = useRef(scope); currentScope.current = scope;
  const [selection, setSelection] = useState({ scope, id: 'latest' });
  const [list, setList] = useState<{ scope: string; values: VideoVersionSummary[]; loading: boolean; error: unknown }>({ scope: '', values: [], loading: false, error: '' });
  const [detail, setDetail] = useState<{ scope: string; id: string; value: VideoVersionDetail | null; error: unknown }>({ scope: '', id: '', value: null, error: '' });
  const [retry, setRetry] = useState(0);
  const selectedId = selection.scope === scope ? selection.id : 'latest';
  const versions = list.scope === scope ? list.values : [];
  const selected = selectedId === 'latest' ? versions.find(version => version.current) ?? versions[0] : versions.find(version => version.id === selectedId);
  const detailId = selected?.id ?? '';

  useEffect(() => {
    if (!projectId || !chapterId) return;
    const controller = new AbortController(); let alive = true;
    setList(previous => ({ scope, values: previous.scope === scope ? previous.values : [], loading: true, error: '' }));
    api<{ versions: VideoVersionSummary[] }>(`/api/projects/${projectId}/videos?chapterId=${encodeURIComponent(chapterId)}`, { signal: controller.signal })
      .then(result => { if (alive && currentScope.current === scope) setList({ scope, values: result.versions, loading: false, error: '' }); })
      .catch(error => { if (alive && currentScope.current === scope) setList(previous => ({ scope, values: previous.scope === scope ? previous.values : [], loading: false, error })); });
    return () => { alive = false; controller.abort(); };
  }, [projectId, chapterId, scope, refreshKey, retry]);

  useEffect(() => {
    if (!detailId) return;
    const controller = new AbortController(); let alive = true;
    setDetail(previous => previous.scope === scope && previous.id === detailId ? { ...previous, error: '' } : { scope, id: detailId, value: null, error: '' });
    api<{ version: VideoVersionDetail }>(`/api/projects/${projectId}/videos/${detailId}`, { signal: controller.signal })
      .then(result => { if (alive && currentScope.current === scope && result.version.id === detailId && result.version.chapterId === chapterId) setDetail({ scope, id: detailId, value: result.version, error: '' }); })
      .catch(error => { if (alive && currentScope.current === scope) setDetail({ scope, id: detailId, value: null, error }); });
    return () => { alive = false; controller.abort(); };
  }, [projectId, chapterId, scope, detailId, retry]);

  const choose = useCallback((id: string) => setSelection({ scope, id }), [scope]);
  const reload = useCallback(() => setRetry(value => value + 1), []);
  const value = detail.scope === scope && detail.id === detailId ? detail.value : null;
  const detailError = detail.scope === scope && detail.id === detailId ? detail.error : '';
  const failure = detailError || (list.scope === scope ? list.error : '');
  return { selectedId, selected, versions, detail: value, listLoading: list.scope !== scope || list.loading, detailLoading: Boolean(detailId && !value && !detailError), error: failure ? errorMessage(failure, locale) : '', choose, reload };
}
