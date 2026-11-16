import express from 'express';
import type { Request } from 'express';

import { sessionSharesDb } from '@/modules/database/index.js';
import type { SessionShareRow } from '@/modules/database/index.js';
import { providerRuntimeService } from '@/modules/providers/index.js';
import type { ProviderRuntimeGateway } from '@/modules/websocket/index.js';
import {
  SHARE_EXPIRY_HOURS,
  SHARE_PERMISSION_MODES,
  createSessionShare,
  parseSharePermissionMode,
  readGuestEvents,
  readGuestSnapshot,
  sendGuestMessage,
} from '@/modules/session-share/services/session-share.service.js';
import { AppError, asyncHandler } from '@/shared/utils.js';

/**
 * 세션 공유 링크의 두 입구.
 *
 * - `createSessionShareRouter`: 주인이 링크를 만들고 끊는 곳. 로그인 뒤에 둔다.
 * - `createGuestShareRouter`: 링크를 받은 게스트가 들어오는 곳. 로그인이 없고,
 *   토큰 하나로 그 세션만 읽고 질문할 수 있다. 다른 API 와 섞이지 않도록 따로
 *   마운트한다.
 */

function invalidRequest(message: string): AppError {
  return new AppError(message, { code: 'INVALID_SHARE_REQUEST', statusCode: 400 });
}

function readRequestUserId(req: Request): number | null {
  const id = (req as Request & { user?: { id?: unknown } }).user?.id;
  return typeof id === 'number' ? id : null;
}

function readSessionId(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw invalidRequest('sessionId is required');
  }
  return value.trim();
}

function readPermissionMode(value: unknown) {
  const mode = parseSharePermissionMode(value);
  if (!mode) {
    throw invalidRequest(`permissionMode must be one of ${SHARE_PERMISSION_MODES.join(', ')}`);
  }
  return mode;
}

/** 고를 수 있는 기간만 받는다. 아무 숫자나 받으면 실수로 수십 년짜리 링크가 생긴다. */
function readExpiresInHours(value: unknown): number | null {
  if (value === null) {
    return null;
  }
  if (!SHARE_EXPIRY_HOURS.includes(value as (typeof SHARE_EXPIRY_HOURS)[number])) {
    throw invalidRequest(`expiresInHours must be one of ${SHARE_EXPIRY_HOURS.join(', ')} or null`);
  }
  return value as number;
}

/** 주인 화면이 그릴 링크 하나. 토큰은 링크를 다시 복사하려고 그대로 내보낸다. */
function toShareResponse(row: SessionShareRow) {
  return {
    id: row.id,
    token: row.token,
    permissionMode: row.permission_mode,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
  };
}

export function createSessionShareRouter() {
  const router = express.Router();

  router.get(
    '/',
    asyncHandler(async (req, res) => {
      const sessionId = readSessionId(req.query.sessionId);
      res.json({ shares: sessionSharesDb.listActiveBySession(sessionId).map(toShareResponse) });
    }),
  );

  router.post(
    '/',
    asyncHandler(async (req, res) => {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const share = createSessionShare({
        sessionId: readSessionId(body.sessionId),
        userId: readRequestUserId(req),
        permissionMode: readPermissionMode(body.permissionMode),
        expiresInHours: readExpiresInHours(body.expiresInHours ?? null),
      });
      res.status(201).json({ share: toShareResponse(share) });
    }),
  );

  /** 세션 권한이 바뀌면 열린 링크도 따라간다. 링크가 없으면 아무 일도 없다. */
  router.put(
    '/permission',
    asyncHandler(async (req, res) => {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const updated = sessionSharesDb.updatePermissionForSession(
        readSessionId(body.sessionId),
        readPermissionMode(body.permissionMode),
      );
      res.json({ updated });
    }),
  );

  router.delete(
    '/:id',
    asyncHandler(async (req, res) => {
      const id = Number.parseInt(String(req.params.id), 10);
      if (!Number.isInteger(id) || id <= 0) {
        throw invalidRequest('id must be a positive integer');
      }
      sessionSharesDb.revoke(id);
      res.json({ revoked: true });
    }),
  );

  return router;
}

export function createGuestShareRouter(runtime: ProviderRuntimeGateway = providerRuntimeService) {
  const router = express.Router();

  // 게스트 응답은 링크마다 다르고 자주 바뀐다. 중간 프록시가 붙잡아 두면 남의
  // 대화가 섞여 보일 수 있다.
  router.use((_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Robots-Tag', 'noindex');
    next();
  });

  router.get(
    '/:token',
    asyncHandler(async (req, res) => {
      res.json(await readGuestSnapshot(String(req.params.token), runtime));
    }),
  );

  router.get(
    '/:token/events',
    asyncHandler(async (req, res) => {
      const runKey = typeof req.query.run === 'string' && req.query.run ? req.query.run : null;
      const after = Number.parseInt(String(req.query.after ?? '0'), 10);
      res.json(readGuestEvents(String(req.params.token), runtime, {
        runKey,
        afterSeq: Number.isFinite(after) && after > 0 ? after : 0,
      }));
    }),
  );

  router.post(
    '/:token/messages',
    asyncHandler(async (req, res) => {
      const body = (req.body ?? {}) as Record<string, unknown>;
      if (typeof body.content !== 'string') {
        throw invalidRequest('content must be a string');
      }
      await sendGuestMessage(String(req.params.token), body.content, runtime);
      res.status(202).json({ accepted: true });
    }),
  );

  return router;
}

export default createSessionShareRouter();
