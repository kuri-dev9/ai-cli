import { chatRunRegistry } from '@/modules/websocket/index.js';
import type { ProviderRuntimeGateway } from '@/modules/websocket/index.js';
import type { NormalizedMessage } from '@/shared/types.js';
import { handleTelegramCommand } from '@/modules/telegram-bridge/services/telegram-commands.service.js';
import { createTelegramClient } from '@/modules/telegram-bridge/services/telegram-client.service.js';
import type { TelegramClient } from '@/modules/telegram-bridge/services/telegram-client.service.js';
import { readTelegramSettings } from '@/modules/telegram-bridge/services/telegram-settings.service.js';
import {
  isSessionNotified,
  readBridgeState,
  readBridgeUserId,
  writeBridgeState,
} from '@/modules/telegram-bridge/services/telegram-state.service.js';

/**
 * 텔레그램에서 명령을 받고, 구독 중인 세션의 결과를 돌려보내는 통로.
 *
 * 폴링이 실패해도 서버가 죽지 않아야 한다 — 네트워크가 잠깐 끊기거나 텔레그램이
 * 5xx 를 주는 일은 늘 있고, 그때마다 알림 통로 하나 때문에 앱 전체가 내려가면
 * 안 된다. 그래서 모든 실패는 백오프 후 재시도로만 처리한다.
 */

/** 연속 실패 시 재시도 간격. 마지막 값에서 더 늘리지 않는다. */
const RETRY_BACKOFF_MS = [1_000, 5_000, 15_000, 60_000];

type BridgeConfig = {
  botToken: string;
  allowedChatIds: number[];
  runtime: ProviderRuntimeGateway;
  /**
   * 텔레그램 대신 쓸 클라이언트. 테스트만 넘긴다 — 알림 규칙은 실제로
   * 보내진 메시지로만 확인할 수 있는데, 그러자고 폴링과 네트워크를 띄울 수는
   * 없다.
   */
  client?: TelegramClient;
};

type BridgeHandle = {
  stop: () => void;
};

let activeBridge: BridgeHandle | null = null;

/**
 * 마지막으로 받아 둔 런타임.
 *
 * 설정 화면에서 저장을 누르면 브리지를 다시 띄워야 하는데, 라우트는 런타임을
 * 들고 있지 않다. 부팅 때 한 번 받은 것을 모듈에 남겨 두면 라우트가 런타임을
 * 어디선가 끌어오지 않고도 재시작을 시킬 수 있다.
 */
let activeRuntime: ProviderRuntimeGateway | null = null;

const sleep = (ms: number) => new Promise<void>((resolve) => {
  const timer = setTimeout(resolve, ms);
  timer.unref?.();
});

/**
 * 이 턴이 남긴 마지막 답변.
 *
 * 스트리밍 조각(`stream_delta`)이 아니라 확정된 `text` 만 본다 — 조각을 이어
 * 붙이면 같은 내용이 두 번 들어가거나 중간에서 잘린다.
 */
function readFinalAssistantText(sessionId: string): string | null {
  const events = chatRunRegistry.replayEvents(sessionId, 0) as NormalizedMessage[];
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event.kind === 'text' && event.role === 'assistant' && event.content?.trim()) {
      return event.content.trim();
    }
  }
  return null;
}

/** 이 턴에서 발생한 에러 메시지들. */
function readErrors(sessionId: string): string[] {
  const events = chatRunRegistry.replayEvents(sessionId, 0) as NormalizedMessage[];
  return events
    .filter((event) => event.kind === 'error' && event.content?.trim())
    .map((event) => event.content!.trim());
}

/**
 * 이 실행의 결과를 텔레그램으로 보낼지.
 *
 * 규칙은 셋뿐이고, 순서가 곧 의미다.
 *
 * 1. 텔레그램에서 시작한 실행은 무조건 보낸다. 사용자가 폰 앞에서 답을
 *    기다리고 있고, 이게 브리지가 존재하는 이유다. 알림 설정이 꺼져 있어도
 *    막지 않는다.
 * 2. 웹 실행은 `/bot` 접두어가 붙은 그 한 번만 보낸다.
 * 3. 그 밖의 웹 실행은 세션 알림을 켜 둔 동안에만 보낸다.
 *
 * 어느 것도 아니면 조용하다. 기본이 조용한 쪽이어야 한다 — 브라우저에서
 * 대화할 때마다 폰이 울리면 알림 전체가 소음이 되고, 정작 기다리던 회신을
 * 놓친다.
 */
export function shouldRelayCompletion(sessionId: string): boolean {
  const run = chatRunRegistry.describeRunOrigin(sessionId);
  if (run?.origin === 'telegram') {
    return true;
  }
  if (run?.relayRequested) {
    return true;
  }

  const userId = readBridgeUserId();
  if (userId === null) {
    return false;
  }
  return isSessionNotified(userId, sessionId);
}

/**
 * `/bot` 을 붙인 실행을 텔레그램으로 넘겨받는다.
 *
 * `/bot` 은 결과 한 번을 받고 끝나는 것이 아니라 "이 대화를 폰으로 가져간다"는
 * 뜻이다. 그래서 명령이 들어갈 세션(`watchedSessionId`)을 이쪽으로 옮기고 알림도
 * 켠다 — 그래야 폰에서 그냥 답장했을 때 보던 그 대화에 이어진다.
 *
 * 이게 없으면 자리를 뜨기 직전에 텔레그램을 열어 /projects, /watch 로 세션을 다시
 * 골라야 한다. 그 번거로움을 없애려고 만든 길이다.
 *
 * @returns 이번에 새로 넘겨받았으면 `true`. 이미 넘겨받은 대화면 `false` —
 *   `/bot` 을 연달아 쓸 때마다 같은 안내가 쌓이지 않게 한다.
 */
export function claimRelayHandoff(sessionId: string): boolean {
  const run = chatRunRegistry.describeRunOrigin(sessionId);
  // 텔레그램에서 온 실행은 이미 이 세션을 보고 있다는 뜻이라 옮길 것이 없다.
  if (!run?.relayRequested || run.origin === 'telegram') {
    return false;
  }

  const userId = readBridgeUserId();
  if (userId === null) {
    return false;
  }

  const state = readBridgeState(userId);
  if (state.watchedSessionId === sessionId && state.notifiedSessionIds.includes(sessionId)) {
    return false;
  }

  writeBridgeState(userId, {
    watchedSessionId: sessionId,
    notifiedSessionIds: [
      ...state.notifiedSessionIds.filter((entry) => entry !== sessionId),
      sessionId,
    ],
  });
  return true;
}

/**
 * 텔레그램 입력창의 `/` 메뉴에 올릴 목록.
 *
 * `/help` 본문과 짝이 맞아야 한다 — 한쪽에만 있는 명령이 생기면 메뉴를 믿고
 * 쓰던 사람은 그 기능이 없는 줄 안다.
 */
const BOT_COMMAND_MENU = [
  { command: 'help', description: '명령 목록' },
  { command: 'status', description: '무엇이 돌고 있는지' },
  { command: 'projects', description: '프로젝트 목록' },
  { command: 'watch', description: '<번호|이름> 그 프로젝트의 최신 대화를 구독' },
  { command: 'unwatch', description: '구독을 놓는다 (이쪽으로 오는 것을 전부 멈춤)' },
  { command: 'on', description: '웹 작업 알림 켜기' },
  { command: 'off', description: '웹 작업 알림 끄기' },
  { command: 'allow', description: '승인 대기 중인 도구를 허용' },
  { command: 'deny', description: '승인 대기 중인 도구를 거부' },
  { command: 'stop', description: '돌고 있는 턴을 중단' },
];

export function startTelegramBridge(config: BridgeConfig): BridgeHandle {
  const client = config.client ?? createTelegramClient(config.botToken);
  const allowed = new Set(config.allowedChatIds);
  const abortController = new AbortController();
  let stopped = false;

  // 실패해도 브리지는 뜬다. 메뉴가 비는 것과 통로가 막히는 것은 무게가 다르다.
  // 테스트가 넘기는 가짜 클라이언트에는 이 메서드가 없을 수 있다.
  if (typeof client.setMyCommands === 'function') {
    void client.setMyCommands(BOT_COMMAND_MENU).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      console.error('[TelegramBridge] Failed to register the command menu', { error: message });
    });
  }

  /** 화이트리스트에 있는 모두에게. 보통 본인 한 명이다. */
  const broadcast = async (text: string): Promise<void> => {
    for (const chatId of allowed) {
      try {
        await client.sendMessage(chatId, text);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error('[TelegramBridge] Failed to send message', { chatId, error: message });
      }
    }
  };

  const unsubscribeStarted = chatRunRegistry.onRunStarted((sessionId) => {
    if (!claimRelayHandoff(sessionId)) {
      return;
    }
    void broadcast('📎 이 대화를 이어받았습니다. 그냥 답장하면 여기로 들어갑니다.');
  });

  const unsubscribeSettled = chatRunRegistry.onRunSettled((sessionId) => {
    if (!shouldRelayCompletion(sessionId)) {
      return;
    }

    const errors = readErrors(sessionId);
    if (errors.length > 0) {
      void broadcast(`⚠ 오류로 끝났습니다.\n\n${errors.join('\n')}`);
      return;
    }

    const finalText = readFinalAssistantText(sessionId);
    void broadcast(finalText ? `✅ 완료\n\n${finalText}` : '✅ 완료 (남긴 답변 없음)');
  });

  const poll = async (): Promise<void> => {
    let offset = 0;
    let failures = 0;

    while (!stopped) {
      try {
        const updates = await client.getUpdates(offset, abortController.signal);
        failures = 0;

        for (const update of updates) {
          // 처리 여부와 무관하게 offset 은 전진시킨다. 화이트리스트 밖의
          // 메시지 하나가 큐 맨 앞에 남아 폴링을 영원히 막으면 안 된다.
          offset = update.updateId + 1;

          const message = update.message;
          if (!message) {
            continue;
          }

          // 화이트리스트 밖이면 응답조차 하지 않는다. 봇 username 은 검색으로
          // 알아낼 수 있으므로 이 검사가 유일한 잠금장치이고, 답을 주면
          // "여기 뭔가 돌고 있다"는 사실까지 알려주게 된다.
          if (!allowed.has(message.chatId)) {
            console.warn('[TelegramBridge] Ignored a message from an unlisted chat', {
              chatId: message.chatId,
            });
            continue;
          }

          const userId = readBridgeUserId();
          if (userId === null) {
            await client.sendMessage(message.chatId, '아직 사용자가 없습니다. 웹에서 먼저 가입해 주세요.');
            continue;
          }

          try {
            const reply = await handleTelegramCommand(message.text, {
              userId,
              runtime: config.runtime,
            });
            if (reply) {
              await client.sendMessage(message.chatId, reply);
            }
          } catch (error) {
            const reason = error instanceof Error ? error.message : String(error);
            console.error('[TelegramBridge] Command failed', { error: reason });
            await client.sendMessage(message.chatId, `처리하지 못했습니다: ${reason}`);
          }
        }
      } catch (error) {
        if (stopped || abortController.signal.aborted) {
          return;
        }

        const reason = error instanceof Error ? error.message : String(error);
        const backoff = RETRY_BACKOFF_MS[Math.min(failures, RETRY_BACKOFF_MS.length - 1)];
        failures += 1;
        console.error('[TelegramBridge] Poll failed; retrying', { error: reason, backoff });
        await sleep(backoff);
      }
    }
  };

  void poll();

  return {
    stop() {
      stopped = true;
      abortController.abort();
      unsubscribeStarted();
      unsubscribeSettled();
    },
  };
}

/**
 * 설정이 갖춰졌을 때만 브리지를 켠다.
 *
 * 설정은 DB(설정 화면)에서 읽는다. `.env` 는 `readTelegramSettings` 안에서
 * 폴백으로만 남아 있다 — 이미 환경변수로 돌려 둔 설치를 깨지 않으면서, 화면에서
 * 방금 바꾼 값이 오래된 환경변수에 밀리지 않게 하기 위해서다.
 *
 * 토큰이나 화이트리스트가 없으면 조용히 넘어간다 — 이 기능을 쓰지 않는 설치가
 * 기본이고, 그런 설치에서 경고를 띄울 이유가 없다.
 */
export function initializeTelegramBridge(runtime: ProviderRuntimeGateway): void {
  // 켜지 못하는 설정이어도 런타임은 기억해 둔다. 설정 화면에서 토큰을 넣고
  // 저장했을 때 서버를 재시작하지 않고 바로 켤 수 있어야 한다.
  activeRuntime = runtime;

  if (activeBridge) {
    return;
  }

  const settings = readTelegramSettings();

  // 연결을 지우지 않고 잠시 멈춰 두는 스위치. 토큰이 멀쩡해도 켜지 않는다.
  if (!settings.enabled) {
    return;
  }

  if (!settings.botToken) {
    return;
  }

  // 토큰만 있고 화이트리스트가 비어 있으면 켜지 않는다. 그 상태로 열면 봇을
  // 찾아낸 누구나 이 머신에서 명령을 돌릴 수 있다.
  if (settings.allowedChatIds.length === 0) {
    console.error(
      '[TelegramBridge] A bot token is set but no chat id is allowed; the bridge stays off.',
    );
    return;
  }

  activeBridge = startTelegramBridge({
    botToken: settings.botToken,
    allowedChatIds: settings.allowedChatIds,
    runtime,
  });
  console.log('[TelegramBridge] Listening for commands', {
    allowedChats: settings.allowedChatIds.length,
  });
}

/**
 * 바뀐 설정으로 다시 띄운다.
 *
 * `initializeTelegramBridge` 는 이미 떠 있으면 그대로 돌아가므로, 설정이 바뀐
 * 뒤에 그것만 부르면 옛 토큰으로 계속 폴링한다. 반드시 먼저 닫아야 한다.
 *
 * 런타임을 받지 않으면 기억해 둔 것을 쓴다. 아직 한 번도 받은 적이 없다면
 * (부팅 전) 껐다 켤 수 없으므로 닫기만 하고 끝낸다.
 */
export function restartTelegramBridge(runtime?: ProviderRuntimeGateway): void {
  const nextRuntime = runtime ?? activeRuntime;
  closeTelegramBridge();

  if (!nextRuntime) {
    return;
  }
  initializeTelegramBridge(nextRuntime);
}

/** 지금 실제로 폴링 중인지. 설정이 켜져 있는 것과는 다르다. */
export function isTelegramBridgeRunning(): boolean {
  return activeBridge !== null;
}

export function closeTelegramBridge(): void {
  activeBridge?.stop();
  activeBridge = null;
}
