import type { McpTransport } from '@/shared/types.js';
import { AppError } from '@/shared/utils.js';

/**
 * Why the handshake failed, in the terms the settings form explains to the
 * user. The UI maps each reason to its own message, so the set is deliberately
 * coarse: every distinct piece of advice we can give gets one reason.
 */
export type McpConnectionTestFailureReason =
  | 'authFailed'
  | 'notFound'
  | 'unreachable'
  | 'timeout'
  | 'protocolError';

export type McpConnectionTestResult =
  | { ok: true; serverInfo: { name: string; version?: string } | null }
  | { ok: false; reason: McpConnectionTestFailureReason; status?: number; detail?: string };

export type McpConnectionTestInput = {
  transport: McpTransport;
  url: string;
  headers?: Record<string, string>;
};

const DEFAULT_TIMEOUT_MS = 5_000;

// The version QueryForge and current Claude Code both negotiate with. The
// handshake is only a reachability probe, so an older server answering with a
// different protocolVersion still counts as success.
const MCP_PROTOCOL_VERSION = '2025-06-18';

// Headers we always send ourselves. A user-supplied header with one of these
// names would break the handshake rather than authenticate it, so it is
// dropped instead of overriding us.
const RESERVED_HEADER_NAMES = new Set(['content-type', 'accept', 'content-length', 'host']);

const INITIALIZE_REQUEST = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: MCP_PROTOCOL_VERSION,
    capabilities: {},
    clientInfo: { name: 'cloudcli-connection-test', version: '1' },
  },
} as const;

const parseTestUrl = (rawUrl: string): URL => {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl.trim());
  } catch {
    throw new AppError('url is not a valid absolute URL.', {
      code: 'MCP_TEST_INVALID_URL',
      statusCode: 400,
    });
  }

  // The server performs this request on the caller's behalf, so the scheme is
  // pinned to HTTP(S). Private and loopback addresses stay allowed on purpose:
  // locally hosted MCP servers are the common case this button exists for, and
  // the route itself sits behind authenticateToken.
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new AppError('url must use http or https.', {
      code: 'MCP_TEST_INVALID_URL_PROTOCOL',
      statusCode: 400,
    });
  }

  return parsed;
};

const buildRequestHeaders = (headers?: Record<string, string>): Record<string, string> => {
  const requestHeaders: Record<string, string> = {};

  Object.entries(headers ?? {}).forEach(([key, value]) => {
    const name = key.trim();
    if (!name || RESERVED_HEADER_NAMES.has(name.toLowerCase())) {
      return;
    }
    requestHeaders[name] = value;
  });

  requestHeaders['Content-Type'] = 'application/json';
  requestHeaders['Accept'] = 'application/json, text/event-stream';
  return requestHeaders;
};

/**
 * Streamable HTTP servers may answer `initialize` either as plain JSON or as a
 * single SSE frame, so the body is unwrapped before it is parsed.
 */
const readJsonRpcBody = (body: string): Record<string, unknown> | null => {
  const trimmed = body.trim();
  if (!trimmed) {
    return null;
  }

  const payload = trimmed.startsWith('{')
    ? trimmed
    : trimmed
      .split('\n')
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice('data:'.length).trim())
      .join('');

  if (!payload) {
    return null;
  }

  try {
    const parsed = JSON.parse(payload) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
};

const readServerInfo = (body: Record<string, unknown>): { name: string; version?: string } | null => {
  const result = body.result;
  if (!result || typeof result !== 'object') {
    return null;
  }

  const serverInfo = (result as Record<string, unknown>).serverInfo;
  if (!serverInfo || typeof serverInfo !== 'object') {
    return null;
  }

  const record = serverInfo as Record<string, unknown>;
  if (typeof record.name !== 'string' || !record.name) {
    return null;
  }

  return {
    name: record.name,
    version: typeof record.version === 'string' ? record.version : undefined,
  };
};

const isTimeoutError = (error: unknown): boolean => (
  error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError')
);

const UNREACHABLE_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ENOTFOUND',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'EAI_AGAIN',
  'ETIMEDOUT',
  'UND_ERR_SOCKET',
  'UND_ERR_CONNECT_TIMEOUT',
]);

const readErrorCode = (error: unknown): string | undefined => {
  let current: unknown = error;
  // fetch wraps the socket error in `cause`, sometimes more than one level deep.
  for (let depth = 0; depth < 4 && current instanceof Error; depth += 1) {
    const code = (current as Error & { code?: unknown }).code;
    if (typeof code === 'string') {
      return code;
    }
    current = (current as Error & { cause?: unknown }).cause;
  }
  return undefined;
};

const describeError = (error: unknown): string => (
  error instanceof Error ? error.message : String(error)
);

export const mcpConnectionTestService = {
  /**
   * Runs an MCP `initialize` handshake against an http/sse server and reports
   * whether the configuration in the form actually connects.
   *
   * This exists because a missing auth header produced an error that named
   * Dynamic Client Registration rather than the header: the client saw a 401,
   * assumed OAuth, and failed on the follow-up. Probing directly lets the form
   * say "auth failed" while the user is still looking at the auth field.
   *
   * stdio is rejected — it would mean spawning the user's command from the
   * server, which is deliberately out of scope; the UI hides the button there.
   */
  async testConnection(
    input: McpConnectionTestInput,
    options?: { timeoutMs?: number },
  ): Promise<McpConnectionTestResult> {
    if (input.transport === 'stdio') {
      throw new AppError('Connection test supports only http and sse MCP servers.', {
        code: 'MCP_TEST_UNSUPPORTED_TRANSPORT',
        statusCode: 400,
      });
    }

    const url = parseTestUrl(input.url);
    const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: buildRequestHeaders(input.headers),
        body: JSON.stringify(INITIALIZE_REQUEST),
        signal: controller.signal,
        // A redirect would send the user's auth headers to a host they never
        // typed, so hops are reported rather than followed.
        redirect: 'manual',
      });
    } catch (error) {
      if (isTimeoutError(error)) {
        return { ok: false, reason: 'timeout' };
      }

      const code = readErrorCode(error);
      if (code && UNREACHABLE_CODES.has(code)) {
        return { ok: false, reason: 'unreachable', detail: code };
      }

      return { ok: false, reason: 'unreachable', detail: describeError(error) };
    } finally {
      clearTimeout(timer);
    }

    if (response.status === 401 || response.status === 403) {
      return { ok: false, reason: 'authFailed', status: response.status };
    }

    if (response.status === 404) {
      return { ok: false, reason: 'notFound', status: response.status };
    }

    if (response.status >= 300 && response.status < 400) {
      return {
        ok: false,
        reason: 'protocolError',
        status: response.status,
        detail: 'redirect',
      };
    }

    if (!response.ok) {
      return { ok: false, reason: 'protocolError', status: response.status };
    }

    const body = readJsonRpcBody(await response.text());
    if (!body) {
      return { ok: false, reason: 'protocolError', status: response.status, detail: 'invalid JSON-RPC response' };
    }

    if (body.error) {
      const message = (body.error as Record<string, unknown>).message;
      return {
        ok: false,
        reason: 'protocolError',
        status: response.status,
        detail: typeof message === 'string' ? message : undefined,
      };
    }

    return { ok: true, serverInfo: readServerInfo(body) };
  },
};
