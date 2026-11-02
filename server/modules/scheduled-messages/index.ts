// The HTTP surface for scheduling a message to a session, mounted by the app.
export { default as scheduledMessagesRoutes } from './scheduled-messages.routes.js';

// The timer that sends them, started and stopped with the server.
export {
  initializeScheduledMessageDispatcher,
  closeScheduledMessageDispatcher,
  // 대기열을 지금 한 번 비운다. 타이머를 기다리지 않고 확인하는 테스트가 쓴다.
  dispatchQueuedMessages,
  // 지금 때가 된 예약을 한 번 보낸다. 룸으로 가는 예약을 확인하는 테스트가 쓴다.
  dispatchDueScheduledMessages,
} from './services/scheduled-message-dispatcher.service.js';

// 예약을 거는 쪽. `/예약` 명령이 쓴다.
export { scheduledMessagesService } from './services/scheduled-messages.service.js';
