import { appConfigDb } from '@/modules/database/index.js';
import {
  parseTelegramPermissionMode,
  TELEGRAM_PERMISSION_MODE_KEY,
} from '@/modules/websocket/index.js';
import type { TelegramPermissionMode } from '@/modules/websocket/index.js';

/**
 * 브리지 접속 정보. UI 에서 넣고 고칠 수 있도록 DB 에 둔다.
 *
 * 처음에는 환경변수로만 받았는데, 그러면 봇을 하나 붙이려고 서버에 들어가
 * `.env` 를 고치고 재시작해야 한다. 설정 화면에서 토큰을 넣고 "연결 확인"을
 * 누르는 편이 훨씬 낫다.
 *
 * `.env` 값은 폴백으로 남긴다 — 이미 그렇게 설정해 둔 설치를 깨지 않기 위해서,
 * 그리고 컨테이너처럼 환경변수로 주입하는 편이 자연스러운 배포도 있어서다.
 */

const TOKEN_KEY = 'telegram.botToken';
const CHAT_IDS_KEY = 'telegram.allowedChatIds';
const ENABLED_KEY = 'telegram.enabled';
/** `<botId>:<username>` 형태로 넣는다. 아래 `readCachedBotUsername` 참고. */
const BOT_USERNAME_KEY = 'telegram.botUsername';

export type TelegramSettings = {
  botToken: string;
  allowedChatIds: number[];
  /** 꺼 두면 토큰이 있어도 폴링하지 않는다. 연결을 지우지 않고 잠시 멈출 때. */
  enabled: boolean;
  /** 값이 `.env` 에서 왔는지. UI 가 "환경변수로 설정됨"을 알려줄 때 쓴다. */
  fromEnvironment: boolean;
  /** 마지막 "연결 확인"에서 받아 둔 봇 이름. 확인 전이면 null. */
  botUsername: string | null;
  /**
   * 폰에서 보낸 작업에 얼마나 허용할지. 기본 `ask`.
   *
   * 판정과 의미는 websocket 쪽이 갖고 있다 — 실제로 쓰이는 자리가 거기라서,
   * 두 군데에 같은 뜻의 코드를 두지 않으려고 여기서는 읽고 쓰기만 한다.
   */
  permissionMode: TelegramPermissionMode;
};

function parseChatIds(raw: string | null | undefined): number[] {
  return (raw ?? '')
    .split(',')
    .map((value) => Number.parseInt(value.trim(), 10))
    .filter((value) => Number.isFinite(value));
}

export function readTelegramSettings(): TelegramSettings {
  const storedToken = appConfigDb.get(TOKEN_KEY);
  const environmentToken = process.env.TELEGRAM_BOT_TOKEN?.trim() ?? '';

  // DB 가 우선이다. 설정 화면에서 방금 바꾼 값이 오래된 환경변수에 밀리면
  // 왜 반영이 안 되는지 알 길이 없다.
  const botToken = storedToken?.trim() || environmentToken;
  const fromEnvironment = !storedToken?.trim() && Boolean(environmentToken);

  const storedChatIds = appConfigDb.get(CHAT_IDS_KEY);
  const allowedChatIds = storedChatIds !== null
    ? parseChatIds(storedChatIds)
    : parseChatIds(process.env.TELEGRAM_ALLOWED_CHAT_IDS);

  const storedEnabled = appConfigDb.get(ENABLED_KEY);

  return {
    botToken,
    allowedChatIds,
    enabled: storedEnabled === null ? true : storedEnabled === 'true',
    fromEnvironment,
    botUsername: readCachedBotUsername(botToken),
    permissionMode: parseTelegramPermissionMode(appConfigDb.get(TELEGRAM_PERMISSION_MODE_KEY)),
  };
}

export function writeTelegramSettings(updates: {
  botToken?: string;
  allowedChatIds?: number[];
  enabled?: boolean;
  permissionMode?: TelegramPermissionMode;
}): TelegramSettings {
  if (updates.botToken !== undefined) {
    appConfigDb.set(TOKEN_KEY, updates.botToken.trim());
  }
  if (updates.allowedChatIds !== undefined) {
    appConfigDb.set(CHAT_IDS_KEY, updates.allowedChatIds.join(','));
  }
  if (updates.enabled !== undefined) {
    appConfigDb.set(ENABLED_KEY, updates.enabled ? 'true' : 'false');
  }
  if (updates.permissionMode !== undefined) {
    // 모르는 값이 저장되면 그때부터 조용히 `ask` 로 읽힌다. 들어올 때 거른다.
    appConfigDb.set(TELEGRAM_PERMISSION_MODE_KEY, parseTelegramPermissionMode(updates.permissionMode));
  }
  return readTelegramSettings();
}

/**
 * 토큰을 화면에 보여줄 수 있는 형태로 줄인다.
 *
 * 토큰 전체를 돌려주면 설정 화면을 여는 것만으로 비밀이 브라우저와 네트워크
 * 로그에 실리게 된다. 앞자리(봇 id)만 남기면 "어떤 봇이 연결돼 있는지"는
 * 알아볼 수 있으면서 토큰으로 쓰이지는 못한다.
 */
/** 토큰 앞자리(봇 id). 캐시가 어느 봇의 것인지 표시할 때 쓴다. */
function readBotId(botToken: string): string {
  return botToken.split(':')[0] ?? '';
}

/**
 * "연결 확인"에서 받은 봇 이름을 되돌려준다.
 *
 * 봇 id 를 같이 저장해 두고 지금 토큰과 맞을 때만 돌려준다 — 토큰을 다른 봇으로
 * 바꾸면 이름도 같이 바뀌어야 하는데, 그냥 이름만 저장하면 설정 화면이 이전 봇
 * 이름을 계속 보여주면서 "연결돼 있다"고 오해하게 만든다.
 *
 * 조회 때마다 텔레그램에 물어보지는 않는다. 설정 화면을 여는 것만으로 외부
 * 호출이 나가면 네트워크가 막힌 환경에서 화면이 통째로 느려진다.
 */
export function readCachedBotUsername(botToken: string): string | null {
  const raw = appConfigDb.get(BOT_USERNAME_KEY);
  if (!raw || !botToken) {
    return null;
  }

  const separator = raw.indexOf(':');
  if (separator < 0) {
    return null;
  }

  const cachedBotId = raw.slice(0, separator);
  const cachedUsername = raw.slice(separator + 1);
  if (!cachedUsername || cachedBotId !== readBotId(botToken)) {
    return null;
  }
  return cachedUsername;
}

/** 연결 확인에 성공했을 때만 부른다. */
export function writeCachedBotUsername(botToken: string, botUsername: string): void {
  appConfigDb.set(BOT_USERNAME_KEY, `${readBotId(botToken)}:${botUsername}`);
}

/**
 * 화면에 보여준 마스킹 토큰이 그대로 되돌아왔는지.
 *
 * 설정 화면은 마스킹된 값을 입력란에 채워 두므로, 사용자가 토큰을 건드리지 않고
 * 다른 항목만 고쳐 저장하면 이 값이 그대로 올라온다. 그걸 저장하면 멀쩡한
 * 토큰이 점 여덟 개로 덮인다.
 */
export function isMaskedBotToken(value: string): boolean {
  return value.includes('•');
}

export function maskBotToken(botToken: string): string {
  if (!botToken) {
    return '';
  }
  const [botId] = botToken.split(':');
  return `${botId}:${'•'.repeat(8)}`;
}
