import { randomUUID } from 'node:crypto';

import { roomsDb, sessionsDb } from '@/modules/database/index.js';
import type { RoomParticipantRow, RoomRow } from '@/modules/database/index.js';
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
  toIsoTimestamp,
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
/**
 * 자동 턴 수의 상한. 사용자가 직접 적어 넣을 수 있게 넉넉히 둔다 — 루프가
 * 차례마다 이 값을 다시 읽으므로, 도는 중에 늘리거나 줄여도 바로 따른다.
 */
const MAX_AUTO_TURNS_LIMIT = 100;

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
  /** 등록된 Claude 계정(claude_accounts 의 id). Claude 가 아니면 무시된다. */
  claudeAccountId?: string | null;
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
  /**
   * 아직 한 번도 돌지 않은 새 세션일 때만 따른다. 새 대화로 룸을 열면 방장이 곧
   * 원래 세션이라, 방장으로 고른 사람의 모델과 계정을 그 세션에 적는다. 이미
   * 대화가 있는 세션은 그 대화의 모델·계정을 그대로 둔다.
   */
  model?: string | null;
  claudeAccountId?: string | null;
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
      hostLed: room.host_led !== 0,
      autoCompact: room.auto_compact !== 0,
      notifyTelegram: room.notify_telegram !== 0,
      createdAt: toIsoTimestamp(room.created_at),
    },
    participants: roomsDb.listParticipants(room.room_id).map((row) => toRoomParticipant(row, room)),
    formerParticipants: roomsDb.listFormerParticipants(room.room_id).map((row) => toRoomParticipant(row, room)),
    ...recentMessages(room.room_id),
    state: roomTurnEngine.getState(room.room_id, room.max_auto_turns),
  };
}

/**
 * 상세에 싣는 최근 메시지 수. 오래 쓴 룸은 타임라인이 수천 개라, 열 때마다 그리고
 * 참가자가 바뀔 때마다 통째로 싣던 것이 룸을 여는 데 한참 걸리게 했다. 그 앞은
 * 화면에서 "이전 대화 더 보기" 로 불러온다.
 */
export const ROOM_DETAIL_MESSAGE_LIMIT = 60;

/** 한 번에 더 불러오는 이전 메시지 수의 상한. */
const MAX_OLDER_MESSAGES_PAGE = 200;

/** 최근 메시지와, 그 앞이 더 있는지. 하나 더 읽어 앞이 있는지 본다. */
function recentMessages(roomId: string, limit = ROOM_DETAIL_MESSAGE_LIMIT, beforeId?: number): { messages: RoomMessage[]; hasOlderMessages: boolean } {
  const rows = roomsDb.listRecentMessages(roomId, limit + 1, beforeId);
  const hasOlderMessages = rows.length > limit;
  return {
    messages: (hasOlderMessages ? rows.slice(1) : rows).map(toRoomMessage),
    hasOlderMessages,
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
/**
 * 참가자의 모델·추론 강도를 고친다. 세션이 있으면 세션에 적는다 — 차례는
 * 세션 설정으로 돈다. 아직 불린 적 없는 명단 멤버는 세션이 없으니 명단에
 * 적어 두고, 처음 불려 세션이 생길 때 옮긴다.
 *
 * Claude 계정은 세션이 생긴 뒤에는 바꾸지 않는다 — 세션이 있으면 `claudeAccountId`
 * 는 조용히 무시된다. 계정을 바꾸면 그 세션의 transcript 를 못 찾아 이어가기가
 * 깨지기 때문이다.
 */
function updateParticipantSelection(
  current: RoomParticipantRow,
  model: string | undefined,
  effort: string | undefined,
  claudeAccountId: string | undefined,
): void {
  const nextModel = model?.trim() || undefined;
  const nextEffort = effort?.trim() || undefined;
  if (!current.session_id) {
    const nextClaudeAccountId = claudeAccountId?.trim() || undefined;
    roomsDb.updateParticipantModel(current.participant_id, {
      model: nextModel,
      effort: nextEffort,
      claudeAccountId: nextClaudeAccountId,
    });
    return;
  }
  const provider = current.provider as LLMProvider;
  if (nextModel) {
    providerModelsService.setSessionModel(provider, current.session_id, nextModel);
  }
  if (nextEffort) {
    providerModelsService.setSessionEffort(provider, current.session_id, nextEffort);
  }
}

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

  /** `beforeId` 앞의 메시지를 최근 것부터 `limit` 개, 오래된 순으로. */
  listOlderMessages(roomId: string, beforeId: number, limit: number): { messages: RoomMessage[]; hasOlderMessages: boolean } {
    requireRoom(roomId);
    const pageSize = Math.min(Math.max(1, Math.floor(limit) || ROOM_DETAIL_MESSAGE_LIMIT), MAX_OLDER_MESSAGES_PAGE);
    return recentMessages(roomId, pageSize, beforeId);
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
  async createRoom(input: { hostSessionId: string; host?: HostInput; participant?: ParticipantInput | null }): Promise<RoomDetail> {
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
    const projectPath = hostSession.project_path;

    // 한 번도 돌지 않은 세션이면 방장으로 고른 사람의 모델·계정을 그대로 받는다.
    // 프로바이더가 세션 id 를 알려 온 적이 없다는 것이 아직 아무 말도 없었다는 뜻이다.
    const hostIsFresh = !hostSession.provider_session_id;
    let hostModel = hostSession.model;
    let hostClaudeAccountId = hostSession.claude_account_id;
    if (hostIsFresh) {
      const requestedModel = input.host?.model?.trim();
      if (requestedModel) {
        providerModelsService.setSessionModel(hostSession.provider as LLMProvider, input.hostSessionId, requestedModel);
        hostModel = requestedModel;
      }
      const requestedAccount = hostSession.provider === 'claude' ? input.host?.claudeAccountId?.trim() : '';
      if (requestedAccount) {
        sessionsDb.setSessionClaudeAccount(input.hostSessionId, requestedAccount);
        hostClaudeAccountId = requestedAccount;
      }
    }

    // 새 대화로 여는 룸은 방장 한 명으로도 시작할 수 있다. 나머지는 뒤이어 더한다.
    let invitee: Parameters<typeof roomsDb.createRoom>[1][number] | null = null;
    if (input.participant) {
      const provider = await assertProviderUsable(input.participant.provider);
      const inviteeName = resolveDisplayName(input.participant.displayName, provider, [hostName]);
      const inviteeRole = requireRoleName(input.participant.roleName);
      const inviteeModel = input.participant.model?.trim() || null;
      const inviteeClaudeAccountId = provider === 'claude' ? (input.participant.claudeAccountId?.trim() || null) : null;
      invitee = {
        participant_id: randomUUID(),
        session_id: createParticipantSession(
          provider,
          projectPath,
          inviteeName,
          inviteeRole,
          inviteeModel,
          null,
          inviteeClaudeAccountId,
        ),
        provider,
        model: inviteeModel,
        claude_account_id: inviteeClaudeAccountId,
        display_name: inviteeName,
        role_name: inviteeRole,
        role_prompt: input.participant.rolePrompt?.trim() ?? '',
        persona: input.participant.persona?.trim() ?? '',
        status: 'active',
        position: 1,
      };
    }
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
          model: hostModel,
          claude_account_id: hostClaudeAccountId,
          display_name: hostName,
          role_name: hostRole,
          role_prompt: input.host?.rolePrompt?.trim() ?? '',
          persona: input.host?.persona?.trim() ?? '',
          status: 'active',
          position: 0,
        },
        ...(invitee ? [invitee] : []),
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
    const claudeAccountId = provider === 'claude' ? (input.claudeAccountId?.trim() || null) : null;
    const status = input.status === 'active' ? 'active' : 'standby';
    // 명단에만 담는 멤버는 세션을 만들지 않는다. 한 번도 불리지 않으면 아무
    // 비용도 들지 않아야 명단을 넉넉히 둘 수 있다.
    const sessionId = status === 'active'
      ? createParticipantSession(provider, room.project_path, displayName, roleName, model, null, claudeAccountId)
      : null;

    roomsDb.addParticipant({
      participant_id: randomUUID(),
      room_id: roomId,
      session_id: sessionId,
      provider,
      model,
      claude_account_id: claudeAccountId,
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
      hostLed?: boolean;
      autoCompact?: boolean;
      notifyTelegram?: boolean;
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
      model?: string;
      effort?: string;
      claudeAccountId?: string;
    },
  ): RoomDetail {
    const room = requireRoom(roomId);
    const current = requireParticipant(roomId, participantId);
    if (settings.permissionMode !== undefined) {
      roomsDb.updateParticipantPermission(participantId, settings.permissionMode);
    }
    if (settings.model !== undefined || settings.effort !== undefined || settings.claudeAccountId !== undefined) {
      updateParticipantSelection(current, settings.model, settings.effort, settings.claudeAccountId);
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
      sessionsService.renameSessionById(current.session_id, `${name} · ${role}`);
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
   * 방장을 넘긴다. 방장은 처음엔 원래 대화의 참가자지만, 어느 참가자든 받을 수
   * 있다. 방장은 사용자 글을 먼저 받고 방장 주도에서 다른 참가자를 부르므로
   * 늘 상주해야 한다 — 명단에서 기다리던 멤버라면 이 자리에서 들어온다.
   */
  setLeader(roomId: string, participantId: string): RoomDetail {
    const room = requireRoom(roomId);
    const participant = requireParticipant(roomId, participantId);
    if (participant.status !== 'active') {
      const sessionId = participant.session_id
        ?? createParticipantSession(
          participant.provider as LLMProvider,
          room.project_path,
          participant.display_name,
          participant.role_name,
          participant.model,
          participant.effort,
          participant.claude_account_id,
        );
      roomsDb.setParticipantStatus(participantId, 'active', sessionId);
    }
    // 원래 대화로 돌아가면 따로 적어 둘 것이 없다.
    roomsDb.setLeader(roomId, participant.session_id === room.host_session_id ? null : participantId);
    broadcastRoomFrame({ kind: 'room_updated', roomId });
    return this.getRoomDetail(roomId);
  },

  /**
   * 참가자를 룸에서 뺀다.
   *
   * 일한 적 있는 참가자는 퇴장으로 적고 그 세션을 보관함으로 옮긴다. 명단과
   * 사이드바의 룸 밑에서 모두 사라지고, 프로젝트 목록에 평범한 세션으로 튀어
   * 나오지도 않는다. 행은 남겨 두어 타임라인의 지난 발언에는 이름이 그대로
   * 붙는다. 대화가 다시 필요하면 보관함에서 꺼내 평범한 대화로 이어 가면 된다.
   *
   * 한 번도 불린 적 없는 명단 멤버는 세션도 발언도 없으므로 행째 지운다. 지울
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
    // 차례에서 빠지는 방장은 방장 자리를 원래 대화에 돌려준다.
    if (room.leader_participant_id === participantId) {
      roomsDb.setLeader(roomId, null);
    }
    if (participant.session_id) {
      roomsDb.markParticipantLeft(roomId, participantId);
      sessionsDb.updateSessionIsArchived(participant.session_id, true);
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

  /** 참가자가 받기 전의 사용자 글을 취소한다. */
  cancelPendingMessage(roomId: string, messageId: number): RoomRuntimeState {
    return roomTurnEngine.cancelPendingMessage(requireRoom(roomId), messageId);
  },

  async interrupt(roomId: string): Promise<RoomRuntimeState> {
    return roomTurnEngine.interrupt(requireRoom(roomId));
  },

  async stop(roomId: string): Promise<RoomRuntimeState> {
    return roomTurnEngine.stop(requireRoom(roomId));
  },
};
