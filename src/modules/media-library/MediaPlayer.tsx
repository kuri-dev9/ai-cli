import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { formatFileSize } from '@/modules/file-tree';
import { formatMediaDate, formatMediaDuration } from '@/modules/media-library/utils/mediaMeta';
import { useAudioVisualizer } from '@/modules/media-library/hooks/useAudioVisualizer';
import { useMediaFileMetadata } from '@/modules/media-library/hooks/useMediaFileMetadata';
import { mediaStreamUrl } from '@/shared/api';

type MediaPlayerProps = {
  filePath: string;
  /** 머리글에 보일 이름. 보통 파일명이고, 목록에서는 하위 경로까지다. */
  label: string;
  kind: 'audio' | 'video';
  /** 목록에서 이미 아는 값. 없으면 응답 헤더에서 읽는다. */
  size?: number | null;
  modifiedAt?: string | null;
  autoPlay?: boolean;
};

/**
 * 한 파일을 머리글과 함께 재생한다. 채팅 본문과 미디어 패널이 같이 쓴다.
 *
 * 길이는 브라우저가 메타데이터를 읽은 뒤에야 알 수 있으므로 늦게 채워진다.
 * 크기·수정일은 목록에서 왔으면 그대로 쓰고, 아니면 HEAD 로 한 번 가져온다.
 */
export default function MediaPlayer({
  filePath,
  label,
  kind,
  size = null,
  modifiedAt = null,
  autoPlay = false,
}: MediaPlayerProps) {
  const { t, i18n } = useTranslation();
  const [durationSeconds, setDurationSeconds] = useState<number | null>(null);
  const metadata = useMediaFileMetadata(filePath, { size, modifiedAt });
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  // 영상은 화면이 이미 움직이고 있으므로 막대를 덧붙이지 않는다.
  useAudioVisualizer(audioRef, canvasRef, kind === 'audio');

  // 열 때마다 만든다 — 토큰이 갱신된 뒤 열어도 새 토큰을 쓴다.
  const streamUrl = mediaStreamUrl(filePath);
  if (!streamUrl) {
    // 토큰이 없으면 어차피 401 이다. 앱의 만료 처리가 이어받는다.
    return null;
  }

  const facts = [
    metadata.size === null ? null : formatFileSize(metadata.size),
    formatMediaDuration(durationSeconds),
    formatMediaDate(metadata.modifiedAt, i18n.language),
  ].filter((fact): fact is string => Boolean(fact));

  const elementProps = {
    src: streamUrl,
    controls: true,
    autoPlay,
    preload: 'metadata' as const,
    onLoadedMetadata: (event: { currentTarget: HTMLMediaElement }) => {
      setDurationSeconds(event.currentTarget.duration);
    },
  };

  return (
    <span className="block">
      <span className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5 px-0.5 pb-1">
        <span className="min-w-0 truncate font-medium text-foreground" title={filePath}>
          {label}
        </span>
        {facts.length > 0 && (
          <span className="shrink-0 text-xs text-muted-foreground">{facts.join(' · ')}</span>
        )}
      </span>

      {kind === 'video' ? (
        <video {...elementProps} className="max-h-64 w-full max-w-xl rounded-md bg-black">
          {t('mediaLibrary.unsupported')}
        </video>
      ) : (
        <>
          <canvas
            ref={canvasRef}
            aria-hidden="true"
            className="block h-8 w-full max-w-xl text-blue-500/70 dark:text-blue-400/70"
          />
          <audio ref={audioRef} {...elementProps} className="w-full max-w-xl">
            {t('mediaLibrary.unsupported')}
          </audio>
        </>
      )}
    </span>
  );
}
