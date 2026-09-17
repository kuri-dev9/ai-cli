// The HTTP surface for scheduling a message to a session, mounted by the app.
export { default as scheduledMessagesRoutes } from './scheduled-messages.routes.js';

// The timer that sends them, started and stopped with the server.
export {
  initializeScheduledMessageDispatcher,
  closeScheduledMessageDispatcher,
  // 대기열을 지금 한 번 비운다. 타이머를 기다리지 않고 확인하는 테스트가 쓴다.
  dispatchQueuedMessages,
} from './services/scheduled-message-dispatcher.service.js';
