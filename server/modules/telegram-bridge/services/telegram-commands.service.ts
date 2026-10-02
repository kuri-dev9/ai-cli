import { messageSourcesDb, projectsDb, sessionDraftsDb, sessionsDb } from '@/modules/database/index.js';
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
    return `${projectLabel(project)} 에는 아직 대화가 없습니다. /new 로 새 대화를 시작할 수 있습니다.`;
  }

  writeBridgeState(userId, { watchedSessionId: session.session_id, pendingNewChat: null });
  return `${projectLabel(project)} 의 최신 대화를 구독한다.\n${describeSession(session.session_id)}`;
}

/** 프로젝트에서 가장 최근에 손댄 세션. `/watch` 가 고르는 대상이다. */
function findLatestSession(projectPath: string) {
  const sessions = sessionsDb.getSessionsByProjectPath(projectPath);
  if (sessions.length === 0) {
    return null;
  }
  return [...sessions].sort((a, b) => b.updated_at.localeCompare(a.updated_at))[0];
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
  '/unwatch         구독을 놓는다. 이 대화로 오는 것을 전부 멈춘다',
  '/on              구독 중인 대화의 웹 작업까지 알림 받기',
  '/off             웹 작업 알림 끄기. 구독은 유지된다',
  '/allow [번호]    승인 대기 중인 도구를 허용',
  '/deny [번호]     승인 대기 중인 도구를 거부',
  '/stop            지금 돌고 있는 턴을 중단',
  '',
  '이쪽으로 무엇이 오는지',
  '',
  '1. 여기서 보낸 작업의 결과 — 항상 온다. /off 로도 막히지 않는다.',
  '2. 웹에서 시작한 작업의 결과 — /on 으로 켠 대화만.',
  '3. 웹 화면의 빠른 설정에서 넘기기를 켜면 그 대화를 이쪽으로 넘겨받는다.',
  '   넘겨받으면 구독과 알림이 함께 켜지므로, 그 뒤로는 그 대화의 웹 작업도',
  '   전부 이쪽으로 온다. 이렇게 넘어온 작업은 승인을 묻지 않고 진행한다 —',
  '   여기서는 승인 창을 띄울 수 없기 때문이다.',
  '',
  '브라우저로 돌아왔으면 같은 자리에서 넘기기를 끄면 이 대화를 놓는다.',
  '여기서 멈추려면 /unwatch, 웹 작업 알림만 끄려면 /off 를 쓴다.',
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

    case '/on':
    case '/off': {
      // 이제 이 스위치는 "구독 중인 세션의 웹 작업까지 알릴지"만 정한다.
      // 여기서 보낸 작업의 결과는 이 값과 무관하게 항상 돌아온다.
      if (!state.watchedSessionId) {
        return '구독 중인 세션이 없습니다. /projects 로 고른 뒤 /watch 해 주세요.';
      }

      const enabled = command === '/on';
      setSessionNotified(context.userId, state.watchedSessionId, enabled);
      return enabled
        ? '이 세션은 웹에서 시작한 작업도 끝나면 알려준다.'
        : '이 세션의 웹 작업은 알리지 않는다. 여기서 보낸 작업의 결과는 계속 온다.';
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
      const lines = [
        `세션: ${describeSession(state.watchedSessionId)}`,
        `상태: ${running ? '작업 중' : '대기'}`,
        // 문구가 "알림: 켜짐" 하나였을 때는 거짓말이었다 — 여기서 보낸 작업의
        // 결과는 이 값과 무관하게 항상 오는데, 꺼져 있으면 아무것도 안 온다고
        // 읽힌다.
        `웹 작업 알림: ${notified ? '켜짐 (/off 로 끔)' : '꺼짐 (/on 으로 켬)'}`,
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
      const run = chatRunRegistry.getRun(state.watchedSessionId);
      if (!run || run.status !== 'running') {
        return '돌고 있는 턴이 없습니다.';
      }

      const aborted = await context.runtime.abort(run.provider, state.watchedSessionId);
      chatRunRegistry.completeRun(state.watchedSessionId, { exitCode: aborted ? 0 : 1, aborted: true });
      return '중단했습니다.';
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

/** 구독 중인 세션에 한 턴을 밀어넣는다. */
async function sendPrompt(
  text: string,
  context: CommandContext,
  watchedSessionId: string | null,
  files: TelegramIncomingFile[] = [],
  /** 실행 옵션에 더 실을 것. 새 대화가 이어 쓸 모델을 넘길 때 쓴다. */
  runOptions: Record<string, unknown> = {},
): Promise<string | null> {
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
    return `작업 중이라 대기열에 넣었습니다. 앞에 ${waiting - 1}건 있고, 끝나는 대로 순서대로 실행합니다.`;
  }

  // 턴을 시작하기 전에 적는다. CLI 가 기록에 메시지를 쓰는 것은 실행 중이고,
  // 그때 우리가 끼어들 자리는 없다.
  const sourceMarkId = messageSourcesDb.markMessageSource(watchedSessionId, prompt, 'telegram');

  const result = await runDetachedChatTurn(
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
  );

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
 * 새 대화가 들어갈 프로젝트: 마지막에 쓴 대화의 프로젝트.
 *
 * 텔레그램에서는 프로젝트를 고르게 하지 않는다. 대화는 어딘가의 폴더에서 돌아야
 * 하고 웹 사이드바도 프로젝트 아래에 보여 주므로, 방금까지 쓰던 곳에 둔다.
 * 기록이 하나도 없으면 첫 번째 프로젝트.
 */
function pickNewChatProjectPath(): string | null {
  return findLastUsedSession()?.project_path
    ?? listActiveProjects()[0]?.project_path
    ?? null;
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
): TelegramReply {
  const choices = offerOtherProviders ? connected.filter((id) => id !== provider) : [];
  return {
    text: [
      `새 ${PROVIDER_LABELS[provider]} 대화를 엽니다. 첫 메시지를 보내 주세요.`,
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
  return renderPendingNewChat(provider, connected, !named);
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
  const projectPath = pickNewChatProjectPath();
  if (!projectPath) {
    writeBridgeState(context.userId, { pendingNewChat: null });
    return '대화를 열 프로젝트가 없습니다. 웹에서 프로젝트를 하나 추가해 주세요.';
  }

  const { sessionId } = sessionsService.createAppSession(
    provider,
    projectPath,
    text || describeAttachedFiles(files),
  );
  writeBridgeState(context.userId, { watchedSessionId: sessionId, pendingNewChat: null });

  const failure = await sendPrompt(text, context, sessionId, files, model ? { model } : {});
  if (failure) {
    sessionsDb.deleteSessionById(sessionId);
    writeBridgeState(context.userId, { watchedSessionId: state.watchedSessionId });
    return failure;
  }

  // 평소에는 보냈다는 확인을 하지 않지만, 여기서는 구독이 바뀌었다는 것을
  // 알려야 한다. 이후에 보내는 글이 어디로 가는지가 달라진다.
  return `🆕 새 ${PROVIDER_LABELS[provider]} 대화를 시작했습니다${model ? ` (${model})` : ''}. 이제 이 대화를 구독합니다.`;
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

    writeBridgeState(context.userId, {
      pendingNewChat: { provider, model: findLastUsedModel(provider), createdAt: Date.now() },
    });
    return { toast: PROVIDER_LABELS[provider], reply: renderPendingNewChat(provider, connected, false) };
  }

  return { toast: '더 이상 쓸 수 없는 버튼입니다.', reply: null };
}
