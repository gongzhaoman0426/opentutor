'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { GenerationSettings, SpeechResult } from '@/shared/schema';
import { api, errorMessage } from './api';
import { useI18n } from '@/i18n/provider';

export function useVoicePreview({ language, voice, rate }: Pick<GenerationSettings, 'language' | 'voice' | 'rate'>) {
  const { locale } = useI18n('settings');
  const audio = useRef<HTMLAudioElement>(null);
  const request = useRef<{ sequence: number; controller?: AbortController }>({ sequence: 0 });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [result, setResult] = useState<{ key: string; speech: SpeechResult } | null>(null);
  const key = JSON.stringify([language, voice, rate]);
  const speech = result?.key === key ? result.speech : null;

  const invalidate = useCallback(() => {
    request.current.sequence++;
    request.current.controller?.abort();
    request.current.controller = undefined;
    audio.current?.pause();
  }, []);
  const cancel = useCallback(() => {
    invalidate();
    setResult(null); setBusy(false); setError(null);
  }, [invalidate]);

  // Also handles a parent replacing saved settings, not only local select changes.
  useEffect(() => { cancel(); return invalidate; }, [key, cancel, invalidate]);
  useEffect(() => { if (speech) audio.current?.play().catch(() => {}); }, [speech]);

  const preview = async () => {
    cancel();
    const sequence = request.current.sequence;
    const controller = new AbortController();
    request.current.controller = controller;
    setBusy(true);
    try {
      const response = await api<{ speech: SpeechResult }>('/api/voices/preview', { method: 'POST', body: JSON.stringify({ voice, rate }), signal: controller.signal });
      if (request.current.sequence === sequence && !controller.signal.aborted) setResult({ key, speech: response.speech });
    } catch (failure) {
      if (request.current.sequence === sequence && !controller.signal.aborted) setError(failure);
    } finally {
      if (request.current.sequence === sequence) { request.current.controller = undefined; setBusy(false); }
    }
  };

  return { audio, speech, busy, error: error ? errorMessage(error, locale) : '', preview, cancel };
}
