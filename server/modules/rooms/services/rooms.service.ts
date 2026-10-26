import { randomUUID } from 'node:crypto';

import { roomsDb, sessionsDb } from '@/modules/database/index.js';
import type { RoomRow } from '@/modules/database/index.js';
import {
  providerAuthService,
  providerModelsService,
  sessionsService,
} from '@/modules/providers/index.js';
import { broadcastRoomFrame } from '@/modules/rooms/services/room-broadcast.service.js';
import { isValidRoomDisplayName } from '@/modules/rooms/services/room-prompt.service.js';
import { createParticipantSession } from '@/modules/rooms/services/room-roster.service.js';
import {
  parseRoomPermissionMode,
  toRoomMessage,
  toRoomParticipant,
} from '@/modules/rooms/services/room-records.service.js';
import { roomTurnEngine } from '@/modules/rooms/services/room-turn-engine.service.js';
import { filterAttachmentsToUploadStore } from '@/modules/websocket/index.js';
import type {
  LLMProvider,
  RoomDetail,
  RoomMessage,
  RoomParticipant,
  RoomPermissionMode,
  RoomRuntimeState,
} from '@/shared/types.js';
import { AppError } from '@/shared/utils.js';

/**
 * 한 룸에 둘 수 있는 참가자 수. 원래 대화와 명단에서 기다리는 멤버를 모두
 * 포함한다.
 *
 * 명단 멤버는 불릴 때까지 세션도 토큰도 쓰지 않으므로 상주 시절보다 넉넉하다.
 * 그래도 상한을 두는 건 한 차례에 실리는 참가자 목록이 끝없이 길어지지 않게
 * 하려는 것이다.
 */
const MAX_ROOM_PARTICIPANTS = 10;

const DEFAULT_MAX_AUTO_TURNS = 6;
const MAX_AUTO_TURNS_LIMIT = 20;

const PROVIDER_LABELS: Record<string, string> = {
  claude: 'Claude',
  codex: 'Codex',
  cursor: 'Cursor',
  opencode: 'OpenCode',
};

/** 초대할 참가자. 라우트가 요청 본문을 이 모양으로 옮긴다. */
type ParticipantInput = {
  provider: string;
  model?: string | null;
  displayName: string;
  roleName: string;
  rolePrompt?: string | null;
  persona?: string | null;
  /**
   * `standby` 면 명단에만 담긴다. 세션도 그때 만들지 않고, `@이름` 으로 불릴
   * 때 들어온다. `active` 는 예전처럼 바로 들어와 매 차례를 함께 돈다.
   */
  status?: 'active' | 'standby' | null;
};

type HostInput = {
  displayName?: string | null;
  roleName?: string | null;
  rolePrompt?: string | null;
  persona?: string | null;
};

/** 룸 하나의 요약. 사이드바가 어떤 세션이 룸인지 표시하는 데 쓴다. */
type RoomIndexEntry = {
  roomId: string;
  hostSessionId: string;
  participants: Array<{
    participantId: string;
    /** 아직 불린 적 없는 명단 멤버는 null 이다. */
    sessionId: string | null;
    provider: string;
    displayName: string;
    roleName: string;
    isHost: boolean;
  }>;
};

function requireRoom(roomId: string): RoomRow {
  const room = roomsDb.getRoom(roomId);
  if (!room) {
    throw new AppError(`Room "${roomId}" was not found.`, { code: 'ROOM_NOT_FOUND', statusCode: 404 });
  }
  return room;
}

function buildDetail(room: RoomRow): RoomDetail {
  return {
    room: {
      roomId: room.room_id,
      hostSessionId: room.host_session_id,
      projectPath: room.project_path,
      permissionMode: parseRoomPermissionMode(room.permission_mode),
      maxAutoTurns: room.max_auto_turns,
      splitWork: room.split_work !== 0,
      discussion: room.discussion !== 0,
      createdAt: room.created_at,
    },
    participants: roomsDb.listParticipants(room.room_id).map((row) => toRoomParticipant(row, room)),
    formerParticipants: roomsDb.listFormerParticipants(room.room_id).map((row) => toRoomParticipant(row, room)),
    messages: roomsDb.listMessages(room.room_id).map(toRoomMessage),
    state: roomTurnEngine.getState(room.room_id, room.max_auto_turns),
  };
}

/** 이름이 비어 있으면 프로바이더 이름을 쓰고, 겹치면 숫자를 붙인다. */
function resolveDisplayName(requested: string | null | undefined, provider: string, taken: string[]): string {
  const takenLower = new Set(taken.map((name) => name.toLowerCase()));
  const base = requested?.trim() || PROVIDER_LABELS[provider] || provider;
  if (!isValidRoomDisplayName(base)) {
    throw new AppError('참가자 이름에는 공백, @, 대괄호를 쓸 수 없고 24자 이하여야 합니다.', {
      code: 'INVALID_DISPLAY_NAME',
      statusCode: 400,
    });
  }
  if (!takenLower.has(base.toLowerCase())) {
    return base;
  }
  if (requested?.trim()) {
    throw new AppError(`"${base}" 이름은 이 룸에서 이미 쓰고 있습니다.`, {
      code: 'DISPLAY_NAME_TAKEN',
      statusCode: 409,
    });
  }
  for (let suffix = 2; ; suffix += 1) {
    const candidate = `${base}${suffix}`;
    if (!takenLower.has(candidate.toLowerCase())) {
      return candidate;
    }
  }
}

function requireParticipant(roomId: string, participantId: string) {
  const participant = roomsDb.listParticipants(roomId).find((row) => row.participant_id === participantId);
  if (!participant) {
    throw new AppError('이 룸에 그런 참가자가 없습니다.', { code: 'PARTICIPANT_NOT_FOUND', statusCode: 404 });
  }
  return participant;
}

function requireRoleName(roleName: string | null | undefined): string {
  const trimmed = roleName?.trim() ?? '';
  if (!trimmed || trimmed.length > 40) {
    throw new AppError('역할 이름은 1~40자로 적어 주세요.', { code: 'INVALID_ROLE_NAME', statusCode: 400 });
  }
  return trimmed;
}

async function assertProviderUsable(provider: string): Promise<LLMProvider> {
  if (!sessionsService.listProviderIds().includes(provider as LLMProvider)) {
    throw new AppError(`"${provider}" 는 지원하지 않는 프로바이더입니다.`, {
      code: 'PROVIDER_UNAVAILABLE',
      statusCode: 400,
    });
  }
  let installed = false;
  try {
    installed = (await providerAuthService.getProviderAuthStatus(provider)).installed;
  } catch {
    installed = false;
  }
  if (!installed) {
    throw new AppError(`${PROVIDER_LABELS[provider] ?? provider} 가 이 컴퓨터에 설치되어 있지 않습니다.`, {
      code: 'PROVIDER_UNAVAILABLE',
      statusCode: 409,
    });
  }
  return provider as LLMProvider;
}


/** Rooms 라우트가 쓰는 룸 서비스. */
export const roomsService = {
  listRoomIndex(): RoomIndexEntry[] {
    const participantsByRoom = new Map<string, RoomIndexEntry['participants']>();
    const rooms = roomsDb.listRooms();
    const hostByRoom = new Map(rooms.map((room) => [room.room_id, room.host_session_id]));
    for (const row of roomsDb.listAllParticipants()) {
      const list = participantsByRoom.get(row.room_id) ?? [];
      list.push({
        participantId: row.participant_id,
        sessionId: row.session_id,
        provider: row.provider,
        displayName: row.display_name,
        roleName: row.role_name,
        isHost: row.session_id !== null && row.session_id === hostByRoom.get(row.room_id),
      });
      participantsByRoom.set(row.room_id, list);
    }
    return rooms.map((room) => ({
      roomId: room.room_id,
      hostSessionId: room.host_session_id,
      participants: participantsByRoom.get(room.room_id) ?? [],
    }));
  },

  getRoomDetail(roomId: string): RoomDetail {
    return buildDetail(requireRoom(roomId));
  },

  /** 이 세션이 호스트인 룸. 룸이 아니면 null — 화면이 일반 대화를 그린다. */
  getRoomDetailByHostSession(sessionId: string): RoomDetail | null {
    const room = roomsDb.getRoomByHostSession(sessionId);
    return room ? buildDetail(room) : null;
  },

  /**
   * 대화를 룸으로 바꾸고 첫 참가자를 초대한다. 원래 세션은 첫 참가자(호스트)로
   * 들어가 지금까지의 맥락을 그대로 가진다.
   */
  async createRoom(input: { hostSessionId: string; host?: HostInput; participant: ParticipantInput }): Promise<RoomDetail> {
    const hostSession = sessionsDb.getSessionById(input.hostSessionId);
    if (!hostSession) {
      throw new AppError(`Session "${input.hostSessionId}" was not found.`, { code: 'SESSION_NOT_FOUND', statusCode: 404 });
    }
    if (!hostSession.project_path) {
      throw new AppError('프로젝트 폴더가 없는 대화는 룸으로 바꿀 수 없습니다.', {
        code: 'PROJECT_PATH_REQUIRED',
        statusCode: 400,
      });
    }
    if (roomsDb.getParticipantBySession(input.hostSessionId)) {
      throw new AppError('이 대화는 이미 룸에 속해 있습니다.', { code: 'ALREADY_A_ROOM', statusCode: 409 });
    }

    const hostName = resolveDisplayName(input.host?.displayName, hostSession.provider, []);
    const hostRole = input.host?.roleName?.trim() ? requireRoleName(input.host.roleName) : '메인';
    const provider = await assertProviderUsable(input.participant.provider);
    const inviteeName = resolveDisplayName(input.participant.displayName, provider, [hostName]);
    const inviteeRole = requireRoleName(input.participant.roleName);
    const inviteeModel = input.participant.model?.trim() || null;

    const projectPath = hostSession.project_path;
    const inviteeSessionId = createParticipantSession(provider, projectPath, inviteeName, inviteeRole, inviteeModel);
    const roomId = randomUUID();

    roomsDb.createRoom(
      {
        roomId,
        hostSessionId: input.hostSessionId,
        projectPath,
        permissionMode: 'ask',
        maxAutoTurns: DEFAULT_MAX_AUTO_TURNS,
      },
      [
        {
          participant_id: randomUUID(),
          session_id: input.hostSessionId,
          provider: hostSession.provider,
          model: hostSession.model,
          display_name: hostName,
          role_name: hostRole,
          role_prompt: input.host?.rolePrompt?.trim() ?? '',
          persona: input.host?.persona?.trim() ?? '',
          status: 'active',
          position: 0,
        },
        {
          participant_id: randomUUID(),
          session_id: inviteeSessionId,
          provider,
          model: inviteeModel,
          display_name: inviteeName,
          role_name: inviteeRole,
          role_prompt: input.participant.rolePrompt?.trim() ?? '',
          persona: input.participant.persona?.trim() ?? '',
          status: 'active',
          position: 1,
        },
      ],
    );

    broadcastRoomFrame({ kind: 'room_updated', roomId });
    return this.getRoomDetail(roomId);
  },

  /**
   * 참가자를 들인다. 기본은 명단(`standby`)이라, 세션도 토큰도 그때는 들지
   * 않고 `@이름` 으로 불릴 때 들어온다. `active` 로 주면 예전처럼 바로 들어와
   * 매 차례를 함께 돈다.
   */
  async addParticipant(roomId: string, input: ParticipantInput): Promise<RoomDetail> {
    const room = requireRoom(roomId);
    const existing = roomsDb.listParticipants(roomId);
    if (existing.length >= MAX_ROOM_PARTICIPANTS) {
      throw new AppError(`한 룸에는 명단을 더해 최대 ${MAX_ROOM_PARTICIPANTS}명까지 둘 수 있습니다.`, {
        code: 'ROOM_FULL',
        statusCode: 409,
      });
    }

    const provider = await assertProviderUsable(input.provider);
    // 퇴장한 참가자의 이름도 표에 남아 있어 다시 쓸 수 없다.
    const takenNames = [...existing, ...roomsDb.listFormerParticipants(roomId)].map((row) => row.display_name);
    const displayName = resolveDisplayName(input.displayName, provider, takenNames);
    const roleName = requireRoleName(input.roleName);
    const model = input.model?.trim() || null;
    const status = input.status === 'active' ? 'active' : 'standby';
    // 명단에만 담는 멤버는 세션을 만들지 않는다. 한 번도 불리지 않으면 아무
    // 비용도 들지 않아야 명단을 넉넉히 둘 수 있다.
    const sessionId = status === 'active'
      ? createParticipantSession(provider, room.project_path, displayName, roleName, model)
      : null;

    roomsDb.addParticipant({
      participant_id: randomUUID(),
      room_id: roomId,
      session_id: sessionId,
      provider,
      model,
      display_name: displayName,
      role_name: roleName,
      role_prompt: input.rolePrompt?.trim() ?? '',
      persona: input.persona?.trim() ?? '',
      status,
      position: Math.max(...existing.map((row) => row.position), -1) + 1,
    });

    broadcastRoomFrame({ kind: 'room_updated', roomId });
    return this.getRoomDetail(roomId);
  },

  updateSettings(
    roomId: string,
    settings: {
      permissionMode?: RoomPermissionMode;
      maxAutoTurns?: number;
      splitWork?: boolean;
      discussion?: boolean;
    },
  ): RoomDetail {
    requireRoom(roomId);
    if (settings.maxAutoTurns !== undefined
      && (!Number.isInteger(settings.maxAutoTurns) || settings.maxAutoTurns < 1 || settings.maxAutoTurns > MAX_AUTO_TURNS_LIMIT)) {
      throw new AppError(`자동 턴 수는 1~${MAX_AUTO_TURNS_LIMIT} 사이여야 합니다.`, {
        code: 'INVALID_MAX_AUTO_TURNS',
        statusCode: 400,
      });
    }
    roomsDb.updateRoomSettings(roomId, settings);
    if (settings.permissionMode !== undefined) {
      // 룸 권한은 한 번에 바꾸는 것이다. 참가자별로 따로 둔 값이 남아 있으면
      // 그 사람만 예전 권한으로 돌아, 바꾼 줄 알았던 것이 안 바뀐다.
      roomsDb.clearParticipantPermissions(roomId);
    }
    broadcastRoomFrame({ kind: 'room_updated', roomId });
    return this.getRoomDetail(roomId);
  },

  /**
   * 참가자 한 명의 권한과 역할. 모델과 추론 강도는 그 참가자 세션에 적으므로
   * 여기서 다루지 않는다.
   *
   * 역할에 해당하는 칸이 달라지면 `role_dirty` 를 세워, 그 참가자가 다음 차례에
   * 바뀐 역할 안내를 다시 받게 한다. 이름이 바뀌었을 때는 룸 전체에 세운다 —
   * 다른 참가자들이 기억하는 `@이름` 이 더는 맞지 않기 때문이다.
   */
  updateParticipant(
    roomId: string,
    participantId: string,
    settings: {
      permissionMode?: RoomPermissionMode;
      displayName?: string;
      roleName?: string;
      rolePrompt?: string;
      persona?: string;
    },
  ): RoomDetail {
    const room = requireRoom(roomId);
    const current = requireParticipant(roomId, participantId);
    if (settings.permissionMode !== undefined) {
      roomsDb.updateParticipantPermission(participantId, settings.permissionMode);
    }

    const profile: { displayName?: string; roleName?: string; rolePrompt?: string; persona?: string } = {};
    if (settings.displayName !== undefined) {
      if (!settings.displayName.trim()) {
        throw new AppError('참가자 이름은 비울 수 없습니다.', { code: 'INVALID_DISPLAY_NAME', statusCode: 400 });
      }
      // 자기 이름은 겹침 검사에서 빼야 역할만 고치면서 이름을 그대로 둘 수 있다.
      const takenNames = [...roomsDb.listParticipants(roomId), ...roomsDb.listFormerParticipants(roomId)]
        .filter((row) => row.participant_id !== participantId)
        .map((row) => row.display_name);
      profile.displayName = resolveDisplayName(settings.displayName, current.provider, takenNames);
    }
    if (settings.roleName !== undefined) {
      profile.roleName = requireRoleName(settings.roleName);
    }
    if (settings.rolePrompt !== undefined) {
      profile.rolePrompt = settings.rolePrompt.trim();
    }
    if (settings.persona !== undefined) {
      profile.persona = settings.persona.trim();
    }

    const nameChanged = profile.displayName !== undefined && profile.displayName !== current.display_name;
    const roleChanged = nameChanged
      || (profile.roleName !== undefined && profile.roleName !== current.role_name)
      || (profile.rolePrompt !== undefined && profile.rolePrompt !== current.role_prompt)
      || (profile.persona !== undefined && profile.persona !== current.persona);

    roomsDb.updateParticipantProfile(participantId, profile, roleChanged);
    // 아직 불린 적 없는 명단 멤버는 세션이 없어 바꿀 이름도 없다.
    if ((nameChanged || profile.roleName !== undefined) && current.session_id) {
      // 세션 목록에 보이는 이름도 따라가야 어떤 대화가 누구인지 알아볼 수 있다.
      const name = profile.displayName ?? current.display_name;
      const role = profile.roleName ?? current.role_name;
      sessionsService.renameSessionById(current.session_id, `[룸] ${name} · ${role}`);
    }
    if (nameChanged) {
      for (const row of roomsDb.listParticipants(roomId)) {
        if (row.participant_id !== participantId) {
          roomsDb.updateParticipantProfile(row.participant_id, {}, true);
        }
      }
    }

    roomsDb.touchRoom(room.room_id);
    broadcastRoomFrame({ kind: 'room_updated', roomId });
    return this.getRoomDetail(roomId);
  },

  /**
   * 참가자를 차례에서 뺀다.
   *
   * 일한 적 있는 참가자는 **룸 안에 그대로 두고** 대기로만 돌린다. 세션을 룸
   * 밖으로 내보내면 그 대화가 프로젝트 목록에 평범한 세션으로 튀어나와, 룸을
   * 쓸수록 목록이 지저분해진다. 대기로 두면 사이드바에서는 여전히 룸 밑에
   * 접혀 있고, 차례만 돌아오지 않는다. `@이름` 으로 다시 부르면 그 세션이
   * 하던 이야기를 그대로 기억한 채 돌아온다.
   *
   * 한 번도 불린 적 없는 명단 멤버는 세션도 발언도 없으므로 아주 뺀다. 지울
   * 것이 이름뿐이라 그 이름을 바로 다시 쓸 수 있다.
   *
   * 호스트는 룸 자체여서 뺄 수 없고, 지금 차례를 쥔 참가자는 끝나거나 정지한
   * 뒤에만 뺄 수 있다.
   */
  removeParticipant(roomId: string, participantId: string): RoomDetail {
    const room = requireRoom(roomId);
    const participant = requireParticipant(roomId, participantId);
    if (participant.session_id === room.host_session_id) {
      throw new AppError('호스트는 룸에서 뺄 수 없습니다.', { code: 'HOST_CANNOT_LEAVE', statusCode: 400 });
    }
    if (roomTurnEngine.isSpeaking(roomId, participantId)) {
      throw new AppError('지금 답하고 있는 참가자입니다. 끝나거나 정지한 뒤 빼 주세요.', {
        code: 'PARTICIPANT_SPEAKING',
        statusCode: 409,
      });
    }
    if (participant.session_id) {
      roomsDb.setParticipantStatus(participantId, 'standby');
      roomsDb.touchRoom(roomId);
    } else {
      roomsDb.deleteParticipant(roomId, participantId);
    }
    broadcastRoomFrame({ kind: 'room_updated', roomId });
    return this.getRoomDetail(roomId);
  },

  /**
   * 사용자 글을 올린다. 첨부는 업로드 저장소 안의 파일만 남긴다. `hostCommand`
   * 는 슬래시 명령처럼 호스트 세션에서 그대로 돌릴 글이다.
   */
  postUserMessage(
    roomId: string,
    input: { content: string; attachments?: unknown; hostCommand?: boolean },
    userId: string | number | null,
  ): { message: RoomMessage; state: RoomRuntimeState } {
    const room = requireRoom(roomId);
    const attachments = filterAttachmentsToUploadStore(input.attachments);
    if (!input.content.trim() && attachments.length === 0) {
      throw new AppError('보낼 내용이 없습니다.', { code: 'EMPTY_MESSAGE', statusCode: 400 });
    }
    return roomTurnEngine.postUserMessage(room, input.content, userId, {
      attachments,
      hostCommand: input.hostCommand,
    });
  },

  /**
   * 참가자 세션들의 대화를 줄여 토큰을 되돌린다. `participantId` 를 주면 그
   * 한 명만, 주지 않으면 세션이 있는 전원이다.
   *
   * 명단에서 기다리기만 한 멤버는 세션이 없어 줄일 것도 없으므로 빠진다.
   */
  async compact(roomId: string, participantId?: string): Promise<RoomRuntimeState> {
    const room = requireRoom(roomId);
    const rows = participantId
      ? [requireParticipant(roomId, participantId)]
      : roomsDb.listParticipants(roomId);
    const targets = rows
      .map((row) => toRoomParticipant(row, room))
      .filter((participant): participant is RoomParticipant & { sessionId: string } => Boolean(participant.sessionId));
    if (targets.length === 0) {
      throw new AppError('대화를 줄일 세션이 없습니다.', { code: 'NO_COMPACTABLE_SESSION', statusCode: 400 });
    }
    return roomTurnEngine.compact(room, targets);
  },

  async interrupt(roomId: string): Promise<RoomRuntimeState> {
    return roomTurnEngine.interrupt(requireRoom(roomId));
  },

  async stop(roomId: string): Promise<RoomRuntimeState> {
    return roomTurnEngine.stop(requireRoom(roomId));
  },
};
