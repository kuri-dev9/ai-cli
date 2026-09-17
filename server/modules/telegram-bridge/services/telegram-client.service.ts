/**
 * Telegram Bot API 호출부.
 *
 * long polling(`getUpdates`)만 쓴다 — 서버가 텔레그램 쪽으로 나가는 연결만
 * 만들기 때문에 인바운드 포트를 하나도 열지 않아도 된다. webhook 을 쓰면
 * 공인 endpoint 와 443/80/88/8443 중 하나를 열어야 하고, 그러면 웹 UI 를
 * 외부에 노출하는 것과 같은 공격면이 생긴다. 이 브리지를 만든 이유가
 * 그걸 피하는 것이므로 webhook 은 지원하지 않는다.
 */

/** 텔레그램 한 메시지의 최대 길이. 넘기면 API 가 거절한다. */
const MAX_MESSAGE_LENGTH = 4096;

/** long polling 한 번이 서버에서 열려 있는 시간(초). */
const POLL_TIMEOUT_SECONDS = 30;

/**
 * `POLL_TIMEOUT_SECONDS` 보다 넉넉해야 한다 — 폴링은 갱신이 없으면 제한
 * 시간까지 응답하지 않는 것이 정상 동작이라, 여기서 먼저 끊으면 매번
 * 실패로 보인다.
 */
const REQUEST_TIMEOUT_MS = (POLL_TIMEOUT_SECONDS + 15) * 1000;

export type TelegramMessage = {
  messageId: number;
  chatId: number;
  text: string;
};

type TelegramApiResponse<T> = {
  ok: boolean;
  result?: T;
  description?: string;
};

type RawUpdate = {
  update_id: number;
  message?: {
    message_id?: number;
    text?: string;
    chat?: { id?: number };
  };
};

export type TelegramUpdate = {
  updateId: number;
  message: TelegramMessage | null;
};

export type TelegramClient = ReturnType<typeof createTelegramClient>;

/** 연결 확인 결과. 실패해도 예외로 올리지 않고 이유를 담아 돌려준다. */
export type TelegramConnectionCheck = {
  ok: boolean;
  botUsername?: string;
  error?: string;
};

/** 연결 확인은 사람이 버튼을 누르고 기다리는 호출이라 짧게 끊는다. */
const CONNECTION_CHECK_TIMEOUT_MS = 10_000;

/** 텔레그램이 거절하지 않도록 자르고, 잘렸다는 사실을 남긴다. */
export function truncateForTelegram(text: string): string {
  if (text.length <= MAX_MESSAGE_LENGTH) {
    return text;
  }
  const notice = '\n\n… (잘림)';
  return `${text.slice(0, MAX_MESSAGE_LENGTH - notice.length)}${notice}`;
}

export function createTelegramClient(botToken: string) {
  const baseUrl = `https://api.telegram.org/bot${botToken}`;

  async function call<T>(
    method: string,
    payload: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<T> {
    const response = await fetch(`${baseUrl}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal,
    });

    const body = (await response.json()) as TelegramApiResponse<T>;
    if (!body.ok) {
      throw new Error(`Telegram ${method} failed: ${body.description ?? response.status}`);
    }
    return body.result as T;
  }

  return {
    /**
     * 다음 갱신들을 기다린다.
     *
     * `offset` 은 "여기까지 처리했다"는 표시다. 이미 받은 갱신의 update_id + 1
     * 을 넘겨야 같은 메시지를 재시작 때마다 다시 처리하지 않는다.
     */
    async getUpdates(offset: number, signal?: AbortSignal): Promise<TelegramUpdate[]> {
      const updates = await call<RawUpdate[]>(
        'getUpdates',
        {
          offset,
          timeout: POLL_TIMEOUT_SECONDS,
          // 지금 처리하는 것은 일반 메시지뿐. 나머지 갱신 종류는 받아봐야
          // 버리게 되므로 아예 요청하지 않는다.
          allowed_updates: ['message'],
        },
        signal,
      );

      return updates.map((update) => {
        const chatId = update.message?.chat?.id;
        const text = update.message?.text;
        return {
          updateId: update.update_id,
          message:
            typeof chatId === 'number' && typeof text === 'string'
              ? { messageId: update.message?.message_id ?? 0, chatId, text }
              : null,
        };
      });
    },

    /** 토큰이 살아 있는지와 어느 봇인지 확인한다. */
    async getMe(signal?: AbortSignal): Promise<{ username: string | null }> {
      const me = await call<{ username?: string }>('getMe', {}, signal);
      return { username: typeof me.username === 'string' && me.username ? me.username : null };
    },

    async sendMessage(chatId: number, text: string): Promise<void> {
      // parse_mode 를 쓰지 않는다. 보내는 내용이 코드와 경로투성이라
      // 마크다운으로 해석시키면 이스케이프 하나 틀릴 때마다 전송이 실패한다.
      await call('sendMessage', {
        chat_id: chatId,
        text: truncateForTelegram(text),
        disable_web_page_preview: true,
      });
    },

    /** 폴링 한 번이 매달릴 수 있는 시간. 호출부가 타임아웃을 걸 때 쓴다. */
    requestTimeoutMs: REQUEST_TIMEOUT_MS,
  };
}

/**
 * 설정 화면의 "연결 확인".
 *
 * 토큰이 틀렸는지, 네트워크가 막혔는지를 저장 전에 알려주려는 것이므로 실패를
 * 예외로 던지지 않는다 — 호출부가 매번 try/catch 로 같은 문자열을 만들게 하는
 * 대신 이유를 그대로 담아 돌려준다.
 */
export async function checkTelegramConnection(botToken: string): Promise<TelegramConnectionCheck> {
  const trimmedToken = botToken.trim();
  if (!trimmedToken) {
    return { ok: false, error: '봇 토큰이 없습니다.' };
  }

  try {
    const client = createTelegramClient(trimmedToken);
    const { username } = await client.getMe(AbortSignal.timeout(CONNECTION_CHECK_TIMEOUT_MS));
    return username ? { ok: true, botUsername: username } : { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * 설정 화면의 "내 chat id 찾기".
 *
 * chat id 는 사람이 눈으로 찾기 번거롭다 — 브라우저에서 getUpdates 를 열면
 * 토큰이 주소창과 방문 기록에 그대로 남고, JSON 속에서 숫자를 골라내야 한다.
 * 그 두 가지를 서버가 대신한다. `scripts/telegram-setup.mjs` 가 `.env` 로
 * 하던 일과 같고, 저장된 토큰을 쓰며 토큰은 밖으로 내보내지 않는다.
 */
export type TelegramDiscoveredChat = {
  chatId: number;
  /** 사람 이름(성+이름) 또는 그룹 제목. 알 수 없으면 빈 문자열. */
  name: string;
  /** `@` 없이. 텔레그램 username 을 설정하지 않은 계정도 많아서 빈 문자열일 수 있다. */
  username: string;
  /** 이 대화에서 마지막으로 온 메시지. 목록에서 "누가 나인지" 알아보는 단서다. */
  lastText: string;
  /** chat id 가 음수면 그룹·채널이다. 개인 대화만 있는 줄 알고 추가하지 않도록 표시한다. */
  isGroup: boolean;
};

export type TelegramChatDiscovery = {
  chats: TelegramDiscoveredChat[];
  /**
   * 텔레그램이 409 Conflict 로 거절했는지. 같은 토큰으로 getUpdates 를 두 곳에서
   * 부르면 나는 응답이며, 사실상 "브리지가 이미 폴링 중"이라는 뜻이다.
   */
  conflict: boolean;
};

/** 목록에 보여줄 만큼만. 긴 메시지를 통째로 실어 보낼 이유가 없다. */
const DISCOVERY_PREVIEW_LENGTH = 200;

/** 사람이 버튼을 누르고 기다리는 호출이라 짧게 끊는다. */
const DISCOVERY_TIMEOUT_MS = 10_000;

type RawDiscoveryChat = {
  id?: number;
  first_name?: string;
  last_name?: string;
  username?: string;
  /** 그룹·채널의 이름. 개인 대화에는 없다. */
  title?: string;
};

type RawDiscoveryUpdate = {
  message?: {
    text?: string;
    chat?: RawDiscoveryChat;
  };
};

/**
 * 표시할 이름을 고른다.
 *
 * 개인 대화는 `first_name + last_name`, 그룹은 `title` 이 사람이 알아보는
 * 이름이다. 둘 다 없으면 username 으로, 그것도 없으면 빈 문자열로 둔다 —
 * 여기서 chat id 를 대신 채워 넣으면 화면에 같은 숫자가 두 번 나온다.
 */
function pickChatName(chat: RawDiscoveryChat): string {
  const fullName = [chat.first_name, chat.last_name]
    .filter((part): part is string => typeof part === 'string' && part.trim().length > 0)
    .join(' ')
    .trim();

  if (fullName) {
    return fullName;
  }
  if (typeof chat.title === 'string' && chat.title.trim()) {
    return chat.title.trim();
  }
  if (typeof chat.username === 'string' && chat.username.trim()) {
    return chat.username.trim();
  }
  return '';
}

/** 오류 문구에 토큰이 섞여 나가지 않도록 한 번 걸러 낸다. */
function scrubToken(message: string, botToken: string): string {
  return botToken ? message.split(botToken).join('***') : message;
}

/**
 * 봇이 받아 둔 갱신을 *읽기만* 해서 대화 목록을 만든다.
 *
 * ── offset 을 전진시키지 않는 것이 이 함수의 핵심이다 ──
 * getUpdates 에 offset 을 넘기면 그 값보다 작은 갱신은 텔레그램 서버에서
 * 확인(confirm)된 것으로 처리돼 영구히 사라진다. 여기서 offset 을 주면
 * 사용자가 "chat id 찾기"를 누른 순간 대기 중이던 메시지가 지워지고,
 * 나중에 브리지를 켜도 그 명령들은 영영 오지 않는다. 그래서 offset 은
 * 아예 넘기지 않는다(= 확인되지 않은 갱신을 처음부터 다시 읽는다).
 *
 * long polling 도 하지 않는다. `timeout: 0` 이면 지금 쌓여 있는 것만 즉시
 * 돌려준다 — 버튼 하나에 30 초를 기다리게 할 수는 없다.
 */
export async function discoverTelegramChats(botToken: string): Promise<TelegramChatDiscovery> {
  const trimmedToken = botToken.trim();
  if (!trimmedToken) {
    throw new Error('봇 토큰이 없습니다.');
  }

  let response: Response;
  let body: TelegramApiResponse<RawDiscoveryUpdate[]> & { error_code?: number };

  try {
    response = await fetch(`https://api.telegram.org/bot${trimmedToken}/getUpdates`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // offset 없음. 위 주석 참고 — 넣는 순간 브리지가 메시지를 잃는다.
      body: JSON.stringify({ timeout: 0, allowed_updates: ['message'] }),
      signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS),
    });
    body = (await response.json()) as typeof body;
  } catch (error) {
    // 네트워크 오류 메시지에 URL(= 토큰)이 실려 올 수 있다.
    throw new Error(scrubToken(error instanceof Error ? error.message : String(error), trimmedToken));
  }

  if (!body.ok) {
    // 409 Conflict = 같은 토큰으로 이미 다른 쪽이 getUpdates 를 붙들고 있다.
    // 여기서는 브리지가 폴링 중이라는 뜻이므로 실패로 올리지 않고, 화면이
    // "브리지를 잠시 끄고 다시 시도하세요"를 안내할 수 있게 표시만 한다.
    const isConflict = response.status === 409
      || body.error_code === 409
      || /conflict/i.test(body.description ?? '');

    if (isConflict) {
      return { chats: [], conflict: true };
    }

    throw new Error(scrubToken(
      `Telegram getUpdates failed: ${body.description ?? response.status}`,
      trimmedToken,
    ));
  }

  // 같은 사람이 여러 번 말을 걸면 갱신도 여러 개다. chat id 하나로 합치되,
  // 갱신은 오래된 순서로 오므로 뒤에 온 것(= 더 최근)이 앞의 것을 덮는다.
  const chats = new Map<number, TelegramDiscoveredChat>();
  for (const update of body.result ?? []) {
    const chat = update.message?.chat;
    if (typeof chat?.id !== 'number') {
      continue;
    }

    const text = typeof update.message?.text === 'string' ? update.message.text : '';
    const previous = chats.get(chat.id);

    chats.set(chat.id, {
      chatId: chat.id,
      name: pickChatName(chat),
      username: typeof chat.username === 'string' ? chat.username : '',
      // 사진처럼 본문이 없는 메시지가 뒤에 오더라도 직전 문구를 지우지 않는다.
      lastText: (text || previous?.lastText || '').slice(0, DISCOVERY_PREVIEW_LENGTH),
      // 그룹·채널은 chat id 가 음수다.
      isGroup: chat.id < 0,
    });
  }

  return { chats: [...chats.values()], conflict: false };
}
