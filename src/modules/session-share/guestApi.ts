/**
 * 공유 링크로 들어온 게스트가 쓰는 API.
 *
 * `@/shared/api` 를 쓰지 않는다. 그쪽은 로그인 토큰을 싣고, 인증이 풀리면
 * 로그인 화면으로 보내는데 — 게스트에게는 둘 다 맞지 않는다. 같은 브라우저에
 * 주인의 토큰이 남아 있어도 게스트 요청에는 실리지 않아야 한다.
 */

export type GuestMessage =
  | {
      id: string;
      kind: 'text';
      role: 'user' | 'assistant';
      content: string;
      timestamp: string;
      source?: 'telegram' | 'share';
    }
  | { id: string; kind: 'tool'; toolName: string; detail: string | null; timestamp: string }
  | { id: string; kind: 'error'; content: string; timestamp: string };

export type GuestLiveEvent = GuestMessage | { kind: 'delta'; content: string };

export type GuestRunState = {
  isProcessing: boolean;
  runKey: string | null;
  lastSeq: number;
  awaitingApproval: boolean;
};

export type GuestSnapshot = GuestRunState & {
  title: string | null;
  expiresAt: string | null;
  messages: GuestMessage[];
  hasMore: boolean;
};

export type GuestEvents = GuestRunState & { events: GuestLiveEvent[] };

/** 서버가 준 오류. `code` 로 "없는 링크"와 "작업 중"을 가른다. */
export class GuestApiError extends Error {
  readonly code: string | undefined;
  readonly status: number;

  constructor(message: string, status: number, code?: string) {
    super(message);
    this.name = 'GuestApiError';
    this.status = status;
    this.code = code;
  }
}

/** 게스트 질문 한 번의 최대 길이. 서버(`GUEST_MESSAGE_MAX_LENGTH`)와 같다. */
export const GUEST_MESSAGE_MAX_LENGTH = 8_000;

/**
 * 앱이 하위 경로(`/ai/share/...`)에 걸려 있어도 API 를 같은 곳에서 찾는다.
 * `/share/` 앞까지가 앱의 기준 경로다.
 */
export function readAppBasePath(pathname: string = window.location.pathname): string {
  const index = pathname.indexOf('/share/');
  return index > 0 ? pathname.slice(0, index) : '';
}

/** 지금 주소가 공유 링크면 토큰을, 아니면 `null`. */
export function readShareTokenFromPath(pathname: string = window.location.pathname): string | null {
  const match = pathname.match(/\/share\/([A-Za-z0-9_-]{16,})\/?$/);
  return match ? match[1] : null;
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`${readAppBasePath()}/api/share/${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...init.headers },
    // 주인의 쿠키나 인증 정보를 게스트 요청에 섞지 않는다.
    credentials: 'omit',
  });
  const data = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok) {
    const error = (data.error && typeof data.error === 'object' ? data.error : {}) as { code?: string; message?: string };
    throw new GuestApiError(error.message ?? `Request failed (${response.status})`, response.status, error.code);
  }
  return data as T;
}

export const guestApi = {
  snapshot: (token: string) => request<GuestSnapshot>(encodeURIComponent(token)),
  events: (token: string, cursor: { runKey: string | null; afterSeq: number }) => {
    const query = new URLSearchParams({ after: String(cursor.afterSeq) });
    if (cursor.runKey) {
      query.set('run', cursor.runKey);
    }
    return request<GuestEvents>(`${encodeURIComponent(token)}/events?${query.toString()}`);
  },
  send: (token: string, content: string) =>
    request<{ accepted: boolean }>(`${encodeURIComponent(token)}/messages`, {
      method: 'POST',
      body: JSON.stringify({ content }),
    }),
};
