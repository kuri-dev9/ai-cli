import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2, Wifi, WifiOff } from 'lucide-react';

import { useWebSocket } from '@/shared/context/WebSocketContext';
import { cn } from '@/shared/utils';

/**
 * 서버와의 연결이 끊겼다는 것을 화면에 알린다.
 *
 * 소켓이 끊기면 실행 중 표시도, 완료 알림도, 멈춤 버튼도 함께 멎는다. 그런데
 * 그 사실을 알리는 곳이 없어서, 화면만 보면 "작업이 조용히 끝났다"와 "서버가
 * 죽었다"가 똑같아 보인다. 서버가 재시작되는 동안 오지 않을 답을 기다리며
 * 앉아 있게 되는 것이 이 배너가 없애려는 상황이다.
 *
 * 연결이 멀쩡할 때는 아무것도 그리지 않는다 — 정상을 알리는 배지는 금세 배경이
 * 되어, 정작 끊겼을 때의 변화를 못 보게 만든다.
 */

/** `idle` 은 그리지 않는 상태다. 정상일 때 화면에 남는 것이 없어야 한다. */
type ConnectionPhase = 'idle' | 'offline' | 'restored';

/**
 * 새로고침 직후에는 소켓이 붙기 전 짧은 공백이 있다. 그 순간까지 배너로 알리면
 * 페이지를 열 때마다 경고가 깜빡인다. 이 시간을 넘겨서도 못 붙을 때만 알린다.
 */
const OFFLINE_GRACE_MS = 1000;

/** 복귀 안내가 화면에 남는 시간. 읽을 만큼만 두고 스스로 사라진다. */
const RESTORED_VISIBLE_MS = 4000;

export function ConnectionStatusBanner() {
  const { isConnected } = useWebSocket();
  const { t } = useTranslation('common');
  const [phase, setPhase] = useState<ConnectionPhase>('idle');

  useEffect(() => {
    if (!isConnected) {
      const timer = setTimeout(() => setPhase('offline'), OFFLINE_GRACE_MS);
      return () => clearTimeout(timer);
    }

    // 끊겼다는 것을 이미 알린 뒤에만 복귀를 알린다. 첫 연결은 알릴 일이 아니다.
    setPhase((previous) => (previous === 'offline' ? 'restored' : 'idle'));
    return undefined;
  }, [isConnected]);

  useEffect(() => {
    if (phase !== 'restored') {
      return undefined;
    }
    const timer = setTimeout(() => setPhase('idle'), RESTORED_VISIBLE_MS);
    return () => clearTimeout(timer);
  }, [phase]);

  if (phase === 'idle') {
    return null;
  }

  const isOffline = phase === 'offline';

  return (
    <div
      // 레이아웃에 끼어들지 않게 띄운다. 이 배너 때문에 아래 내용이 밀리면
      // 끊길 때마다 화면 전체가 한 번씩 흔들린다.
      className="pointer-events-none fixed inset-x-0 top-0 z-50 flex justify-center p-2"
    >
      <div
        role="status"
        // 끊김은 사용자가 기다림을 멈추고 조치해야 하는 상태라 즉시 읽어 준다.
        aria-live={isOffline ? 'assertive' : 'polite'}
        className={cn(
          'pointer-events-auto flex items-center gap-2 rounded-full border px-3 py-1.5 text-xs shadow-sm',
          isOffline
            ? 'border-amber-500/40 bg-amber-50 text-amber-900 dark:bg-amber-950 dark:text-amber-100'
            : 'border-green-500/40 bg-green-50 text-green-900 dark:bg-green-950 dark:text-green-100',
        )}
      >
        {isOffline ? (
          <>
            <WifiOff className="h-3.5 w-3.5 shrink-0" />
            <span>{t('connection.offline', { defaultValue: '서버와 연결이 끊겼습니다' })}</span>
            <Loader2 className="h-3 w-3 shrink-0 animate-spin" />
            <span className="text-amber-700 dark:text-amber-300">
              {t('connection.retrying', { defaultValue: '다시 연결하는 중' })}
            </span>
          </>
        ) : (
          <>
            <Wifi className="h-3.5 w-3.5 shrink-0" />
            <span>{t('connection.restored', { defaultValue: '다시 연결되었습니다' })}</span>
          </>
        )}
      </div>
    </div>
  );
}

export default ConnectionStatusBanner;
