import { useCallback, useEffect, useState } from 'react';

import { api } from '@/shared/api';

/**
 * 지금 보고 있는 세션의 "이 작업 알림 받기" 토글.
 *
 * 값은 서버(브리지 상태)에 있다. 브라우저에만 두면 서버가 한 번 재시작하거나
 * 다른 기기에서 열었을 때 화면과 실제 동작이 어긋나고, 알림은 어긋난 것을
 * 알아채기 가장 어려운 기능이다.
 *
 * 브리지가 폴링 중이 아니면(`available === false`) 토글을 잠근다 — 켤 수는
 * 있는데 아무것도 오지 않는 상태가 가장 나쁘다.
 */

export type TelegramSessionNotificationsState = {
  /** 이 세션의 웹 작업까지 알림을 받기로 해 뒀는지. */
  enabled: boolean;
  /** 브리지가 실제로 돌고 있어서 토글이 의미가 있는지. */
  available: boolean;
  /** 봇 토큰이 저장돼 있는지. 잠긴 이유를 구분해 보여줄 때 쓴다. */
  hasToken: boolean;
  /** 설정 화면의 "브리지 사용" 스위치. */
  bridgeEnabled: boolean;
  /** 첫 조회가 끝나기 전. 이때는 토글을 그리되 만지지 못하게 둔다. */
  isLoading: boolean;
  setEnabled: (next: boolean) => void;
};

type SessionNotificationsResponse = {
  enabled?: boolean;
  available?: boolean;
  hasToken?: boolean;
  bridgeEnabled?: boolean;
};

const INITIAL: Omit<TelegramSessionNotificationsState, 'setEnabled' | 'isLoading'> = {
  enabled: false,
  available: false,
  hasToken: false,
  bridgeEnabled: false,
};

export function useTelegramSessionNotifications(
  sessionId: string | null,
): TelegramSessionNotificationsState {
  const [state, setState] = useState(INITIAL);
  const [isLoading, setIsLoading] = useState(Boolean(sessionId));

  useEffect(() => {
    if (!sessionId) {
      setState(INITIAL);
      setIsLoading(false);
      return;
    }

    let cancelled = false;
    setIsLoading(true);

    const load = async () => {
      try {
        const response = await api.telegram.sessionNotifications(sessionId);
        if (!response.ok) {
          throw new Error(`Failed to read telegram session notifications (${response.status})`);
        }
        const data = (await response.json()) as SessionNotificationsResponse;
        if (cancelled) {
          return;
        }
        setState({
          enabled: Boolean(data.enabled),
          available: Boolean(data.available),
          hasToken: Boolean(data.hasToken),
          bridgeEnabled: Boolean(data.bridgeEnabled),
        });
      } catch (error) {
        // 알림 토글 하나 때문에 설정 패널이 깨질 이유는 없다. 읽지 못하면
        // 꺼진 채로 잠가 둔다.
        console.error('Error reading telegram session notifications:', error);
        if (!cancelled) {
          setState(INITIAL);
        }
      } finally {
        if (!cancelled) {
          setIsLoading(false);
        }
      }
    };

    void load();
    return () => {
      cancelled = true;
    };
  }, [sessionId]);

  const setEnabled = useCallback(
    (next: boolean) => {
      if (!sessionId) {
        return;
      }

      // 먼저 화면을 바꾸고 저장한다. 체크박스가 왕복 시간만큼 굳어 있으면
      // 눌리지 않은 것처럼 보여서 한 번 더 누르게 된다.
      setState((previous) => ({ ...previous, enabled: next }));

      void (async () => {
        try {
          const response = await api.telegram.saveSessionNotifications(sessionId, next);
          if (!response.ok) {
            throw new Error(`Failed to save telegram session notifications (${response.status})`);
          }
          const data = (await response.json()) as SessionNotificationsResponse;
          setState((previous) => ({
            ...previous,
            enabled: Boolean(data.enabled),
            available: Boolean(data.available),
            hasToken: Boolean(data.hasToken),
            bridgeEnabled: Boolean(data.bridgeEnabled),
          }));
        } catch (error) {
          console.error('Error saving telegram session notifications:', error);
          // 저장이 실패했으면 켜진 것처럼 남겨 두지 않는다.
          setState((previous) => ({ ...previous, enabled: !next }));
        }
      })();
    },
    [sessionId],
  );

  return { ...state, isLoading, setEnabled };
}
