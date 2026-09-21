import { messageSourcesDb, projectsDb, sessionDraftsDb, sessionsDb } from '@/modules/database/index.js';
import { chatRunRegistry, runDetachedChatTurn } from '@/modules/websocket/index.js';
import type { ProviderRuntimeGateway } from '@/modules/websocket/index.js';
import {
  isSessionNotified,
  readBridgeState,
  setSessionNotified,
  writeBridgeState,
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
};

/** 사람이 읽을 이름. 사용자 지정 이름이 없으면 폴더 이름을 쓴다. */
function projectLabel(project: { custom_project_name: string | null; project_path: string }): string {
  return project.custom_project_name || project.project_path.split('/').filter(Boolean).pop() || project.project_path;
}

function listActiveProjects() {
  return projectsDb.getProjectPaths().filter((project) => !project.isArchived);
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
  '3. 웹 입력 맨 앞에 /bot 을 붙이면 그 대화를 이쪽으로 넘겨받는다.',
  '   넘겨받으면 구독과 알림이 함께 켜지므로, 그 뒤로는 그 대화의 웹 작업도',
  '   전부 이쪽으로 온다.',
  '',
  '전부 멈추려면 /unwatch, 웹 작업만 멈추려면 /off 를 쓴다.',
  '',
  '슬래시 없이 보낸 글은 구독 중인 대화에 그대로 들어간다.',
].join('\n');

/**
 * 한 줄을 처리하고 사용자에게 돌려줄 답을 만든다.
 *
 * 답이 `null` 이면 아무것도 보내지 않는다.
 */
export async function handleTelegramCommand(
  text: string,
  context: CommandContext,
): Promise<string | null> {
  const trimmed = text.trim();
  if (!trimmed) {
    return null;
  }

  const state = readBridgeState(context.userId);
  const [rawCommand, ...rest] = trimmed.split(/\s+/);
  const command = rawCommand.toLowerCase();
  const argument = rest.join(' ');

  if (!trimmed.startsWith('/')) {
    return sendPrompt(trimmed, context, state.watchedSessionId);
  }

  switch (command) {
    case '/help':
    case '/start':
      return HELP_TEXT;

    case '/unwatch': {
      // 넘겨받은 대화를 통째로 놓는 길. `/off` 는 웹 작업 알림만 끄고 구독은
      // 남기므로, `/bot` 으로 끌어온 대화를 완전히 멈출 방법이 없었다.
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

    case '/projects': {
      const projects = listActiveProjects();
      if (projects.length === 0) {
        return '프로젝트가 없습니다.';
      }
      return [
        '프로젝트',
        ...projects.map((project, index) => `${index + 1}. ${projectLabel(project)}`),
        '',
        '/watch <번호> 로 구독합니다.',
      ].join('\n');
    }

    case '/watch': {
      const projects = listActiveProjects();
      // 번호로도, 이름 일부로도 고를 수 있다. 폰에서 긴 이름을 치기 번거롭다.
      const index = Number.parseInt(argument, 10);
      const picked = Number.isFinite(index) && index >= 1 && index <= projects.length
        ? projects[index - 1]
        : projects.find((project) => projectLabel(project).toLowerCase().includes(argument.toLowerCase()));

      if (!argument || !picked) {
        return '어느 프로젝트인지 모르겠습니다. /projects 로 번호를 확인해 주세요.';
      }

      const session = findLatestSession(picked.project_path);
      if (!session) {
        return `${projectLabel(picked)} 에는 아직 대화가 없습니다. 브라우저에서 한 번 시작한 뒤 다시 /watch 해 주세요.`;
      }

      writeBridgeState(context.userId, { watchedSessionId: session.session_id });
      return `${projectLabel(picked)} 의 최신 대화를 구독한다.\n${describeSession(session.session_id)}`;
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

/** 구독 중인 세션에 한 턴을 밀어넣는다. */
async function sendPrompt(
  prompt: string,
  context: CommandContext,
  watchedSessionId: string | null,
): Promise<string | null> {
  if (!watchedSessionId) {
    return '구독 중인 세션이 없습니다. /projects 로 고른 뒤 /watch 해 주세요.';
  }

  // 작업 중이면 거절하지 않고 줄을 세운다. 브라우저에서 실행 중인 턴 뒤에
  // 메시지를 넣는 것과 같은 길을 쓰므로, 디스패처가 턴이 끝나는 즉시 보낸다.
  if (chatRunRegistry.isProcessing(watchedSessionId)) {
    // `origin` 도 같이 넣는다. 대기열을 비우는 쪽(예약 메시지 디스패처)이
    // 실행을 시작할 때 이 표시를 그대로 넘겨야, 한참 뒤에 실행돼도 결과가
    // 텔레그램으로 돌아온다.
    sessionDraftsDb.appendQueuedMessage(context.userId, watchedSessionId, {
      content: prompt,
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
      // 이 표시가 브리지의 회신 근거다. 텔레그램에서 시작한 실행은 알림 설정과
      // 무관하게 결과를 돌려보낸다.
      origin: 'telegram',
    },
    { runtime: context.runtime },
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
