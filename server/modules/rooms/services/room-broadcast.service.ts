import { connectedClients, WS_OPEN_STATE } from '@/modules/websocket/index.js';
import type { RoomMessage, RoomRuntimeState } from '@/shared/types.js';

type RoomFrame =
  | { kind: 'room_message'; roomId: string; message: RoomMessage }
  | { kind: 'room_state'; roomId: string; state: RoomRuntimeState }
  | { kind: 'room_updated'; roomId: string };

/**
 * 룸 소식을 열려 있는 모든 화면에 보낸다.
 *
 * 룸의 턴은 소켓 없이 시작되므로(`runDetachedChatTurn`) 그 턴을 요청한 화면이
 * 따로 없다. 그래서 모두에게 보내고, 화면이 `roomId` 로 걸러 듣는다. 사이드바의
 * 룸 표시도 같은 소식으로 갱신된다.
 */
export function broadcastRoomFrame(frame: RoomFrame): void {
  const payload = JSON.stringify({ ...frame, timestamp: new Date().toISOString() });
  connectedClients.forEach((client) => {
    if (client.readyState === WS_OPEN_STATE) {
      client.send(payload);
    }
  });
}
