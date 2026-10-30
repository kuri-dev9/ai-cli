import { useEffect, useRef } from 'react';

import { useWebSocket } from '@/shared/context/WebSocketContext';

/**
 * 서버가 새 번들을 내보내기 시작하면 이 탭을 새로고침한다.
 *
 * `./run.sh restart` 는 빌드를 먼저 하고 서버를 올리지만, 그것으로 끝나지
 * 않는다. 이미 열려 있는 탭은 자기가 받아 둔 예전 번들을 계속 돌린다. 이 앱은
 * 소켓으로 붙어 있어 화면이 멀쩡히 살아 있으므로 새로고침할 까닭을 느끼지
 * 못하고, "분명 고쳤는데 그대로네"가 반복된다. 고친 사람과 쓰는 사람이 같을
 * 때 특히 오래 헤매는 함정이다.
 *
 * 비교 대상은 `index.html` 의 엔트리 스크립트 파일명이다. vite 가 내용 해시를
 * 담아 짓는 이름이라 빌드 하나를 정확히 가리키고, 서버도 같은 파일에서 같은
 * 값을 읽어 `/health` 로 돌려준다 — 양쪽이 같은 것을 보고 있다.
 */

/** 이 문서가 띄운 엔트리 번들의 파일명. 못 찾으면 비교를 포기한다. */
function loadedBuildId(): string | null {
  const src = document
    .querySelector('script[type="module"][src]')
    ?.getAttribute('src');
  return src ? src.split('/').pop() || null : null;
}

export function useFrontendBuildRefresh(): void {
  const { subscribe } = useWebSocket();
  // 새로고침은 되돌릴 수 없다. 연달아 들어온 신호가 reload 를 두 번 부르지
  // 않도록 막는다.
  const reloadingRef = useRef(false);

  useEffect(() => {
    // dev 서버는 HMR 이 같은 일을 더 잘 한다. 게다가 그때의 엔트리는
    // `/src/main.tsx` 라 `dist/` 를 읽는 서버 쪽 값과 애초에 맞지 않는다.
    if (import.meta.env.DEV) {
      return undefined;
    }

    const loaded = loadedBuildId();
    if (!loaded) {
      return undefined;
    }

    const checkForNewBuild = async () => {
      if (reloadingRef.current) {
        return;
      }

      try {
        const response = await fetch('/health', { cache: 'no-store' });
        if (!response.ok) {
          return;
        }

        const payload = await response.json();
        const served = typeof payload?.frontendBuildId === 'string'
          ? payload.frontendBuildId
          : null;
        // 빌드가 없는 서버(dist 미생성)는 null 을 준다. 모르는 것을 근거로
        // 새로고침하지 않는다.
        if (!served || served === loaded) {
          return;
        }

        reloadingRef.current = true;
        window.location.reload();
      } catch {
        // 서버가 아직 안 떴거나 재시작 중이다. 소켓이 다시 붙을 때 또 본다.
      }
    };

    void checkForNewBuild();

    // 서버 재시작은 곧 소켓 재연결이다. 새 빌드가 올라왔는지 묻기에 가장
    // 정확한 순간이라, 주기적으로 두드릴 이유가 없다.
    const unsubscribe = subscribe((event) => {
      if (event.kind === 'websocket_reconnected') {
        void checkForNewBuild();
      }
    });

    // 소켓이 끊긴 적 없이 빌드만 바뀐 경우(`./run.sh build`)를 위한 보조
    // 경로다. 탭으로 돌아오는 순간은 새로고침해도 가장 덜 거슬린다.
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        void checkForNewBuild();
      }
    };
    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      unsubscribe();
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [subscribe]);
}
