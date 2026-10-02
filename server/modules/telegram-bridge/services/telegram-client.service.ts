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

/**
 * 메시지에 붙어 온 사진이나 파일 하나.
 *
 * 텔레그램은 갱신에 파일 본문을 싣지 않고 `file_id` 만 준다. 실제 내용은
 * `downloadFile` 로 따로 받아야 한다. 명령 처리와 파일 저장 서비스가 이
 * 모양 그대로 받아서 내려받고 저장한다.
 */
export type TelegramIncomingFile = {
  fileId: string;
  /** 사진에는 원래 이름이 없어서 메시지 번호로 지어 붙인다. */
  name: string;
  mimeType: string;
  /** 텔레그램이 알려준 크기. 모르면 null — 그때는 받은 뒤에 잰다. */
  size: number | null;
  kind: 'photo' | 'document';
};

export type TelegramMessage = {
  messageId: number;
  chatId: number;
  /** 본문. 사진·파일 메시지면 캡션이고, 캡션이 없으면 빈 문자열이다. */
  text: string;
  files: TelegramIncomingFile[];
  /**
   * 여러 장을 한 번에 보내면(앨범) 같은 값을 단 메시지가 장마다 따로 온다.
   * 한 턴으로 묶으려면 이 값으로 모아야 한다. 앨범이 아니면 null.
   */
  mediaGroupId: string | null;
};

type TelegramApiResponse<T> = {
  ok: boolean;
  result?: T;
  description?: string;
};

type RawPhotoSize = {
  file_id?: string;
  file_size?: number;
  width?: number;
  height?: number;
};

type RawDocument = {
  file_id?: string;
  file_name?: string;
  mime_type?: string;
  file_size?: number;
};

type RawMessage = {
  message_id?: number;
  text?: string;
  caption?: string;
  chat?: { id?: number };
  /** 같은 사진의 해상도별 사본. 작은 것부터 온다. */
  photo?: RawPhotoSize[];
  /** "파일로 보내기" 로 온 것. 압축되지 않은 원본 사진도 여기로 온다. */
  document?: RawDocument;
  media_group_id?: string;
};

type RawCallbackQuery = {
  id?: string;
  data?: string;
  /** 버튼이 달려 있던 봇의 메시지. 아주 오래된 메시지면 빠져 올 수 있다. */
  message?: { message_id?: number; chat?: { id?: number } };
};

type RawUpdate = {
  update_id: number;
  message?: RawMessage;
  callback_query?: RawCallbackQuery;
};

/**
 * 메시지 아래에 붙는 버튼 하나. 누르면 `data` 가 그대로 돌아온다.
 *
 * 텔레그램의 `/` 메뉴는 명령을 누르는 순간 인자 없이 보내 버린다. 그래서 인자가
 * 필요한 명령은 고를 거리를 버튼으로 돌려준다. 명령 처리가 버튼을 만들고,
 * 브리지가 그대로 이 클라이언트에 실어 보낸다.
 *
 * `data` 는 텔레그램 한도상 64 바이트까지다.
 */
export type TelegramButton = {
  text: string;
  data: string;
};

/** 사용자가 버튼을 눌렀다는 갱신. 브리지가 명령 처리로 넘긴다. */
export type TelegramButtonPress = {
  /** `answerCallbackQuery` 에 넘길 값. 답하지 않으면 버튼이 계속 돌고 있다. */
  queryId: string;
  chatId: number;
  /** 버튼이 붙어 있던 메시지. 누른 뒤 버튼을 걷어 낼 때 쓴다. */
  messageId: number;
  data: string;
};

export type TelegramUpdate = {
  updateId: number;
  message: TelegramMessage | null;
  /** 버튼을 누른 갱신이면 채워진다. 그때 `message` 는 null 이다. */
  buttonPress?: TelegramButtonPress | null;
};

function readButtonPress(query: RawCallbackQuery | undefined): TelegramButtonPress | null {
  const chatId = query?.message?.chat?.id;
  if (!query || typeof query.id !== 'string' || typeof chatId !== 'number') {
    return null;
  }
  return {
    queryId: query.id,
    chatId,
    messageId: query.message?.message_id ?? 0,
    data: typeof query.data === 'string' ? query.data : '',
  };
}

export type TelegramClient = ReturnType<typeof createTelegramClient>;

/** 연결 확인 결과. 실패해도 예외로 올리지 않고 이유를 담아 돌려준다. */
export type TelegramConnectionCheck = {
  ok: boolean;
  botUsername?: string;
  error?: string;
};

/** 파일 하나를 올리는 데 이보다 오래 걸리면 포기한다. */
const UPLOAD_TIMEOUT_MS = 60_000;

/** 연결 확인은 사람이 버튼을 누르고 기다리는 호출이라 짧게 끊는다. */
const CONNECTION_CHECK_TIMEOUT_MS = 10_000;

/**
 * 사진은 해상도별 사본이 여러 장 오는데, 그중 가장 큰 것 하나만 쓴다.
 * 작은 사본은 미리보기용이라 모델에게 넘기면 글자가 뭉개진다.
 */
function pickLargestPhoto(photos: RawPhotoSize[]): RawPhotoSize | null {
  let largest: RawPhotoSize | null = null;
  for (const photo of photos) {
    if (typeof photo.file_id !== 'string' || !photo.file_id) {
      continue;
    }
    const area = (photo.width ?? 0) * (photo.height ?? 0);
    const largestArea = largest ? (largest.width ?? 0) * (largest.height ?? 0) : -1;
    if (area >= largestArea) {
      largest = photo;
    }
  }
  return largest;
}

function readIncomingFiles(message: RawMessage, messageId: number): TelegramIncomingFile[] {
  const files: TelegramIncomingFile[] = [];

  const photo = Array.isArray(message.photo) ? pickLargestPhoto(message.photo) : null;
  if (photo?.file_id) {
    // 텔레그램은 사진을 늘 JPEG 로 다시 압축해서 저장한다.
    files.push({
      fileId: photo.file_id,
      name: `telegram-photo-${messageId}.jpg`,
      mimeType: 'image/jpeg',
      size: typeof photo.file_size === 'number' ? photo.file_size : null,
      kind: 'photo',
    });
  }

  const document = message.document;
  if (typeof document?.file_id === 'string' && document.file_id) {
    files.push({
      fileId: document.file_id,
      name: typeof document.file_name === 'string' && document.file_name.trim()
        ? document.file_name.trim()
        : `telegram-file-${messageId}`,
      mimeType: typeof document.mime_type === 'string' && document.mime_type
        ? document.mime_type
        : 'application/octet-stream',
      size: typeof document.file_size === 'number' ? document.file_size : null,
      kind: 'document',
    });
  }

  return files;
}

/** 텔레그램 메시지 하나를 브리지가 다루는 모양으로. 다룰 것이 없으면 null. */
function readMessage(message: RawMessage | undefined): TelegramMessage | null {
  const chatId = message?.chat?.id;
  if (!message || typeof chatId !== 'number') {
    return null;
  }

  const messageId = message.message_id ?? 0;
  const text = typeof message.text === 'string'
    ? message.text
    : typeof message.caption === 'string' ? message.caption : '';
  const files = readIncomingFiles(message, messageId);

  // 스티커·위치·음성처럼 글도 파일도 아닌 것은 지금 다루지 않는다.
  if (typeof message.text !== 'string' && files.length === 0) {
    return null;
  }

  return {
    messageId,
    chatId,
    text,
    files,
    mediaGroupId: typeof message.media_group_id === 'string' && message.media_group_id
      ? message.media_group_id
      : null,
  };
}

/** 오류 문구에 토큰이 섞여 나가지 않도록 한 번 걸러 낸다. */
function scrubToken(message: string, botToken: string): string {
  return botToken ? message.split(botToken).join('***') : message;
}

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
  const fileBaseUrl = `https://api.telegram.org/file/bot${botToken}`;

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

  /**
   * 파일을 올리는 호출. JSON 이 아니라 multipart 로 보내야 한다.
   *
   * 이 주소에도 토큰이 들어가므로 실패 문구에서 지운다.
   */
  async function upload(
    method: 'sendPhoto' | 'sendDocument',
    chatId: number,
    field: 'photo' | 'document',
    content: Buffer,
    filename: string,
  ): Promise<void> {
    const form = new FormData();
    form.append('chat_id', String(chatId));
    form.append(field, new Blob([new Uint8Array(content)]), filename);

    try {
      const response = await fetch(`${baseUrl}/${method}`, {
        method: 'POST',
        body: form,
        signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
      });
      const body = (await response.json()) as TelegramApiResponse<unknown>;
      if (!body.ok) {
        throw new Error(`Telegram ${method} failed: ${body.description ?? response.status}`);
      }
    } catch (error) {
      throw new Error(scrubToken(error instanceof Error ? error.message : String(error), botToken));
    }
  }

  return {
    /**
     * 다음 갱신들을 기다린다.
     *
     * `offset` 은 "여기까지 처리했다"는 표시다. 이미 받은 갱신의 update_id + 1
     * 을 넘겨야 같은 메시지를 재시작 때마다 다시 처리하지 않는다.
     */
    async getUpdates(
      offset: number,
      signal?: AbortSignal,
      timeoutSeconds: number = POLL_TIMEOUT_SECONDS,
    ): Promise<TelegramUpdate[]> {
      const updates = await call<RawUpdate[]>(
        'getUpdates',
        {
          offset,
          // 앨범의 나머지 장을 기다릴 때만 짧게 부른다. 평소에는 길게 매달린다.
          timeout: timeoutSeconds,
          // 일반 메시지와 버튼 누름만 처리한다. 나머지 갱신 종류는 받아봐야
          // 버리게 되므로 아예 요청하지 않는다.
          allowed_updates: ['message', 'callback_query'],
        },
        signal,
      );

      return updates.map((update) => ({
        updateId: update.update_id,
        message: readMessage(update.message),
        buttonPress: readButtonPress(update.callback_query),
      }));
    },

    /**
     * 메시지에 붙은 파일의 내용을 받는다.
     *
     * 두 단계다 — `getFile` 로 서버 쪽 경로를 얻고, 그 경로를 파일 전용 주소에서
     * 내려받는다. 그 주소에는 토큰이 들어가므로 실패 문구에서 반드시 지운다.
     * 봇 API 는 20MB 가 넘는 파일은 내주지 않는다.
     */
    async downloadFile(fileId: string, signal?: AbortSignal): Promise<Buffer> {
      try {
        const file = await call<{ file_path?: string }>('getFile', { file_id: fileId }, signal);
        if (typeof file.file_path !== 'string' || !file.file_path) {
          throw new Error('Telegram getFile returned no file path');
        }

        const response = await fetch(`${fileBaseUrl}/${file.file_path}`, { signal });
        if (!response.ok) {
          throw new Error(`Telegram file download failed: ${response.status}`);
        }
        return Buffer.from(await response.arrayBuffer());
      } catch (error) {
        throw new Error(scrubToken(error instanceof Error ? error.message : String(error), botToken));
      }
    },

    /** 토큰이 살아 있는지와 어느 봇인지 확인한다. */
    async getMe(signal?: AbortSignal): Promise<{ username: string | null }> {
      const me = await call<{ username?: string }>('getMe', {}, signal);
      return { username: typeof me.username === 'string' && me.username ? me.username : null };
    },

    /**
     * 사진 한 장을 올린다. 텔레그램이 다시 압축해서 미리보기로 보여 준다.
     *
     * 10MB 를 넘거나 가로세로 비율이 너무 극단적이면 텔레그램이 거절한다.
     * 그때는 부르는 쪽이 `sendDocument` 로 다시 보낸다.
     */
    async sendPhoto(chatId: number, content: Buffer, filename: string): Promise<void> {
      await upload('sendPhoto', chatId, 'photo', content, filename);
    },

    /** 파일로 올린다. 압축하지 않고 원본 그대로 간다. 한도는 50MB. */
    async sendDocument(chatId: number, content: Buffer, filename: string): Promise<void> {
      await upload('sendDocument', chatId, 'document', content, filename);
    },

    async sendMessage(chatId: number, text: string, buttons?: TelegramButton[][]): Promise<void> {
      // parse_mode 를 쓰지 않는다. 보내는 내용이 코드와 경로투성이라
      // 마크다운으로 해석시키면 이스케이프 하나 틀릴 때마다 전송이 실패한다.
      await call('sendMessage', {
        chat_id: chatId,
        text: truncateForTelegram(text),
        disable_web_page_preview: true,
        ...(buttons && buttons.length > 0
          ? {
            reply_markup: {
              inline_keyboard: buttons.map((row) => row.map((button) => ({
                text: button.text,
                callback_data: button.data,
              }))),
            },
          }
          : {}),
      });
    },

    /**
     * 버튼 누름에 답한다. 답하지 않으면 텔레그램이 버튼에 로딩 표시를 한참
     * 띄워 둔다. `text` 를 주면 화면 위에 잠깐 떴다 사라진다.
     */
    async answerButtonPress(queryId: string, text?: string): Promise<void> {
      await call('answerCallbackQuery', { callback_query_id: queryId, ...(text ? { text } : {}) });
    },

    /**
     * 메시지에 달린 버튼을 걷어 낸다. 이미 고른 목록의 버튼을 나중에 또
     * 누르면 그때와 상황이 달라서 엉뚱한 것이 골라진다.
     */
    async clearButtons(chatId: number, messageId: number): Promise<void> {
      await call('editMessageReplyMarkup', {
        chat_id: chatId,
        message_id: messageId,
        reply_markup: { inline_keyboard: [] },
      });
    },

    /**
     * 텔레그램 입력창의 명령 메뉴를 채운다.
     *
     * 이게 없으면 사용자는 `/help` 를 외우고 있어야 한다. 등록해 두면 `/` 만
     * 쳐도 목록이 뜨므로, 명령을 기억하지 못해도 쓸 수 있다.
     */
    async setMyCommands(commands: Array<{ command: string; description: string }>): Promise<void> {
      await call('setMyCommands', { commands });
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
