import express from 'express';

import { AppError, asyncHandler } from '@/shared/utils.js';
import {
  isTelegramBridgeRunning,
  restartTelegramBridge,
} from '@/modules/telegram-bridge/services/telegram-bridge.service.js';
import {
  checkTelegramConnection,
  discoverTelegramChats,
} from '@/modules/telegram-bridge/services/telegram-client.service.js';
import {
  isMaskedBotToken,
  maskBotToken,
  readTelegramSettings,
  writeCachedBotUsername,
  writeTelegramSettings,
} from '@/modules/telegram-bridge/services/telegram-settings.service.js';
import type { TelegramSettings } from '@/modules/telegram-bridge/services/telegram-settings.service.js';
import {
  isSessionNotified,
  readBridgeUserId,
  setSessionNotified,
} from '@/modules/telegram-bridge/services/telegram-state.service.js';

/**
 * 설정 화면이 브리지를 붙이는 통로.
 *
 * 토큰은 절대 평문으로 내보내지 않는다 — 설정 화면을 여는 것만으로 비밀이
 * 브라우저 메모리와 프록시 로그에 실리면, 토큰을 DB 로 옮겨서 얻은 것이 없다.
 * 나가는 값은 항상 `maskBotToken` 을 거친다.
 */

/** 라우터가 밖에 손대는 지점. 테스트가 텔레그램과 폴링 없이 돌 수 있게 열어 둔다. */
type TelegramRouterDependencies = {
  readSettings: typeof readTelegramSettings;
  writeSettings: typeof writeTelegramSettings;
  restartBridge: () => void;
  isRunning: () => boolean;
  checkConnection: typeof checkTelegramConnection;
  cacheBotUsername: typeof writeCachedBotUsername;
  discoverChats: typeof discoverTelegramChats;
  readBridgeUserId: typeof readBridgeUserId;
  isSessionNotified: typeof isSessionNotified;
  setSessionNotified: typeof setSessionNotified;
};

const defaultDependencies: TelegramRouterDependencies = {
  readSettings: readTelegramSettings,
  writeSettings: writeTelegramSettings,
  restartBridge: () => restartTelegramBridge(),
  isRunning: isTelegramBridgeRunning,
  checkConnection: checkTelegramConnection,
  cacheBotUsername: writeCachedBotUsername,
  discoverChats: discoverTelegramChats,
  readBridgeUserId,
  isSessionNotified,
  setSessionNotified,
};

/** 설정 화면이 그릴 수 있는 만큼만. 평문 토큰은 여기 들어가지 않는다. */
function toSettingsResponse(settings: TelegramSettings, running: boolean) {
  return {
    enabled: settings.enabled,
    botToken: maskBotToken(settings.botToken),
    hasToken: Boolean(settings.botToken),
    allowedChatIds: settings.allowedChatIds,
    fromEnvironment: settings.fromEnvironment,
    running,
    botUsername: settings.botUsername,
  };
}

function invalidRequest(message: string): AppError {
  return new AppError(message, {
    code: 'INVALID_TELEGRAM_SETTINGS',
    statusCode: 400,
  });
}

/**
 * chat id 는 숫자여야 한다. 문자열이 섞여 들어오면 화이트리스트 비교가 조용히
 * 전부 빗나가서, 명령을 보내도 아무 반응이 없는 상태가 된다.
 */
function parseAllowedChatIds(value: unknown): number[] {
  if (!Array.isArray(value)) {
    throw invalidRequest('allowedChatIds must be an array of numbers');
  }

  return value.map((chatId) => {
    if (typeof chatId !== 'number' || !Number.isInteger(chatId)) {
      throw invalidRequest('allowedChatIds must be an array of numbers');
    }
    return chatId;
  });
}

/**
 * 저장할 토큰을 정한다.
 *
 * `undefined` 는 "건드리지 않음"이다. 마스킹된 값이 그대로 돌아온 경우도
 * 마찬가지로 본다 — 사용자가 토큰 칸을 손대지 않고 저장한 것이므로, 그 값을
 * 그대로 쓰면 멀쩡한 토큰이 점 여덟 개로 덮인다. 빈 문자열만 "지우기"다.
 */
function resolveBotTokenUpdate(value: unknown): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'string') {
    throw invalidRequest('botToken must be a string');
  }

  const trimmedToken = value.trim();
  if (isMaskedBotToken(trimmedToken)) {
    return undefined;
  }
  return trimmedToken;
}

export function createTelegramRouter(
  overrides: Partial<TelegramRouterDependencies> = {},
): express.Router {
  const dependencies = { ...defaultDependencies, ...overrides };
  const router = express.Router();

  router.get(
    '/settings',
    asyncHandler(async (_req, res) => {
      res.json(toSettingsResponse(dependencies.readSettings(), dependencies.isRunning()));
    }),
  );

  router.put(
    '/settings',
    asyncHandler(async (req, res) => {
      const requestBody = (req.body ?? {}) as Record<string, unknown>;

      if (requestBody.enabled !== undefined && typeof requestBody.enabled !== 'boolean') {
        throw invalidRequest('enabled must be a boolean');
      }

      const botToken = resolveBotTokenUpdate(requestBody.botToken);
      const allowedChatIds = requestBody.allowedChatIds === undefined
        ? undefined
        : parseAllowedChatIds(requestBody.allowedChatIds);

      dependencies.writeSettings({
        botToken,
        allowedChatIds,
        enabled: requestBody.enabled as boolean | undefined,
      });

      // 저장한 설정대로 켜지거나 꺼진다. 서버를 다시 띄우게 하면 설정 화면을
      // 둔 의미가 없다.
      dependencies.restartBridge();

      res.json(toSettingsResponse(dependencies.readSettings(), dependencies.isRunning()));
    }),
  );

  /**
   * "내 chat id 찾기".
   *
   * 화이트리스트가 비면 브리지가 켜지지 않는데, 정작 자기 chat id 를 알아낼
   * 방법이 화면에 없었다. 봇에게 한마디 보낸 뒤 이 버튼을 누르면 봇이 받아 둔
   * 갱신에서 대화 상대를 뽑아 준다. 토큰은 저장된 것을 쓰고, 응답에는 넣지
   * 않는다.
   */
  router.get(
    '/discover-chats',
    asyncHandler(async (_req, res) => {
      const { botToken } = dependencies.readSettings();

      if (!botToken) {
        throw new AppError('No bot token to read chats with', {
          code: 'TELEGRAM_TOKEN_REQUIRED',
          statusCode: 400,
        });
      }

      // 텔레그램은 같은 토큰의 getUpdates 를 한 번에 하나만 허용한다. 브리지가
      // 폴링 중일 때 여기서 또 부르면 409 Conflict 가 날 뿐 아니라 브리지 쪽
      // 폴링이 끊길 수도 있다. 아예 부르지 않고 그 사실만 알려서, 화면이
      // "브리지를 잠시 끄고 다시 시도하세요"를 안내하게 한다.
      if (dependencies.isRunning()) {
        res.json({ chats: [], bridgeRunning: true });
        return;
      }

      // 여기까지 왔는데도 409 가 날 수 있다 — 같은 토큰을 쓰는 다른 프로세스가
      // 붙어 있는 경우다. 실패로 올리지 않고 화면이 같은 안내를 하게 둔다.
      const { chats, conflict } = await dependencies.discoverChats(botToken);

      res.json({ chats, bridgeRunning: conflict });
    }),
  );

  router.post(
    '/test',
    asyncHandler(async (req, res) => {
      const requestBody = (req.body ?? {}) as Record<string, unknown>;
      const requestedToken = typeof requestBody.botToken === 'string' ? requestBody.botToken.trim() : '';
      // 화면이 마스킹된 값을 그대로 보내올 수 있다. 그건 "저장된 토큰으로
      // 확인해 달라"는 뜻이지 그 문자열로 붙어 보라는 뜻이 아니다.
      const useRequestedToken = Boolean(requestedToken) && !isMaskedBotToken(requestedToken);
      const botToken = useRequestedToken ? requestedToken : dependencies.readSettings().botToken;

      if (!botToken) {
        throw new AppError('No bot token to test', {
          code: 'TELEGRAM_TOKEN_REQUIRED',
          statusCode: 400,
        });
      }

      const result = await dependencies.checkConnection(botToken);

      // 성공한 것만 기억해 둔다. 설정 화면이 조회할 때마다 텔레그램에 물어보지
      // 않아도 "어느 봇에 붙어 있는지"를 보여줄 수 있게.
      if (result.ok && result.botUsername) {
        dependencies.cacheBotUsername(botToken, result.botUsername);
      }

      res.json(result.ok
        ? { ok: true, botUsername: result.botUsername ?? null }
        : { ok: false, error: result.error ?? 'Telegram connection check failed' });
    }),
  );

  /**
   * 세션 하나의 "이 작업 알림 받기" 토글.
   *
   * 로그인한 사용자 대신 브리지 주인(첫 사용자)의 설정을 읽고 쓴다. 브리지는
   * 텔레그램에서 온 명령에 로그인 세션이 없어서 늘 그 사용자로 동작하는데,
   * 화면이 다른 사용자 칸에 저장하면 켜 둔 토글이 아무 일도 하지 않는다.
   *
   * 토큰이 없거나 브리지가 꺼져 있으면 `available: false` 로 알린다 — 화면은
   * 그때 토글을 잠그고 이유를 보여 준다. 저장 자체는 막지 않는다면 "켰는데
   * 아무것도 안 온다"가 되고, 그건 알림이 오지 않는 것보다 나쁘다.
   */
  router.get(
    '/session-notifications',
    asyncHandler(async (req, res) => {
      const sessionId = typeof req.query.sessionId === 'string' ? req.query.sessionId : '';
      if (!sessionId) {
        throw invalidRequest('sessionId is required');
      }

      const settings = dependencies.readSettings();
      const userId = dependencies.readBridgeUserId();

      res.json({
        sessionId,
        enabled: userId === null ? false : dependencies.isSessionNotified(userId, sessionId),
        available: dependencies.isRunning(),
        hasToken: Boolean(settings.botToken),
        bridgeEnabled: settings.enabled,
      });
    }),
  );

  router.put(
    '/session-notifications',
    asyncHandler(async (req, res) => {
      const requestBody = (req.body ?? {}) as Record<string, unknown>;
      const sessionId = typeof requestBody.sessionId === 'string' ? requestBody.sessionId.trim() : '';
      if (!sessionId) {
        throw invalidRequest('sessionId is required');
      }
      if (typeof requestBody.enabled !== 'boolean') {
        throw invalidRequest('enabled must be a boolean');
      }

      const userId = dependencies.readBridgeUserId();
      if (userId === null) {
        throw new AppError('No user to store telegram notification settings for', {
          code: 'TELEGRAM_USER_REQUIRED',
          statusCode: 400,
        });
      }

      const settings = dependencies.readSettings();
      dependencies.setSessionNotified(userId, sessionId, requestBody.enabled);

      res.json({
        sessionId,
        enabled: dependencies.isSessionNotified(userId, sessionId),
        available: dependencies.isRunning(),
        hasToken: Boolean(settings.botToken),
        bridgeEnabled: settings.enabled,
      });
    }),
  );

  return router;
}

const router = createTelegramRouter();

export default router;
