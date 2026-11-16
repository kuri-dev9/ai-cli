// 세션을 로그인 없이 바깥에 여는 공유 링크.
// 주인 쪽(링크 만들기·끊기)과 게스트 쪽(읽기·질문)을 따로 마운트한다.
export {
  default as sessionShareRoutes,
  createGuestShareRouter,
  createSessionShareRouter,
} from '@/modules/session-share/session-share.routes.js';
export {
  readGuestEvents,
  readGuestSnapshot,
  sendGuestMessage,
  toGuestMessage,
} from '@/modules/session-share/services/session-share.service.js';
