import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { RefreshCw, X } from 'lucide-react';

import { api } from '@/shared/api';
import type { CodeEditorFile } from '@/shared/types';
import type { OfficeKind } from '@/modules/code-editor/utils/previewableFile';

// 무거운 렌더러는 이 화면을 처음 열 때 불러온다. 첫 화면 번들에는 들어가지 않는다.
const DocxView = lazy(() => import('@/modules/code-editor/office/DocxView'));
const XlsxView = lazy(() => import('@/modules/code-editor/office/XlsxView'));

// "보기" 단추로 연 문서는 Claude 가 다시 생성하면 따라 갱신한다. 문서는 스크립트로
// 통째로 다시 쓰이는 일이 많고 바이트를 받아 비교해야 해서 텍스트보다 느슨하게 본다.
const LIVE_RELOAD_INTERVAL_MS = 5000;

type CodeEditorOfficePreviewProps = {
  file: CodeEditorFile;
  kind: OfficeKind;
  projectId?: string;
  isSidebar: boolean;
  onClose: () => void;
  labels: {
    loading: string;
    error: string;
    refresh: string;
    close: string;
    sheetTruncated: (rows: number, columns: number) => string;
    sheetEmpty: string;
  };
};

const digest = async (buffer: ArrayBuffer): Promise<string> => {
  const hash = await crypto.subtle.digest('SHA-1', buffer);
  return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, '0')).join('');
};

/** Word·Excel 문서를 그 프로그램에서 보는 모양에 가깝게 보여 준다. 읽기 전용이다. */
export default function CodeEditorOfficePreview({
  file,
  kind,
  projectId,
  isSidebar,
  onClose,
  labels,
}: CodeEditorOfficePreviewProps) {
  const [data, setData] = useState<ArrayBuffer | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const lastDigestRef = useRef<string | null>(null);

  const fetchBytes = useCallback(async (signal?: AbortSignal) => {
    if (!projectId) {
      throw new Error('Missing project identifier');
    }
    const response = await api.readFileBlob(projectId, file.path, { signal });
    if (!response.ok) {
      throw new Error(`Request failed with status ${response.status}`);
    }
    return response.arrayBuffer();
  }, [file.path, projectId]);

  const load = useCallback(async (signal?: AbortSignal) => {
    try {
      const buffer = await fetchBytes(signal);
      if (signal?.aborted) return;
      lastDigestRef.current = await digest(buffer);
      setData(buffer);
    } catch (loadError) {
      if (loadError instanceof Error && loadError.name === 'AbortError') return;
      console.error('Error loading office preview:', loadError);
      setData(null);
      setError(labels.error);
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, [fetchBytes, labels.error]);

  // 파일이 바뀌면 CodeEditor 가 key 로 이 컴포넌트를 새로 만든다. 그래서 처음 한 번만 읽는다.
  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  const reload = useCallback(() => {
    setLoading(true);
    setError(null);
    void load();
  }, [load]);

  // 보기 단추로 연 문서는 디스크에서 바뀌면 다시 그린다. 내용이 같으면 그대로 둔다.
  useEffect(() => {
    if (!file.document) {
      return undefined;
    }
    let cancelled = false;
    const timer = window.setInterval(() => {
      if (document.visibilityState !== 'visible' || lastDigestRef.current === null) return;
      void (async () => {
        try {
          const buffer = await fetchBytes();
          const nextDigest = await digest(buffer);
          if (cancelled || nextDigest === lastDigestRef.current) return;
          lastDigestRef.current = nextDigest;
          setData(buffer);
          setError(null);
        } catch {
          // 다시 쓰는 도중이라 잠깐 못 읽을 수 있다. 다음 차례에 다시 본다.
        }
      })();
    }, LIVE_RELOAD_INTERVAL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [fetchBytes, file.document]);

  const handleRenderError = useCallback((renderError: unknown) => {
    console.error('Error rendering office preview:', renderError);
    setError(labels.error);
  }, [labels.error]);

  const iconButtonClassName =
    'flex items-center justify-center rounded-md p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground';

  const body = (
    <div className="relative min-h-0 flex-1">
      {loading && !data && (
        <div className="flex h-full items-center justify-center text-sm text-muted-foreground">{labels.loading}</div>
      )}
      {error && (
        <div className="flex h-full flex-col items-center justify-center gap-3 p-8 text-center text-muted-foreground">
          <p className="text-sm">{error}</p>
          <p className="break-all text-xs">{file.path}</p>
        </div>
      )}
      {data && !error && (
        <Suspense
          fallback={<div className="flex h-full items-center justify-center text-sm text-muted-foreground">{labels.loading}</div>}
        >
          {kind === 'docx' ? (
            <DocxView data={data} onError={handleRenderError} />
          ) : (
            <XlsxView
              data={data}
              onError={handleRenderError}
              labels={{ truncated: labels.sheetTruncated, empty: labels.sheetEmpty }}
            />
          )}
        </Suspense>
      )}
    </div>
  );

  const panel = (
    <div className="flex h-full w-full flex-col bg-background">
      <div className="flex flex-shrink-0 items-center justify-between border-b border-border px-3 py-1.5">
        <h3 className="min-w-0 flex-1 truncate text-sm font-medium text-foreground" title={file.path}>
          {file.name}
        </h3>
        <div className="flex shrink-0 items-center gap-0.5">
          <button
            type="button"
            onClick={reload}
            className={iconButtonClassName}
            aria-label={labels.refresh}
            title={labels.refresh}
          >
            <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
          </button>
          <button
            type="button"
            onClick={onClose}
            className={iconButtonClassName}
            aria-label={labels.close}
            title={labels.close}
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      </div>
      {body}
    </div>
  );

  if (isSidebar) {
    return panel;
  }

  // 모바일 등 사이드 패널이 아닐 때는 화면을 채운다.
  return <div className="fixed inset-0 z-[9999] flex flex-col bg-background">{panel}</div>;
}
