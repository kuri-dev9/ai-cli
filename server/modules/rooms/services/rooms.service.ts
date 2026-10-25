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
import {
  parseRoomPermissionMode,
  toRoomMessage,
  toRoomParticipant,
} from '@/modules/rooms/services/room-records.service.js';
import { roomTurnEngine } from '@/modules/rooms/services/room-turn-engine.service.js';
import type { LLMProvider, RoomDetail, RoomMessage, RoomPermissionMode, RoomRuntimeState } from '@/shared/types.js';
import { AppError } from '@/shared/utils.js';

/** 한 룸에 들어갈 수 있는 참가자 수. 원래 대화를 포함한다. */
const MAX_ROOM_PARTICIPANTS = 3;

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
};

type HostInput = {
  displayName?: string | null;
  roleName?: string | null;
  rolePrompt?: string | null;
};

/** 룸 하나의 요약. 사이드바가 어떤 세션이 룸인지 표시하는 데 쓴다. */
type RoomIndexEntry = {
  roomId: string;
  hostSessionId: string;
  participants: Array<{
    participantId: string;
    sessionId: string;
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
      createdAt: room.created_at,
    },
    participants: roomsDb.listParticipants(room.room_id).map((row) => toRoomParticipant(row, room)),
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

/**
 * 초대한 참가자를 위한 세션을 만든다. 이름만 보고도 어느 룸의 누구인지 알 수
 * 있게 붙여 두고, 모델을 골랐다면 세션에 적어 둔다 — 그 세션을 따로 열었을
 * 때도 같은 모델로 이어진다.
 */
function createParticipantSession(provider: LLMProvider, projectPath: string, displayName: string, roleName: string, model: string | null): string {
  const { sessionId } = sessionsService.createAppSession(provider, projectPath, `${displayName} · ${roleName}`);
  sessionsService.renameSessionById(sessionId, `[룸] ${displayName} · ${roleName}`);
  if (model) {
    providerModelsService.setSessionModel(provider, sessionId, model);
  }
  return sessionId;
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
        isHost: row.session_id === hostByRoom.get(row.room_id),
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
          position: 1,
        },
      ],
    );

    broadcastRoomFrame({ kind: 'room_updated', roomId });
    return this.getRoomDetail(roomId);
  },

  async addParticipant(roomId: string, input: ParticipantInput): Promise<RoomDetail> {
    const room = requireRoom(roomId);
    const existing = roomsDb.listParticipants(roomId);
    if (existing.length >= MAX_ROOM_PARTICIPANTS) {
      throw new AppError(`한 룸에는 최대 ${MAX_ROOM_PARTICIPANTS}명까지 참가할 수 있습니다.`, {
        code: 'ROOM_FULL',
        statusCode: 409,
      });
    }

    const provider = await assertProviderUsable(input.provider);
    const displayName = resolveDisplayName(input.displayName, provider, existing.map((row) => row.display_name));
    const roleName = requireRoleName(input.roleName);
    const model = input.model?.trim() || null;
    const sessionId = createParticipantSession(provider, room.project_path, displayName, roleName, model);

    roomsDb.addParticipant({
      participant_id: randomUUID(),
      room_id: roomId,
      session_id: sessionId,
      provider,
      model,
      display_name: displayName,
      role_name: roleName,
      role_prompt: input.rolePrompt?.trim() ?? '',
      position: Math.max(...existing.map((row) => row.position), -1) + 1,
    });

    broadcastRoomFrame({ kind: 'room_updated', roomId });
    return this.getRoomDetail(roomId);
  },

  updateSettings(roomId: string, settings: { permissionMode?: RoomPermissionMode; maxAutoTurns?: number }): RoomDetail {
    requireRoom(roomId);
    if (settings.maxAutoTurns !== undefined
      && (!Number.isInteger(settings.maxAutoTurns) || settings.maxAutoTurns < 1 || settings.maxAutoTurns > MAX_AUTO_TURNS_LIMIT)) {
      throw new AppError(`자동 턴 수는 1~${MAX_AUTO_TURNS_LIMIT} 사이여야 합니다.`, {
        code: 'INVALID_MAX_AUTO_TURNS',
        statusCode: 400,
      });
    }
    roomsDb.updateRoomSettings(roomId, settings);
    broadcastRoomFrame({ kind: 'room_updated', roomId });
    return this.getRoomDetail(roomId);
  },

  postUserMessage(roomId: string, content: string, userId: string | number | null): { message: RoomMessage; state: RoomRuntimeState } {
    const room = requireRoom(roomId);
    return roomTurnEngine.postUserMessage(room, content, userId);
  },

  async stop(roomId: string): Promise<RoomRuntimeState> {
    return roomTurnEngine.stop(requireRoom(roomId));
  },
};
