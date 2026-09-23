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
// 폰으로 넘어간 턴에 얼마나 허용할지. 설정 화면이 읽고 쓴다.
export {
  parseTelegramPermissionMode,
  readTelegramPermissionMode,
  resolveTelegramRunPermissions,
  TELEGRAM_PERMISSION_MODE_KEY,
  TELEGRAM_PERMISSION_MODES,
  TELEGRAM_READ_ONLY_TOOLS,
} from './services/chat-websocket.service.js';
export type { TelegramPermissionMode } from './services/chat-websocket.service.js';
export type { ProviderRuntimeGateway } from './services/chat-websocket.service.js';
