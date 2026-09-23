import { chatRunRegistry } from '@/modules/websocket/services/chat-run-registry.service.js';
import { connectedClients, WS_OPEN_STATE } from '@/modules/websocket/services/websocket-state.service.js';

/**
 * 브라우저 밖에서 시작된 턴을 열려 있는 화면에 알린다.
 *
 * 턴의 이벤트는 그 턴을 요청한 소켓으로만 나간다. 그래서 텔레그램이나 예약
 * 메시지처럼 소켓 없이 시작된 턴(`runDetachedChatTurn`)은, 이미 그 세션을 열어
 * 둔 브라우저에 아무것도 전달되지 않는다. 화면은 조용한데 뒤에서는 작업이
 * 돌고 있으니, 사용자는 명령이 먹었는지 알 길이 없어 같은 말을 한 번 더 보내게
 * 된다.
 *
 * 알림을 받은 화면은 그 세션을 다시 구독해서 이 턴의 이벤트와 승인 요청을
 * 넘겨받는다. 그래서 시작 알림은 아직 이 실행을 보고 있지 않은 화면에만 보낸다 —
 * 이미 붙어 있는 화면(그 턴을 시킨 브라우저)에까지 보내면, 그쪽이 다시 구독하며
 * 방금 받은 이벤트를 한 번 더 받아 같은 말이 두 번 그려진다.
 *
 * 종료 알림은 모두에게 보낸다. 표시등을 내리는 신호라서, 붙어 있든 아니든
 * 받아야 한다.
 */

let stopBroadcast: (() => void) | null = null;

function broadcastRunState(sessionId: string, isProcessing: boolean): void {
  const payload = JSON.stringify({
    kind: 'run_state',
    sessionId,
    isProcessing,
    timestamp: new Date().toISOString(),
  });

  connectedClients.forEach((client) => {
    if (client.readyState !== WS_OPEN_STATE) {
      return;
    }
    if (isProcessing && chatRunRegistry.isWatchedBy(sessionId, client)) {
      return;
    }
    client.send(payload);
  });
}

/**
 * 시작·종료 알림을 켠다. 두 번 불러도 리스너가 겹쳐 붙지 않는다.
 *
 * 반환값은 해제 함수다 — 테스트가 리스너를 남기지 않고 정리할 수 있어야 한다.
 */
export function initializeRunStateBroadcast(): () => void {
  if (stopBroadcast) {
    return stopBroadcast;
  }

  const offStarted = chatRunRegistry.onRunStarted((sessionId) => {
    broadcastRunState(sessionId, true);
  });
  const offSettled = chatRunRegistry.onRunSettled((sessionId) => {
    broadcastRunState(sessionId, false);
  });

  stopBroadcast = () => {
    offStarted();
    offSettled();
    stopBroadcast = null;
  };
  return stopBroadcast;
}
