import { useFrontendBuildRefresh } from '@/shared/hooks/useFrontendBuildRefresh';

/**
 * 서버가 다시 빌드되면 이 탭을 새로고침한다. 그리는 것은 없다.
 *
 * 훅이 소켓 컨텍스트를 읽어야 해서 `WebSocketProvider` 안쪽에 들어갈 자리가
 * 필요할 뿐이다. 배너와 나란히 두는 이유도 같다 — 둘 다 서버 쪽 변화에
 * 반응해 화면을 추스르는 일을 한다.
 */
export function FrontendBuildRefresh() {
  useFrontendBuildRefresh();
  return null;
}
