// 텔레그램에서 명령을 받아 세션에 넣고, 결과를 돌려보내는 브리지.
// long polling 만 쓰므로 인바운드 포트를 열지 않는다.
export {
  claimRelayHandoff,
  closeTelegramBridge,
  initializeTelegramBridge,
  isTelegramBridgeRunning,
  releaseRelayHandoff,
  restartTelegramBridge,
  shouldRelayCompletion,
} from '@/modules/telegram-bridge/services/telegram-bridge.service.js';
export { handleTelegramCommand } from '@/modules/telegram-bridge/services/telegram-commands.service.js';
export {
  discoverTelegramChats,
  truncateForTelegram,
} from '@/modules/telegram-bridge/services/telegram-client.service.js';
export type {
  TelegramChatDiscovery,
  TelegramDiscoveredChat,
} from '@/modules/telegram-bridge/services/telegram-client.service.js';
// 설정 화면이 토큰과 chat id 를 넣고 연결을 확인하는 라우터.
export { default as telegramRoutes, createTelegramRouter } from '@/modules/telegram-bridge/telegram.routes.js';
