import { chatRunRegistry } from '@/modules/websocket/index.js';
import type { ProviderRuntimeGateway } from '@/modules/websocket/index.js';
import type { NormalizedMessage } from '@/shared/types.js';
import {
  handleTelegramButton,
  handleTelegramCommand,
} from '@/modules/telegram-bridge/services/telegram-commands.service.js';
import type { TelegramReply } from '@/modules/telegram-bridge/services/telegram-commands.service.js';
import { createTelegramClient } from '@/modules/telegram-bridge/services/telegram-client.service.js';
import type {
  TelegramButtonPress,
  TelegramClient,
  TelegramMessage,
  TelegramUpdate,
} from '@/modules/telegram-bridge/services/telegram-client.service.js';
import { readTelegramSettings } from '@/modules/telegram-bridge/services/telegram-settings.service.js';
import {
  readTurnImageCandidates,
  relayTurnImages,
} from '@/modules/telegram-bridge/services/telegram-turn-images.service.js';
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

/**
 * 앨범의 나머지 장을 기다리는 시간(초).
 *
 * 텔레그램은 여러 장을 한 번에 보내도 장마다 갱신을 따로 만들고, long polling
 * 은 첫 장이 도착하자마자 돌아오므로 나머지가 다음 응답으로 밀릴 수 있다.
 * 그동안 짧게 한 번 더 물어보고, 그 사이 더 오는 것이 없으면 다 왔다고 본다.
 */
const ALBUM_WAIT_SECONDS = 2;

/** 아직 다 오지 않았을 수 있는 앨범. 장마다 온 메시지를 모아 둔다. */
type PendingAlbum = {
  chatId: number;
  mediaGroupId: string;
  messages: TelegramMessage[];
};

/**
 * 앨범의 장들을 메시지 하나로 합친다.
 *
 * 캡션은 보통 한 장에만 붙지만, 여러 장에 붙어 오면 순서대로 잇는다.
 */
function mergeAlbum(album: PendingAlbum): TelegramMessage {
  const [first] = album.messages;
  return {
    ...first,
    text: album.messages.map((message) => message.text.trim()).filter(Boolean).join('\n\n'),
    files: album.messages.flatMap((message) => message.files),
  };
}

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
 * 지금 돌고 있는 브리지의 송신구.
 *
 * 실행 흐름 밖에서 — 넘기기 버튼을 눌렀을 때처럼 — 한 줄 보내야 할 때 쓴다.
 * 브리지가 꺼져 있으면 `null` 이고, 그때는 보낼 곳이 없는 것이 맞다.
 */
let activeBroadcast: ((text: string) => Promise<void>) | null = null;

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
 * 2. 웹 실행은 넘기기를 켜 둔 대화의 것만 보낸다.
 * 3. 그 밖의 웹 실행은 세션 알림을 켜 둔 동안에만 보낸다.
 *
 * 어느 것도 아니면 조용하다. 기본이 조용한 쪽이어야 한다 — 브라우저에서
 * 대화할 때마다 폰이 울리면 알림 전체가 소음이 되고, 정작 기다리던 회신을
 * 놓친다.
 */
export function shouldRelayCompletion(sessionId: string): boolean {
  if (chatRunRegistry.describeRunOrigin(sessionId)?.origin === 'telegram') {
    return true;
  }
  return isSessionHandedToTelegram(sessionId);
}

/**
 * 이 대화가 지금 폰으로 넘어가 있는지.
 *
 * 넘기기 버튼이 켜 둔 값 하나만 본다. 웹소켓 쪽이 승인을 자동으로 처리할지
 * 고를 때도 같은 값을 읽는다 — 승인 창은 붙어 있는 브라우저에만 그려지므로,
 * 넘겨 둔 대화에서 평소처럼 물으면 폰에는 아무것도 뜨지 않은 채 거부로 끝난다.
 */
export function isSessionHandedToTelegram(sessionId: string): boolean {
  const userId = readBridgeUserId();
  return userId !== null && isSessionNotified(userId, sessionId);
}

/**
 * 넘기기 버튼을 눌렀다는 사실을 폰에 한 줄로 알린다.
 *
 * 값을 바꾸는 것은 상태 계층(`setSessionNotified`)이고 여기서는 알리기만 한다.
 * 브리지가 꺼져 있으면 보낼 곳이 없으므로 조용히 넘어간다.
 */
export function announceRelayHandoff(enabled: boolean): void {
  void activeBroadcast?.(enabled
    ? '📎 이 대화를 이어받았습니다. 그냥 답장하면 여기로 들어갑니다.'
    : '🔇 이 대화를 놓았습니다. 브라우저에서 이어집니다.');
}

/**
 * 텔레그램 입력창의 `/` 메뉴에 올릴 목록.
 *
 * `/help` 본문과 짝이 맞아야 한다 — 한쪽에만 있는 명령이 생기면 메뉴를 믿고
 * 쓰던 사람은 그 기능이 없는 줄 안다.
 */
const BOT_COMMAND_MENU = [
  { command: 'help', description: '명령 목록' },
  { command: 'new', description: '[AI] [메시지] 새 대화 시작' },
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

  activeBroadcast = broadcast;

  const unsubscribeSettled = chatRunRegistry.onRunSettled((sessionId) => {
    if (!shouldRelayCompletion(sessionId)) {
      return;
    }

    // 기록은 여기서 동기로 다 읽어 둔다. 대기열에 다음 메시지가 있으면 곧바로
    // 새 실행이 같은 세션 자리를 차지해서, 한 박자 늦게 읽으면 다른 턴의 것이다.
    const imageCandidates = readTurnImageCandidates(sessionId);
    const errors = readErrors(sessionId);
    const finalText = readFinalAssistantText(sessionId);
    let summary = finalText ? `✅ 완료\n\n${finalText}` : '✅ 완료 (남긴 답변 없음)';
    if (errors.length > 0) {
      summary = `⚠ 오류로 끝났습니다.\n\n${errors.join('\n')}`;
    }

    // 그림은 설명 뒤에 온다. 오류로 끝났어도 그 전에 만든 그림은 보낸다.
    void (async () => {
      await broadcast(summary);
      if (imageCandidates && imageCandidates.paths.length > 0) {
        await relayTurnImages(client, [...allowed], imageCandidates);
      }
    })().catch((error: unknown) => {
      const reason = error instanceof Error ? error.message : String(error);
      console.error('[TelegramBridge] Failed to relay the turn result', { sessionId, error: reason });
    });
  });

  /** 명령 처리의 답을 보낸다. 버튼이 달린 답이면 버튼째 보낸다. */
  const sendReply = async (chatId: number, reply: string | TelegramReply | null): Promise<void> => {
    if (!reply) {
      return;
    }
    if (typeof reply === 'string') {
      await client.sendMessage(chatId, reply);
      return;
    }
    await client.sendMessage(chatId, reply.text, reply.buttons);
  };

  /**
   * 버튼을 눌렀을 때. 메시지와 달리 먼저 텔레그램에 "받았다"고 답해야 버튼의
   * 로딩 표시가 멈춘다.
   */
  const handleButtonPress = async (press: TelegramButtonPress): Promise<void> => {
    const userId = readBridgeUserId();
    if (userId === null) {
      await client.answerButtonPress(press.queryId);
      return;
    }

    try {
      const { toast, reply } = await handleTelegramButton(press.data, {
        userId,
        runtime: config.runtime,
      });
      await client.answerButtonPress(press.queryId, toast);
      // 고른 목록의 버튼은 걷어 낸다. 남겨 두면 한참 뒤에 눌렀을 때 그때와
      // 상황이 달라 엉뚱한 것이 골라진다.
      await client.clearButtons(press.chatId, press.messageId).catch(() => {});
      await sendReply(press.chatId, reply);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      console.error('[TelegramBridge] Button failed', { error: reason });
      await client.answerButtonPress(press.queryId).catch(() => {});
      await client.sendMessage(press.chatId, `처리하지 못했습니다: ${reason}`);
    }
  };

  /** 화이트리스트를 통과한 메시지 하나(또는 합친 앨범 하나)를 처리한다. */
  const handleMessage = async (message: TelegramMessage): Promise<void> => {
    const userId = readBridgeUserId();
    if (userId === null) {
      await client.sendMessage(message.chatId, '아직 사용자가 없습니다. 웹에서 먼저 가입해 주세요.');
      return;
    }

    try {
      const reply = await handleTelegramCommand(
        message.text,
        {
          userId,
          runtime: config.runtime,
          downloadFile: (fileId, signal) => client.downloadFile(fileId, signal),
        },
        message.files,
      );
      await sendReply(message.chatId, reply);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      console.error('[TelegramBridge] Command failed', { error: reason });
      await client.sendMessage(message.chatId, `처리하지 못했습니다: ${reason}`);
    }
  };

  const poll = async (): Promise<void> => {
    // 디스크에 남겨 둔 지점부터 이어 받는다. 여기서 0 부터 다시 시작하면
    // 텔레그램은 재시작 직전에 보낸 갱신을 "아직 확인 안 됨"으로 보고 또
    // 보낸다 — 세션이 바쁜 동안이면 그 메시지가 재시작 횟수만큼 대기열에
    // 중복으로 쌓인다.
    const startupUserId = readBridgeUserId();
    let offset = startupUserId !== null ? readBridgeState(startupUserId).lastUpdateOffset : 0;
    let failures = 0;
    let pendingAlbum: PendingAlbum | null = null;

    while (!stopped) {
      try {
        // 앨범을 모으는 중이면 짧게 묻는다. 길게 매달리면 나머지 장이 없을
        // 때 앨범이 30 초 동안 실행되지 않는다.
        const updates: TelegramUpdate[] = pendingAlbum
          ? await client.getUpdates(offset, abortController.signal, ALBUM_WAIT_SECONDS)
          : await client.getUpdates(offset, abortController.signal);
        failures = 0;

        for (const update of updates) {
          // 처리 여부와 무관하게 offset 은 전진시킨다. 화이트리스트 밖의
          // 메시지 하나가 큐 맨 앞에 남아 폴링을 영원히 막으면 안 된다.
          offset = update.updateId + 1;

          // 다음 getUpdates 호출 전에 프로세스가 죽어도(재배포, 재시작) 이
          // 갱신을 다시 받지 않도록 즉시 디스크에 남긴다.
          const persistUserId = readBridgeUserId();
          if (persistUserId !== null) {
            writeBridgeState(persistUserId, { lastUpdateOffset: offset });
          }

          // 버튼은 화이트리스트 밖에서 눌릴 수 없지만(우리가 보낸 메시지에만
          // 달린다) 그룹에 봇이 초대된 경우를 생각해 똑같이 막는다.
          const press = update.buttonPress;
          if (press) {
            if (allowed.has(press.chatId)) {
              await handleButtonPress(press);
            }
            continue;
          }

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

          // 다른 메시지가 끼어들었다면 모으던 앨범은 다 온 것이다. 먼저 보낸
          // 앨범이 뒤에 보낸 글보다 늦게 실행되지 않도록 여기서 먼저 처리한다.
          if (
            pendingAlbum
            && (pendingAlbum.mediaGroupId !== message.mediaGroupId || pendingAlbum.chatId !== message.chatId)
          ) {
            // 처리 전에 비운다. 처리 중에 예외가 나도 같은 앨범을 두 번 보내지 않는다.
            const album = pendingAlbum;
            pendingAlbum = null;
            await handleMessage(mergeAlbum(album));
          }

          if (message.mediaGroupId) {
            pendingAlbum ??= { chatId: message.chatId, mediaGroupId: message.mediaGroupId, messages: [] };
            pendingAlbum.messages.push(message);
            continue;
          }

          await handleMessage(message);
        }

        // 기다리는 동안 아무것도 더 오지 않았으면 앨범은 다 왔다.
        if (pendingAlbum && updates.length === 0) {
          const album = pendingAlbum;
          pendingAlbum = null;
          await handleMessage(mergeAlbum(album));
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
      if (activeBroadcast === broadcast) {
        activeBroadcast = null;
      }
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
