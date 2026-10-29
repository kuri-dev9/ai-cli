import { roomsDb } from '@/modules/database/index.js';
import type { RoomParticipantRow, RoomRow } from '@/modules/database/index.js';
import { providerModelsService, sessionsService } from '@/modules/providers/index.js';
import { broadcastRoomFrame } from '@/modules/rooms/services/room-broadcast.service.js';
import { toRoomParticipant } from '@/modules/rooms/services/room-records.service.js';
import type { LLMProvider, RoomParticipant } from '@/shared/types.js';

/**
 * 룸의 명단과 호출.
 *
 * 룸에 들어올 수 있는 멤버는 명단(`standby`)에 앉아 있다가 `@이름` 으로 불릴
 * 때 들어온다. 한 번도 불리지 않은 멤버는 세션조차 없어서 아무 비용도 들지
 * 않고, 처음 불릴 때 그 자리에서 세션이 생긴다. 두 번째부터는 같은 세션이
 * 다시 깨어나므로 지난번에 하던 이야기를 그대로 기억한다.
 *
 * 룸 서비스와 턴 엔진이 같이 쓰므로 한곳에 둔다 — 턴 엔진이 룸 서비스를
 * 부르면 두 모듈이 서로를 참조하게 된다.
 */

/**
 * 참가자를 위한 세션을 만든다. 이름은 "이름 · 역할" 이다 — 사이드바가 룸
 * 아래에 접어 보여 주므로 어느 룸인지는 따로 적지 않는다. 모델을 골랐다면
 * 세션에 적어 둔다 — 그 세션을 따로 열었을 때도 같은 모델로 이어진다.
 */
export function createParticipantSession(
  provider: LLMProvider,
  projectPath: string,
  displayName: string,
  roleName: string,
  model: string | null,
): string {
  const { sessionId } = sessionsService.createAppSession(provider, projectPath, `${displayName} · ${roleName}`);
  sessionsService.renameSessionById(sessionId, `${displayName} · ${roleName}`);
  if (model) {
    providerModelsService.setSessionModel(provider, sessionId, model);
  }
  return sessionId;
}

/**
 * 명단 멤버를 불러온다. 세션이 없으면 여기서 만든다.
 *
 * 이미 들어와 있는 참가자를 부르면 아무것도 하지 않고 그대로 돌려준다 —
 * 상주 참가자에게 넘기는 평범한 차례도 이 함수를 지나기 때문이다.
 */
export function summonParticipant(room: RoomRow, participant: RoomParticipant): RoomParticipant {
  if (participant.status === 'active' || participant.status === 'summoned') {
    return participant;
  }

  const sessionId = participant.sessionId
    ?? createParticipantSession(
      participant.provider as LLMProvider,
      room.project_path,
      participant.displayName,
      participant.roleName,
      participant.model,
    );
  roomsDb.setParticipantStatus(participant.participantId, 'summoned', sessionId);
  // 화면이 이 멤버를 아직 "대기" 로 그리고 있다. 들어왔다는 것과, 처음이라면
  // 세션이 생겼다는 것까지 알려야 칩이 제대로 바뀌고 세션도 열 수 있다.
  broadcastRoomFrame({ kind: 'room_updated', roomId: room.room_id });
  return { ...participant, sessionId, status: 'summoned' };
}

/** 불려 와 일하던 멤버를 모두 대기로 돌려보낸다. 라운드가 끝날 때 부른다. */
export function returnSummonedToStandby(roomId: string): void {
  roomsDb.returnSummonedToStandby(roomId);
  broadcastRoomFrame({ kind: 'room_updated', roomId });
}

/** 지금 차례가 돌아오는 참가자. 명단에서 기다리는 멤버는 빠진다. */
export function listActiveParticipants(room: RoomRow): RoomParticipant[] {
  return roomsDb
    .listParticipants(room.room_id)
    .map((row: RoomParticipantRow) => toRoomParticipant(row, room))
    .filter((participant) => participant.status !== 'standby');
}

/** 룸에 속한 전원. 명단에서 기다리는 멤버까지 포함한다. */
export function listRoster(room: RoomRow): RoomParticipant[] {
  return roomsDb.listParticipants(room.room_id).map((row: RoomParticipantRow) => toRoomParticipant(row, room));
}

/** 명단에서 기다리는 멤버만. 프롬프트에 "부를 수 있는 멤버"로 적는다. */
export function listStandbyMembers(room: RoomRow): RoomParticipant[] {
  return listRoster(room).filter((participant) => participant.status === 'standby');
}
