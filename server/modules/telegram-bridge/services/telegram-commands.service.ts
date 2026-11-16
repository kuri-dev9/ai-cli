import {
  messageSourcesDb,
  projectsDb,
  readQueuedMessageList,
  roomsDb,
  sessionDraftsDb,
  sessionsDb,
} from '@/modules/database/index.js';
import { providerAuthService, sessionsService } from '@/modules/providers/index.js';
import { isSessionHandedToTelegram } from '@/modules/telegram-bridge/services/telegram-bridge.service.js';
import { chatRunRegistry, runDetachedChatTurn } from '@/modules/websocket/index.js';
import type { ProviderRuntimeGateway } from '@/modules/websocket/index.js';
import type { ChatAttachmentDescriptor } from '@/shared/image-attachments.js';
import type { LLMProvider } from '@/shared/types.js';
import type {
  TelegramButton,
  TelegramIncomingFile,
} from '@/modules/telegram-bridge/services/telegram-client.service.js';
import { storeTelegramFiles } from '@/modules/telegram-bridge/services/telegram-files.service.js';
import {
  readTelegramSettings,
  writeTelegramSettings,
} from '@/modules/telegram-bridge/services/telegram-settings.service.js';
import {
  isSessionNotified,
  readBridgeState,
  setSessionNotified,
  writeBridgeState,
} from '@/modules/telegram-bridge/services/telegram-state.service.js';
import type {
  PendingNewChat,
  TelegramBridgeState,
} from '@/modules/telegram-bridge/services/telegram-state.service.js';

/**
 * 텔레그램에서 온 한 줄을 명령으로 해석해 실행한다.
 *
 * 슬래시로 시작하지 않는 모든 입력은 구독 중인 세션에 보낼 프롬프트로 본다 —
 * 외부에서 쓰는 통로의 기본 동작은 "말을 걸면 그대로 전달"이어야 한다.
 */

type PendingApproval = {
  requestId: string;
  toolName?: string;
  sessionId?: string;
};

type CommandContext = {
  userId: number;
  runtime: ProviderRuntimeGateway;
  /**
   * 사진·파일의 내용을 받는 통로. 브리지가 자기 클라이언트의 것을 넘긴다.
   * 글만 오가는 호출(테스트 대부분)은 넘기지 않아도 된다.
   */
  downloadFile?: (fileId: string, signal?: AbortSignal) => Promise<Buffer>;
  /**
   * 이 컴퓨터에서 지금 쓸 수 있는 AI. 넘기지 않으면 설치·로그인 상태를 직접
   * 확인한다. 테스트가 기계 상태와 무관하게 돌도록 바꿔 끼울 자리다.
   */
  listConnectedProviders?: () => Promise<LLMProvider[]>;
};

/**
 * 버튼을 단 답. 브리지가 메시지 아래에 버튼을 붙여 보낸다.
 *
 * 텔레그램의 `/` 메뉴는 명령을 누르는 순간 인자 없이 보내 버린다. 그래서
 * 인자가 필요한 명령은 글로 "번호를 붙여 다시 보내라"고 하는 대신 고를 거리를
 * 버튼으로 내민다.
 */
export type TelegramReply = {
  text: string;
  buttons: TelegramButton[][];
};

/** 명령 하나의 답. 글만, 버튼을 단 글, 또는 보낼 것 없음(null). */
type CommandResult = string | TelegramReply | null;

/** 화면에 보일 AI 이름. 순서가 버튼 순서다. */
const PROVIDER_LABELS: Record<LLMProvider, string> = {
  claude: 'Claude',
  codex: 'Codex',
  cursor: 'Cursor',
  opencode: 'OpenCode',
};

const PROVIDER_IDS = Object.keys(PROVIDER_LABELS) as LLMProvider[];

/** 아무 기록이 없을 때 새 대화를 여는 AI. */
const FALLBACK_PROVIDER: LLMProvider = 'claude';

/**
 * `/new` 뒤에 첫 메시지를 기다리는 시간.
 *
 * 메뉴에서 `/new` 를 누르고 잊어버린 경우, 한참 뒤에 구독 중인 대화로 보내려던
 * 글이 엉뚱하게 새 대화를 여는 것을 막는다.
 */
const PENDING_NEW_CHAT_TTL_MS = 10 * 60 * 1000;

/** 목록 버튼이 너무 길어지지 않도록. 넘는 것은 `/watch <번호>` 로 고른다. */
const MAX_PROJECT_BUTTONS = 20;

/** 사람이 읽을 이름. 사용자 지정 이름이 없으면 폴더 이름을 쓴다. */
function projectLabel(project: { custom_project_name: string | null; project_path: string }): string {
  return project.custom_project_name || project.project_path.split('/').filter(Boolean).pop() || project.project_path;
}

function listActiveProjects() {
  return projectsDb.getProjectPaths().filter((project) => !project.isArchived);
}

/**
 * 고를 수 있는 프로젝트를 번호와 함께 보여준다.
 *
 * `/projects` 와 인자 없는 `/watch` 가 같은 목록을 쓴다. 텔레그램의 `/` 메뉴는
 * 명령을 누르는 순간 인자 없이 그대로 보내 버려서, 인자를 받는 `/watch` 는
 * 사실상 항상 맨몸으로 도착한다. 그때 "번호를 확인해 주세요" 라고 되돌려
 * 보내면 사용자는 `/projects` 를 한 번 더 쳐야 한다 — 어차피 보여줄 목록이니
 * 여기서 바로 보여주는 편이 왕복 하나를 없앤다.
 */
function renderProjectPicker(heading: string): CommandResult {
  const projects = listActiveProjects();
  if (projects.length === 0) {
    return '프로젝트가 없습니다.';
  }
  return {
    text: [
      heading,
      ...projects.map((project, index) => `${index + 1}. ${projectLabel(project)}`),
      '',
      '아래에서 누르거나 /watch <번호> 로 구독합니다.',
    ].join('\n'),
    buttons: projects.slice(0, MAX_PROJECT_BUTTONS).map((project, index) => [{
      text: `${index + 1}. ${projectLabel(project)}`,
      data: `watch:${project.project_id}`,
    }]),
  };
}

/** 고른 프로젝트의 최신 대화를 구독한다. `/watch` 와 프로젝트 버튼이 같이 쓴다. */
function watchProject(
  project: { project_path: string; custom_project_name: string | null },
  userId: number,
): string {
  const session = findLatestSession(project.project_path);
  if (!session) {
    // 고른 사실은 남긴다. 예전에는 여기서 아무것도 적지 않아서, 이어 친
    // `/new` 가 고른 프로젝트가 아니라 마지막에 쓴 프로젝트에 대화를 만들었다.
    // 구독도 놓는다 — 다른 프로젝트를 골랐는데 보낸 글이 예전 대화로 가면 안 된다.
    writeBridgeState(userId, {
      watchedSessionId: null,
      selectedProjectPath: project.project_path,
      pendingNewChat: null,
    });
    return `${projectLabel(project)} 을(를) 골랐습니다. 아직 대화가 없습니다.\n/new 로 이 프로젝트에 새 대화를 시작하세요.`;
  }

  const targetSessionId = resolveRoomLeaderSessionId(session.session_id);
  writeBridgeState(userId, {
    watchedSessionId: targetSessionId,
    selectedProjectPath: project.project_path,
    pendingNewChat: null,
  });
  return `${projectLabel(project)} 의 최신 대화를 구독한다.\n${describeSession(targetSessionId)}`;
}

/** 프로젝트에서 가장 최근에 손댄 세션. `/watch` 가 고르는 대상이다. */
function findLatestSession(projectPath: string) {
  const sessions = sessionsDb.getSessionsByProjectPath(projectPath);
  if (sessions.length === 0) {
    return null;
  }
  return [...sessions].sort((a, b) => b.updated_at.localeCompare(a.updated_at))[0];
}

/**
 * 룸 참가자의 세션이면 그 룸 방장의 세션으로 바꾼다.
 *
 * 룸에서는 참가자가 차례로 답하므로 "가장 최근에 손댄 세션"은 마지막에 말한
 * 참가자다. 그 세션을 구독하면 폰에서 보낸 말이 방장이 아니라 그 참가자에게
 * 간다. 룸에 말을 거는 자리는 방장이다.
 *
 * 방장은 따로 정했으면 그 참가자, 아니면 룸이 사는 원래 대화다
 * (`room-records.service.ts` 의 `isHost` 와 같은 규칙). 룸이 아니면 그대로 둔다.
 */
export function resolveRoomLeaderSessionId(sessionId: string): string {
  const participant = roomsDb.getParticipantBySession(sessionId);
  if (!participant) {
    return sessionId;
  }
  const room = roomsDb.getRoom(participant.room_id);
  if (!room) {
    return sessionId;
  }
  if (room.leader_participant_id) {
    const leader = roomsDb
      .listParticipants(room.room_id)
      .find((candidate) => candidate.participant_id === room.leader_participant_id);
    if (leader?.session_id) {
      return leader.session_id;
    }
  }
  return room.host_session_id || sessionId;
}

/**
 * `/off`: 이쪽으로 오는 알림을 전부 끈다.
 *
 * 알림이 오는 길은 넷이다 — 구독 중인 대화, 넘기기를 켜 둔 대화들, 설정의 전역
 * "완료 알림", 룸마다 켜는 "라운드 끝" 알림. 예전 `/off` 는 구독 중인 대화의
 * 표시 하나만 껐고, 나머지 셋이 계속 울렸다. 폰에서 "그만"이라고 했으면 무엇이
 * 켜져 있었든 조용해져야 한다.
 *
 * 무엇을 껐는지 돌려준다. 웹에서 켜 둔 설정까지 바뀌므로 말해 줘야 한다.
 */
function turnEverythingOff(userId: number): string[] {
  const state = readBridgeState(userId);
  const turnedOff: string[] = [];

  if (state.watchedSessionId) {
    turnedOff.push(`구독: ${describeSession(state.watchedSessionId)}`);
  }
  if (state.notifiedSessionIds.length > 0) {
    turnedOff.push(`넘겨받은 대화 ${state.notifiedSessionIds.length}개`);
  }
  writeBridgeState(userId, { watchedSessionId: null, notifiedSessionIds: [], pendingNewChat: null });

  if (readTelegramSettings().notifyOnCompletion) {
    writeTelegramSettings({ notifyOnCompletion: false });
    turnedOff.push('완료 알림 (설정 > 텔레그램)');
  }

  const notifyingRooms = roomsDb.listRooms().filter((room) => room.notify_telegram);
  for (const room of notifyingRooms) {
    roomsDb.updateRoomSettings(room.room_id, { notifyTelegram: false });
  }
  if (notifyingRooms.length > 0) {
    turnedOff.push(`방 라운드 알림 ${notifyingRooms.length}개`);
  }

  return turnedOff;
}

function readPendingApprovals(runtime: ProviderRuntimeGateway, sessionId: string): PendingApproval[] {
  return runtime.getPendingApprovalsForSession(sessionId).filter(
    (approval): approval is PendingApproval =>
      Boolean(approval) && typeof (approval as PendingApproval).requestId === 'string',
  );
}

function describeSession(sessionId: string): string {
  const session = sessionsDb.getSessionById(sessionId);
  if (!session) {
    return `${sessionId} (없어진 세션)`;
  }
  const name = session.custom_name || session.project_path || sessionId;
  return `${name} [${session.provider}]`;
}

const HELP_TEXT = [
  '명령 목록',
  '',
  '/help            이 목록',
  '/new [AI] [메시지] 새 대화를 시작 (AI 를 빼면 마지막에 쓴 AI)',
  '/status          지금 무엇이 돌고 있는지, 승인 대기가 있는지',
  '/projects        프로젝트 목록',
  '/watch <번호|이름> 그 프로젝트의 최신 대화를 구독',
  '/unwatch         구독을 놓는다. 이 대화로 오는 것을 멈춘다',
  '/on              구독 중인 대화의 웹 작업까지 알림 받기',
  '/off             전부 끄기 — 구독, 넘기기, 완료 알림, 방 알림',
  '/allow [번호]    승인 대기 중인 도구를 허용',
  '/deny [번호]     승인 대기 중인 도구를 거부',
  '/stop            지금 돌고 있는 턴을 중단 (대기열은 이어서 실행)',
  '/queue           대기열 보기 · 지금 끼어들기 · 비우기',
  '',
  '작업 중에 보낸 글은 웹 화면과 같은 대기열에 들어간다. 지금 턴이 끝나면',
  '순서대로 실행되고, "지금 끼어들기" 를 누르면 지금 턴을 멈추고 바로 실행한다.',
  '/new 는 구독 중인 대화의 프로젝트(없으면 /watch 로 고른 프로젝트)에 만든다.',
  '',
  '이쪽으로 무엇이 오는지',
  '',
  '1. 여기서 보낸 작업의 결과 — 구독 중이면 항상 온다.',
  '2. 웹에서 시작한 작업의 결과 — /on 으로 켠 대화만.',
  '3. 웹 화면의 빠른 설정에서 넘기기를 켜면 그 대화를 이쪽으로 넘겨받는다.',
  '   넘겨받으면 구독과 알림이 함께 켜지므로, 그 뒤로는 그 대화의 웹 작업도',
  '   전부 이쪽으로 온다. 이렇게 넘어온 작업은 승인을 묻지 않고 진행한다 —',
  '   여기서는 승인 창을 띄울 수 없기 때문이다.',
  '',
  '브라우저로 돌아왔으면 같은 자리에서 넘기기를 끄면 이 대화를 놓는다.',
  '이 대화만 놓으려면 /unwatch, 무엇이든 그만 받으려면 /off 를 쓴다.',
  '',
  '슬래시 없이 보낸 글은 구독 중인 대화에 그대로 들어간다.',
].join('\n');

/**
 * 한 줄을 처리하고 사용자에게 돌려줄 답을 만든다.
 *
 * 답이 `null` 이면 아무것도 보내지 않는다.
 *
 * `files` 가 있으면 본문(캡션)은 명령으로 읽지 않는다 — 사진에 단 "/stop" 은
 * 사진과 함께 모델에게 할 말이지, 사진을 버리고 턴을 멈추라는 뜻이 아니다.
 */
export async function handleTelegramCommand(
  text: string,
  context: CommandContext,
  files: TelegramIncomingFile[] = [],
): Promise<CommandResult> {
  const trimmed = text.trim();
  const state = readBridgeState(context.userId);

  // `/new` 만은 사진 캡션이어도 명령으로 읽는다. "이 사진으로 새 대화" 를
  // 말할 다른 방법이 없다.
  if (/^\/new(\s|$)/i.test(trimmed)) {
    return handleNewChatCommand(trimmed.slice('/new'.length).trim(), context, state, files);
  }

  if (files.length > 0 || (trimmed && !trimmed.startsWith('/'))) {
    const pending = readActivePendingNewChat(state);
    if (pending) {
      return startNewChat(pending.provider, pending.model, trimmed, files, context, state);
    }
    return sendPrompt(trimmed, context, state.watchedSessionId, files);
  }

  if (!trimmed) {
    return null;
  }

  // 다른 명령을 쳤다면 새 대화를 열려던 것은 그만둔 것이다.
  if (state.pendingNewChat) {
    writeBridgeState(context.userId, { pendingNewChat: null });
  }

  const [rawCommand, ...rest] = trimmed.split(/\s+/);
  const command = rawCommand.toLowerCase();
  const argument = rest.join(' ');

  switch (command) {
    case '/help':
    case '/start':
      return HELP_TEXT;

    case '/unwatch': {
      // 넘겨받은 대화를 통째로 놓는 길. `/off` 는 웹 작업 알림만 끄고 구독은
      // 남기므로, 넘기기로 끌어온 대화를 완전히 멈출 방법이 없었다.
      if (!state.watchedSessionId) {
        return '구독 중인 대화가 없습니다.';
      }

      const released = describeSession(state.watchedSessionId);
      setSessionNotified(context.userId, state.watchedSessionId, false);
      writeBridgeState(context.userId, { watchedSessionId: null });
      return `구독을 놓았습니다: ${released}\n이 대화로는 더 오지 않습니다. 다시 받으려면 /watch 해 주세요.`;
    }

    case '/on': {
      // 구독 중인 세션의 웹 작업까지 알린다. 여기서 보낸 작업의 결과는 이
      // 값과 무관하게 항상 돌아온다.
      if (!state.watchedSessionId) {
        return '구독 중인 세션이 없습니다. /projects 로 고른 뒤 /watch 해 주세요.';
      }

      setSessionNotified(context.userId, state.watchedSessionId, true);
      return '이 세션은 웹에서 시작한 작업도 끝나면 알려준다.';
    }

    case '/off': {
      const turnedOff = turnEverythingOff(context.userId);
      if (turnedOff.length === 0) {
        return '켜져 있는 알림이 없습니다. 이쪽으로 오는 것은 없습니다.';
      }
      return [
        '🔕 전부 껐습니다. 이제 이쪽으로 아무것도 오지 않습니다.',
        '',
        ...turnedOff.map((line) => `- ${line}`),
        '',
        '다시 받으려면 /watch 로 대화를 고르고, 웹 작업 알림은 /on 으로 켭니다.',
      ].join('\n');
    }

    case '/projects':
      return renderProjectPicker('프로젝트');

    case '/watch': {
      // 인자 없이 온 `/watch` 는 오타가 아니라 메뉴에서 눌렀다는 뜻이다. 목록을
      // 바로 돌려주면 그대로 번호만 붙여 다시 보내면 된다.
      if (!argument) {
        return renderProjectPicker('어느 프로젝트를 구독할까요?');
      }

      const projects = listActiveProjects();
      // 번호로도, 이름 일부로도 고를 수 있다. 폰에서 긴 이름을 치기 번거롭다.
      const index = Number.parseInt(argument, 10);
      const picked = Number.isFinite(index) && index >= 1 && index <= projects.length
        ? projects[index - 1]
        : projects.find((project) => projectLabel(project).toLowerCase().includes(argument.toLowerCase()));

      if (!picked) {
        return renderProjectPicker(`"${argument}" 에 맞는 프로젝트가 없습니다.`);
      }

      return watchProject(picked, context.userId);
    }

    case '/status': {
      if (!state.watchedSessionId) {
        return '구독 중인 세션이 없습니다. /projects 로 고른 뒤 /watch 해 주세요.';
      }

      const running = chatRunRegistry.isProcessing(state.watchedSessionId);
      const approvals = readPendingApprovals(context.runtime, state.watchedSessionId);
      const notified = isSessionNotified(context.userId, state.watchedSessionId);
      const queued = listQueuedPrompts(context.userId, state.watchedSessionId).length;
      const watchedSession = sessionsDb.getSessionById(state.watchedSessionId);
      const lines = [
        `세션: ${describeSession(state.watchedSessionId)}`,
        `프로젝트: ${describeProjectPath(watchedSession?.project_path ?? null)}`,
        `상태: ${running ? '작업 중 (/stop 으로 중단)' : '대기'}`,
        ...(queued > 0 ? [`대기열: ${queued}건 (/queue 로 보기)`] : []),
        // 문구가 "알림: 켜짐" 하나였을 때는 거짓말이었다 — 여기서 보낸 작업의
        // 결과는 이 값과 무관하게 항상 오는데, 꺼져 있으면 아무것도 안 온다고
        // 읽힌다.
        `웹 작업 알림: ${notified ? '켜짐 (/off 로 전부 끔)' : '꺼짐 (/on 으로 켬)'}`,
        '여기서 보낸 작업의 결과는 항상 옵니다.',
      ];

      // 승인 대기는 푸시로 보내지 않기로 했으므로, 여기에서 반드시 보여야 한다.
      // 이게 없으면 "시작했다"는 알림만 받고 왜 안 끝나는지 알 수 없다.
      if (approvals.length > 0) {
        lines.push(
          '',
          `승인 대기 ${approvals.length}건:`,
          ...approvals.map((approval, index) => `${index + 1}. ${approval.toolName ?? '도구'}`),
          '',
          '/allow 또는 /deny 로 답해 주세요.',
        );
      }
      return lines.join('\n');
    }

    case '/allow':
    case '/deny': {
      if (!state.watchedSessionId) {
        return '구독 중인 세션이 없습니다.';
      }

      const approvals = readPendingApprovals(context.runtime, state.watchedSessionId);
      if (approvals.length === 0) {
        return '승인 대기 중인 것이 없습니다.';
      }

      const allow = command === '/allow';
      // 번호를 주지 않으면 가장 오래 기다린 것부터 처리한다.
      const index = Number.parseInt(argument, 10);
      const target = Number.isFinite(index) && index >= 1 && index <= approvals.length
        ? approvals[index - 1]
        : approvals[0];

      context.runtime.resolveToolApproval(target.requestId, { allow });
      return `${target.toolName ?? '도구'} → ${allow ? '허용' : '거부'}했습니다.`;
    }

    case '/stop': {
      if (!state.watchedSessionId) {
        return '구독 중인 세션이 없습니다.';
      }
      // 웹의 중단 버튼과 같다. 대기열은 두므로, 줄 서 있던 글이 이어서 실행된다.
      // 그것까지 막으려면 먼저 /queue 에서 비운다.
      const waiting = listQueuedPrompts(context.userId, state.watchedSessionId).length;
      if (!(await abortRunningTurn(context.runtime, state.watchedSessionId))) {
        return '돌고 있는 턴이 없습니다.';
      }
      return waiting > 0
        ? `중단했습니다. 대기열의 ${waiting}건이 이어서 실행됩니다.`
        : '중단했습니다.';
    }

    case '/queue': {
      if (!state.watchedSessionId) {
        return '구독 중인 세션이 없습니다.';
      }
      const queued = listQueuedPrompts(context.userId, state.watchedSessionId);
      if (queued.length === 0) {
        return '대기열이 비어 있습니다.';
      }
      return {
        text: [
          `대기열 ${queued.length}건 (${chatRunRegistry.isProcessing(state.watchedSessionId) ? '지금 턴이 끝나면 실행' : '곧 실행'})`,
          '',
          ...queued.map((content, index) => `${index + 1}. ${content.length > 80 ? `${content.slice(0, 80)}…` : content}`),
        ].join('\n'),
        buttons: renderQueueButtons(state.watchedSessionId),
      };
    }

    default:
      // 모르는 슬래시 명령을 프롬프트로 흘려보내지 않는다 — 오타 하나가
      // 의도치 않은 작업을 시작시키는 것보다 되묻는 편이 낫다.
      return `모르는 명령입니다: ${rawCommand}\n\n${HELP_TEXT}`;
  }
}

/**
 * 캡션 없이 사진·파일만 보냈을 때 대신 넣는 본문.
 *
 * 빈 본문으로 턴을 시작하지 않는다. 대화 기록에 빈 말풍선이 남고, 출처
 * 표시(`markMessageSource`)도 본문으로 메시지를 찾기 때문에 붙지 않는다.
 */
function describeAttachedFiles(files: TelegramIncomingFile[]): string {
  return files.every((file) => file.kind === 'photo')
    ? '보낸 사진을 확인해 주세요.'
    : '보낸 파일을 확인해 주세요.';
}

/**
 * 턴을 띄우고, 실제로 시작될 때까지만 기다린다.
 *
 * `runDetachedChatTurn` 은 턴이 *끝나야* 돌아온다. 예전에는 그걸 그대로
 * 기다렸는데, 브리지는 갱신을 하나씩 차례로 처리하므로 턴이 도는 내내 폴링
 * 전체가 멈췄다. 그동안 폰에서 보낸 `/stop`·`/status`·`/allow` 는 하나도
 * 처리되지 않고, 턴이 끝난 뒤에 한꺼번에 처리됐다 — 멈춘 턴을 폰에서 멈출 수가
 * 없었다.
 *
 * 그래서 이 세션에 실행이 등록되는 순간(자동 대화 줄이기가 먼저 돌면 그 순간)
 * 돌아온다. 시작조차 못 했으면 그 이유를 받는다. 시작한 뒤의 실패는 완료
 * 알림이 오류로 전한다.
 */
function startDetachedTurn(
  sessionId: string,
  launch: () => Promise<{ started: boolean; error: string | null }>,
): Promise<{ started: boolean; error: string | null }> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: { started: boolean; error: string | null }) => {
      if (settled) {
        return;
      }
      settled = true;
      stopWatching();
      resolve(result);
    };
    const stopWatching = chatRunRegistry.onRunStarted((startedSessionId) => {
      if (startedSessionId === sessionId) {
        finish({ started: true, error: null });
      }
    });

    launch().then(
      (result) => finish(result),
      (error: unknown) => finish({
        started: false,
        error: error instanceof Error ? error.message : String(error),
      }),
    );
  });
}

/** 대기열에 넣은 뒤 다는 버튼. 세션 id 를 실어서, 나중에 눌러도 그 대화에만 듣는다. */
function renderQueueButtons(sessionId: string): TelegramButton[][] {
  return [[
    { text: '⚡ 지금 끼어들기', data: `steer:${sessionId}` },
    { text: '🗑 대기열 비우기', data: `qclear:${sessionId}` },
  ]];
}

/** 이 세션 대기열에 들어 있는 글. 웹 화면의 대기열 카드와 같은 목록이다. */
function listQueuedPrompts(userId: number, sessionId: string): string[] {
  const draft = sessionDraftsDb.getDrafts(userId).find((record) => record.scope === sessionId);
  return readQueuedMessageList(draft?.queuedMessage ?? null).map((item) => {
    const content = item && typeof item === 'object' ? (item as { content?: unknown }).content : null;
    return typeof content === 'string' && content.trim() ? content.trim() : '(첨부만)';
  });
}

/**
 * 대기열을 비운다. 입력 중이던 초안 글은 남긴다.
 *
 * 웹 화면에서 대기열 카드를 지우는 것과 같은 일을 한다 — 같은 칸을 쓰므로 웹
 * 화면의 대기열에서도 같이 사라진다.
 */
function clearQueuedPrompts(userId: number, sessionId: string): number {
  const draft = sessionDraftsDb.getDrafts(userId).find((record) => record.scope === sessionId);
  const count = readQueuedMessageList(draft?.queuedMessage ?? null).length;
  if (count > 0) {
    sessionDraftsDb.saveDraft(userId, sessionId, { text: draft?.text ?? '', queuedMessage: null });
  }
  return count;
}

/**
 * 돌고 있는 턴을 멈춘다. `/stop` 과 "지금 끼어들기" 버튼이 같이 쓴다.
 *
 * 멈추면 대기열을 비우는 쪽이 곧바로 다음 글을 보낸다(`onRunSettled`). 그래서
 * 끼어들기는 "멈추기" 하나로 충분하다 — 줄 맨 앞에 있는 글이 바로 실행된다.
 */
async function abortRunningTurn(runtime: ProviderRuntimeGateway, sessionId: string): Promise<boolean> {
  const run = chatRunRegistry.getRun(sessionId);
  if (!run || run.status !== 'running') {
    return false;
  }
  const aborted = await runtime.abort(run.provider, sessionId);
  chatRunRegistry.completeRun(sessionId, { exitCode: aborted ? 0 : 1, aborted: true });
  return true;
}

/** 구독 중인 세션에 한 턴을 밀어넣는다. */
async function sendPrompt(
  text: string,
  context: CommandContext,
  watchedSessionId: string | null,
  files: TelegramIncomingFile[] = [],
  /** 실행 옵션에 더 실을 것. 새 대화가 이어 쓸 모델을 넘길 때 쓴다. */
  runOptions: Record<string, unknown> = {},
): Promise<CommandResult> {
  if (!watchedSessionId) {
    return '구독 중인 세션이 없습니다. /projects 로 고른 뒤 /watch 해 주세요.';
  }

  // 구독을 확인한 뒤에 받는다. 보낼 곳도 없는 파일을 디스크에 쌓지 않는다.
  let attachments: ChatAttachmentDescriptor[] = [];
  if (files.length > 0) {
    if (!context.downloadFile) {
      return '첨부를 받을 수 없습니다.';
    }
    try {
      attachments = await storeTelegramFiles(files, context.downloadFile);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      return `첨부를 받지 못했습니다: ${reason}`;
    }
  }

  const prompt = text || describeAttachedFiles(files);

  // 작업 중이면 거절하지 않고 줄을 세운다. 브라우저에서 실행 중인 턴 뒤에
  // 메시지를 넣는 것과 같은 길을 쓰므로, 디스패처가 턴이 끝나는 즉시 보낸다.
  if (chatRunRegistry.isProcessing(watchedSessionId)) {
    // `origin` 도 같이 넣는다. 대기열을 비우는 쪽(예약 메시지 디스패처)이
    // 실행을 시작할 때 이 표시를 그대로 넘겨야, 한참 뒤에 실행돼도 결과가
    // 텔레그램으로 돌아온다.
    sessionDraftsDb.appendQueuedMessage(context.userId, watchedSessionId, {
      content: prompt,
      // 파일은 이미 받아 두었다. 대기열을 비우는 쪽이 이 목록을 그대로
      // 실행 옵션에 싣는다.
      ...(attachments.length > 0 ? { attachments } : {}),
      ...(Object.keys(runOptions).length > 0 ? { options: runOptions } : {}),
      origin: 'telegram',
    });
    // 대기열에 들어간 것도 텔레그램에서 온 것이다. 실행은 한참 뒤일 수
    // 있지만 출처는 지금 적어 둔다 — 나중에 실행하는 쪽은 이 메시지가
    // 어디서 왔는지 모른다.
    messageSourcesDb.markMessageSource(watchedSessionId, prompt, 'telegram');
    const waiting = sessionDraftsDb.countQueuedMessages(context.userId, watchedSessionId);
    // 웹 화면의 대기열 카드와 같은 선택지를 준다. 그냥 두면 지금 턴이 끝난 뒤
    // 실행되고, 급하면 지금 턴을 끊고 바로 넣을 수 있다.
    return {
      text: [
        `⏳ 작업 중이라 대기열에 넣었습니다 (${waiting}번째).`,
        '지금 턴이 끝나면 순서대로 실행합니다.',
        '급하면 "지금 끼어들기" 로 지금 턴을 멈추고 바로 실행합니다.',
      ].join('\n'),
      buttons: renderQueueButtons(watchedSessionId),
    };
  }

  // 턴을 시작하기 전에 적는다. CLI 가 기록에 메시지를 쓰는 것은 실행 중이고,
  // 그때 우리가 끼어들 자리는 없다.
  const sourceMarkId = messageSourcesDb.markMessageSource(watchedSessionId, prompt, 'telegram');

  const result = await startDetachedTurn(watchedSessionId, () => runDetachedChatTurn(
    {
      sessionId: watchedSessionId,
      userId: context.userId,
      content: prompt,
      options: { ...runOptions, ...(attachments.length > 0 ? { attachments } : {}) },
      // 이 표시가 브리지의 회신 근거다. 텔레그램에서 시작한 실행은 알림 설정과
      // 무관하게 결과를 돌려보낸다.
      origin: 'telegram',
    },
    { runtime: context.runtime, isSessionHandedToTelegram },
  ));

  if (!result.started) {
    // 기록에 남지 않은 턴의 표시를 남겨 두면, 나중에 브라우저에서 같은 글을
    // 보냈을 때 그 메시지에 "텔레그램" 이 잘못 붙는다.
    messageSourcesDb.dropMessageSource(sourceMarkId);
    return `보내지 못했습니다: ${result.error ?? '알 수 없는 이유'}`;
  }

  // 잘 들어갔다는 말은 하지 않는다. 결과가 곧 따라오므로 확인용 한 줄은
  // 알림만 한 번 더 울리고 대화창을 밀어 올린다. 실패는 위에서 말한다.
  return null;
}

// ----------------- 새 대화 (/new) ------------

/** 설치돼 있고 로그인까지 된 AI. 상태를 못 읽은 AI 는 쓸 수 없는 것으로 본다. */
async function listConnectedProvidersOnMachine(): Promise<LLMProvider[]> {
  const connected = await Promise.all(PROVIDER_IDS.map(async (provider) => {
    try {
      const status = await providerAuthService.getProviderAuthStatus(provider);
      return status.installed && status.authenticated ? provider : null;
    } catch {
      return null;
    }
  }));
  return connected.filter((provider): provider is LLMProvider => provider !== null);
}

/**
 * 가장 최근에 쓴 대화. `provider` 를 주면 그 AI 의 것 중에서.
 *
 * 새 대화의 기본 AI·모델과 프로젝트를 여기서 이어받는다. 사용자가 방금까지
 * 쓰던 것을 그대로 쓰는 편이 가장 덜 놀랍다.
 */
function findLastUsedSession(provider?: LLMProvider) {
  const { sessions } = sessionsDb.getRecentSessionsPage(50, 0);
  return sessions.find((session) => !provider || session.provider === provider) ?? null;
}

/** 이 AI 로 마지막에 쓴 모델. 기록이 없으면 그 AI 의 기본 모델에 맡긴다. */
function findLastUsedModel(provider: LLMProvider): string | null {
  const { sessions } = sessionsDb.getRecentSessionsPage(50, 0);
  return sessions.find((session) => session.provider === provider && session.model)?.model ?? null;
}

/**
 * AI 를 고르지 않았을 때 쓸 것: 마지막에 쓴 AI, 그게 지금 못 쓰는 것이면 Claude.
 */
function pickDefaultProvider(connected: LLMProvider[]): LLMProvider {
  const lastProvider = PROVIDER_IDS.find((id) => id === findLastUsedSession()?.provider);
  if (lastProvider && connected.includes(lastProvider)) {
    return lastProvider;
  }
  return FALLBACK_PROVIDER;
}

/**
 * 새 대화가 들어갈 프로젝트.
 *
 * 1. 지금 구독 중인 대화의 프로젝트 — 웹에서 그 대화를 다른 프로젝트로 옮겼으면
 *    옮긴 곳이다(세션 id 는 그대로이고 행의 경로가 바뀐다).
 * 2. 구독 중인 대화가 없으면 `/watch` 로 마지막에 고른 프로젝트 — 아직 대화가
 *    없는 프로젝트를 골랐을 때가 이 경우다.
 * 3. 둘 다 없으면 마지막에 쓴 대화의 프로젝트, 그것도 없으면 첫 번째 프로젝트.
 *
 * 예전에는 3 만 봤다. 그래서 폰에서 프로젝트를 고르고 `/new` 를 쳐도, 웹에서
 * 마지막에 쓰던 다른 프로젝트에 대화가 생겼다.
 */
function pickNewChatProjectPath(state: TelegramBridgeState): string | null {
  const activePaths = new Set(listActiveProjects().map((project) => project.project_path));
  const watchedPath = state.watchedSessionId
    ? sessionsDb.getSessionById(state.watchedSessionId)?.project_path ?? null
    : null;
  const candidates = [
    watchedPath,
    state.selectedProjectPath,
    findLastUsedSession()?.project_path ?? null,
  ];
  return candidates.find((candidate): candidate is string => Boolean(candidate && activePaths.has(candidate)))
    ?? listActiveProjects()[0]?.project_path
    ?? null;
}

/** 새 대화가 어느 프로젝트에 생기는지 사람이 읽을 이름. */
function describeProjectPath(projectPath: string | null): string {
  if (!projectPath) {
    return '(프로젝트 없음)';
  }
  const project = listActiveProjects().find((candidate) => candidate.project_path === projectPath);
  return project ? projectLabel(project) : projectPath;
}

function readActivePendingNewChat(state: TelegramBridgeState): PendingNewChat | null {
  const pending = state.pendingNewChat;
  if (!pending || Date.now() - pending.createdAt > PENDING_NEW_CHAT_TTL_MS) {
    return null;
  }
  return pending;
}

function describeConnected(connected: LLMProvider[]): string {
  return connected.length > 0
    ? connected.map((provider) => PROVIDER_LABELS[provider]).join(', ')
    : '없음';
}

/** 첫 메시지를 기다리는 동안 보여 줄 답. AI 를 바꿀 버튼과 취소 버튼을 단다. */
function renderPendingNewChat(
  provider: LLMProvider,
  connected: LLMProvider[],
  offerOtherProviders: boolean,
  state: TelegramBridgeState,
): TelegramReply {
  const choices = offerOtherProviders ? connected.filter((id) => id !== provider) : [];
  return {
    text: [
      // 어디에 생기는지 먼저 보여 준다. 엉뚱한 프로젝트면 첫 메시지를 보내기
      // 전에 /watch 로 고칠 수 있다.
      `새 ${PROVIDER_LABELS[provider]} 대화를 ${describeProjectPath(pickNewChatProjectPath(state))} 에 엽니다. 첫 메시지를 보내 주세요.`,
      '다른 프로젝트면 /watch 로 먼저 고르세요.',
      ...(choices.length > 0 ? ['다른 AI 로 하려면 아래에서 고르세요.'] : []),
    ].join('\n'),
    buttons: [
      ...(choices.length > 0
        ? [choices.map((id) => ({ text: PROVIDER_LABELS[id], data: `new:${id}` }))]
        : []),
      [{ text: '취소', data: 'new:cancel' }],
    ],
  };
}

/**
 * `/new [AI] [메시지]`.
 *
 * 메시지가 있으면 바로 시작한다. 없으면(메뉴에서 눌렀을 때) 다음에 오는 글을
 * 첫 메시지로 받도록 표시해 두고 기다린다.
 */
async function handleNewChatCommand(
  argument: string,
  context: CommandContext,
  state: TelegramBridgeState,
  files: TelegramIncomingFile[],
): Promise<CommandResult> {
  const connected = await (context.listConnectedProviders ?? listConnectedProvidersOnMachine)();

  // 첫 낱말이 AI 이름과 정확히 같을 때만 AI 를 고른 것으로 본다. "/new claude가
  // 뭐야" 는 기본 AI 에게 하는 질문이다.
  const [firstWord = ''] = argument.split(/\s/, 1);
  const named = PROVIDER_IDS.find((id) => id === firstWord.toLowerCase());
  const prompt = named ? argument.slice(firstWord.length).trim() : argument;

  if (named && !connected.includes(named)) {
    return `${PROVIDER_LABELS[named]} 는 이 컴퓨터에서 쓸 수 없습니다 (설치·로그인 필요).\n쓸 수 있는 AI: ${describeConnected(connected)}`;
  }

  const provider = named ?? pickDefaultProvider(connected);
  const model = findLastUsedModel(provider);

  if (prompt || files.length > 0) {
    return startNewChat(provider, model, prompt, files, context, state);
  }

  writeBridgeState(context.userId, {
    pendingNewChat: { provider, model, createdAt: Date.now() },
  });
  return renderPendingNewChat(provider, connected, !named, state);
}

/**
 * 새 대화를 만들고, 구독을 그리로 옮기고, 첫 메시지를 보낸다.
 *
 * 첫 메시지가 들어가지 못하면 만든 대화를 지우고 구독도 되돌린다. 빈 대화가
 * 사이드바에 남고 폰은 아무도 듣지 않는 대화를 구독하게 된다.
 */
async function startNewChat(
  provider: LLMProvider,
  model: string | null,
  text: string,
  files: TelegramIncomingFile[],
  context: CommandContext,
  state: TelegramBridgeState,
): Promise<CommandResult> {
  const projectPath = pickNewChatProjectPath(state);
  if (!projectPath) {
    writeBridgeState(context.userId, { pendingNewChat: null });
    return '대화를 열 프로젝트가 없습니다. 웹에서 프로젝트를 하나 추가해 주세요.';
  }

  const { sessionId } = sessionsService.createAppSession(
    provider,
    projectPath,
    text || describeAttachedFiles(files),
  );
  writeBridgeState(context.userId, {
    watchedSessionId: sessionId,
    selectedProjectPath: projectPath,
    pendingNewChat: null,
  });

  const failure = await sendPrompt(text, context, sessionId, files, model ? { model } : {});
  if (failure) {
    sessionsDb.deleteSessionById(sessionId);
    writeBridgeState(context.userId, {
      watchedSessionId: state.watchedSessionId,
      selectedProjectPath: state.selectedProjectPath,
    });
    return typeof failure === 'string' ? failure : failure.text;
  }

  // 평소에는 보냈다는 확인을 하지 않지만, 여기서는 구독이 바뀌었다는 것을
  // 알려야 한다. 이후에 보내는 글이 어디로 가는지가 달라진다.
  return `🆕 ${describeProjectPath(projectPath)} 에 새 ${PROVIDER_LABELS[provider]} 대화를 시작했습니다${model ? ` (${model})` : ''}. 이제 이 대화를 구독합니다.`;
}

// ---------------------------

/**
 * 메시지에 달린 버튼을 눌렀을 때. 브리지가 버튼 누름 갱신을 받아 부른다.
 *
 * 버튼은 명령 처리가 단 것이므로 해석도 여기서 한다. `toast` 는 버튼 위에
 * 잠깐 뜨는 짧은 문구, `reply` 는 대화창에 새로 보낼 답이다.
 */
export async function handleTelegramButton(
  data: string,
  context: CommandContext,
): Promise<{ toast: string; reply: CommandResult }> {
  const [kind, value = ''] = data.split(':', 2);

  if (kind === 'watch') {
    const project = listActiveProjects().find((candidate) => candidate.project_id === value);
    if (!project) {
      return { toast: '없어진 프로젝트입니다.', reply: renderProjectPicker('프로젝트 목록이 바뀌었습니다.') };
    }
    return { toast: projectLabel(project), reply: watchProject(project, context.userId) };
  }

  if (kind === 'steer' || kind === 'qclear') {
    if (!sessionsDb.getSessionById(value)) {
      return { toast: '없어진 대화입니다.', reply: null };
    }

    if (kind === 'qclear') {
      const cleared = clearQueuedPrompts(context.userId, value);
      return {
        toast: cleared > 0 ? `${cleared}건 비움` : '비어 있음',
        reply: cleared > 0 ? `🗑 대기열 ${cleared}건을 비웠습니다.` : null,
      };
    }

    // 끼어들기: 지금 턴을 멈추면 대기열 맨 앞의 글이 곧바로 실행된다.
    const queued = listQueuedPrompts(context.userId, value).length;
    if (queued === 0) {
      return { toast: '대기열이 비어 있음', reply: '대기열에 남은 글이 없습니다. 이미 실행됐을 수 있습니다.' };
    }
    if (!(await abortRunningTurn(context.runtime, value))) {
      return { toast: '곧 실행', reply: '돌고 있는 턴이 없어 대기열의 글이 곧 실행됩니다.' };
    }
    return { toast: '끼어들기', reply: `⚡ 지금 턴을 멈췄습니다. 대기열의 글을 바로 실행합니다 (${queued}건).` };
  }

  if (kind === 'new' && value === 'cancel') {
    writeBridgeState(context.userId, { pendingNewChat: null });
    return { toast: '취소', reply: '새 대화를 열지 않습니다.' };
  }

  if (kind === 'new') {
    const connected = await (context.listConnectedProviders ?? listConnectedProvidersOnMachine)();
    const provider = PROVIDER_IDS.find((id) => id === value);
    if (!provider || !connected.includes(provider)) {
      return { toast: '쓸 수 없는 AI 입니다.', reply: `쓸 수 있는 AI: ${describeConnected(connected)}` };
    }

    const state = writeBridgeState(context.userId, {
      pendingNewChat: { provider, model: findLastUsedModel(provider), createdAt: Date.now() },
    });
    return { toast: PROVIDER_LABELS[provider], reply: renderPendingNewChat(provider, connected, false, state) };
  }

  return { toast: '더 이상 쓸 수 없는 버튼입니다.', reply: null };
}
