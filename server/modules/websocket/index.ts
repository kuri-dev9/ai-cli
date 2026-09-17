export { WS_OPEN_STATE, connectedClients } from './services/websocket-state.service.js';
export { createWebSocketServer } from './services/websocket-server.service.js';
export { chatRunRegistry } from './services/chat-run-registry.service.js';
// 실행의 출처. 텔레그램 브리지가 "이 실행 결과를 돌려보낼지"를 이걸로 정한다.
export type { ChatRunOrigin } from './services/chat-run-registry.service.js';
// Consumed by the providers module's sessions watcher, which announces the
// sessions it (re)indexed from disk through the same builder the chat gateway
// uses, so both paths put the identical delta on the wire.
export { broadcastSessionUpserted, broadcastSessionUpsertedBatch } from './services/session-upsert-broadcast.service.js';
export { initializeRunStateBroadcast } from './services/run-state-broadcast.service.js';
// runDetachedChatTurn: used by the scheduled-messages module to run a turn
// from a timer, with no socket to stream to or report errors on.
export { runDetachedChatTurn } from './services/chat-websocket.service.js';
// `/bot` 접두어: 웹에서 시작한 실행 하나만 텔레그램으로 중계해 달라는 표시.
// 판정과 제거는 서버(dispatchRun)에서 하고, 화면은 같은 이름의 슬래시 명령을
// 목록에 보여 주기만 한다.
export { parseTelegramRelayPrefix, TELEGRAM_RELAY_PREFIX } from './services/chat-websocket.service.js';
export type { ProviderRuntimeGateway } from './services/chat-websocket.service.js';
