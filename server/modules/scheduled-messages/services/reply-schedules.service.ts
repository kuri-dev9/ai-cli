import { roomsDb, scheduledMessagesDb } from '@/modules/database/index.js';
import { chatRunRegistry } from '@/modules/websocket/index.js';
import { parseScheduleCancels, parseScheduleLines, shortScheduleId } from '@/shared/schedule-time.js';
import type { NormalizedMessage } from '@/shared/types.js';

/**
 * 일반 대화에서 AI 가 답에 남긴 예약 줄을 앱 예약으로 건다.
 *
 * "1분 뒤에 테스트 한번 찍어 줘" 같은 부탁을 받은 AI 는 예약할 길이 없어
 * Claude Code 에 내장된 `CronCreate` 를 썼다. 그 예약은 그 CLI 프로세스 안에만
 * 있어(`session-only`) 앱의 예약 목록에 보이지 않고, 프로세스가 끝나거나 서버가
 * 다시 뜨면 사라진다. 그래서 내장 도구는 막고(Claude 런타임), 대신 답에
 * `[예약 14:50] 할 일` 줄을 남기게 한 뒤 실행이 끝날 때 여기서 읽어 건다 —
 * `/예약` 과 같은 저장소라 목록에 보이고 재시작에도 남는다.
 *
 * 룸 참가자의 세션은 건너뛴다. 룸 차례는 턴 엔진이 같은 규칙으로 읽어 룸 앞으로
 * 건다 — 여기서도 읽으면 같은 예약이 두 번 걸린다.
 */
export function scheduleFromSettledRun(sessionId: string): void {
  if (roomsDb.getParticipantBySession(sessionId)) {
    return;
  }
  const run = chatRunRegistry.getRun(sessionId);
  if (!run || run.status !== 'completed') {
    return;
  }

  const text = (chatRunRegistry.replayEvents(sessionId, 0) as NormalizedMessage[])
    .filter((event) => event.kind === 'text' && event.role === 'assistant' && event.content?.trim())
    .map((event) => event.content!.trim())
    .join('\n\n');
  if (!text.includes('[')) {
    return;
  }

  const pending = scheduledMessagesDb.listPendingForSession(sessionId);

  // 지우기를 먼저 한다. "지우고 새로 걸기" 가 한 답에 함께 오면 새 예약이 남아야 한다.
  for (const shortId of parseScheduleCancels(text)) {
    // 두 개 이상에 걸리는 번호는 무엇을 지울지 모르므로 손대지 않는다.
    const matches = pending.filter((row) => shortScheduleId(row.id).startsWith(shortId));
    if (matches.length === 1) {
      scheduledMessagesDb.cancel(matches[0].user_id, matches[0].id);
    }
  }

  const schedules = parseScheduleLines(text, new Date());
  if (schedules.length === 0) {
    return;
  }
  const userId = Number(run.userId);
  if (!Number.isInteger(userId)) {
    console.warn('[ScheduledMessages] 예약을 건 사용자를 알 수 없어 답의 예약을 걸지 않았습니다', { sessionId });
    return;
  }
  const stillPending = scheduledMessagesDb.listPendingForSession(sessionId);
  const sameMinute = (a: Date, b: Date) => Math.floor(a.getTime() / 60_000) === Math.floor(b.getTime() / 60_000);
  for (const schedule of schedules) {
    // 이미 걸린 것과 같은 분·같은 할 일이면 다시 걸지 않는다.
    if (stillPending.some((row) => row.content === schedule.task && sameMinute(new Date(row.scheduled_for), schedule.at))) {
      continue;
    }
    stillPending.push(scheduledMessagesDb.create({
      userId,
      sessionId,
      content: schedule.task,
      options: { scheduledByReply: true },
      scheduledFor: schedule.at,
    }));
  }
}
