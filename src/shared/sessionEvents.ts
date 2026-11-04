/**
 * 사이드바 밖에서 세션을 보관함으로 옮겼을 때 알리는 창 이벤트. `detail` 은
 * 세션 id 다. 사이드바는 `session_upserted` 만 받아 목록을 고치므로, 보관한
 * 쪽이 이것을 쏴야 그 행이 목록에서 바로 빠진다.
 */
export const SESSION_ARCHIVED_EVENT = 'session-archived';

export function announceSessionArchived(sessionId: string): void {
  window.dispatchEvent(new CustomEvent<string>(SESSION_ARCHIVED_EVENT, { detail: sessionId }));
}
