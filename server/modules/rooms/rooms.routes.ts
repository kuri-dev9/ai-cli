import express from 'express';
import type { Request, Response } from 'express';

import { parseRoomPermissionMode } from '@/modules/rooms/services/room-records.service.js';
import { roomsService } from '@/modules/rooms/services/rooms.service.js';
import { AppError, asyncHandler, createApiSuccessResponse } from '@/shared/utils.js';

type AuthenticatedRequest = Request & { user?: { id?: number | string } };

function readUserId(request: Request): string | number | null {
  const id = (request as AuthenticatedRequest).user?.id;
  return typeof id === 'string' || typeof id === 'number' ? id : null;
}

function readBody(request: Request): Record<string, unknown> {
  const body: unknown = request.body;
  return body && typeof body === 'object' && !Array.isArray(body) ? body as Record<string, unknown> : {};
}

function readRequiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new AppError(`${field} is required.`, { code: 'INVALID_REQUEST_BODY', statusCode: 400 });
  }
  return value.trim();
}

function readOptionalString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function readParticipant(value: unknown) {
  const record = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
  return {
    provider: readRequiredString(record.provider, 'participant.provider'),
    model: readOptionalString(record.model),
    displayName: readOptionalString(record.displayName) ?? '',
    roleName: readRequiredString(record.roleName, 'participant.roleName'),
    rolePrompt: readOptionalString(record.rolePrompt),
  };
}

const router = express.Router();

router.get(
  '/',
  asyncHandler(async (_req: Request, res: Response) => {
    res.json(createApiSuccessResponse({ rooms: roomsService.listRoomIndex() }));
  }),
);

router.get(
  '/by-session/:sessionId',
  asyncHandler(async (req: Request, res: Response) => {
    res.json(createApiSuccessResponse(
      roomsService.getRoomDetailByHostSession(readRequiredString(req.params.sessionId, 'sessionId')),
    ));
  }),
);

router.get(
  '/:roomId',
  asyncHandler(async (req: Request, res: Response) => {
    res.json(createApiSuccessResponse(roomsService.getRoomDetail(readRequiredString(req.params.roomId, 'roomId'))));
  }),
);

router.post(
  '/',
  asyncHandler(async (req: Request, res: Response) => {
    const body = readBody(req);
    const host = body.host && typeof body.host === 'object' && !Array.isArray(body.host)
      ? body.host as Record<string, unknown>
      : {};
    const detail = await roomsService.createRoom({
      hostSessionId: readRequiredString(body.hostSessionId, 'hostSessionId'),
      host: {
        displayName: readOptionalString(host.displayName),
        roleName: readOptionalString(host.roleName),
        rolePrompt: readOptionalString(host.rolePrompt),
      },
      participant: readParticipant(body.participant),
    });
    res.status(201).json(createApiSuccessResponse(detail));
  }),
);

router.post(
  '/:roomId/participants',
  asyncHandler(async (req: Request, res: Response) => {
    const detail = await roomsService.addParticipant(
      readRequiredString(req.params.roomId, 'roomId'),
      readParticipant(readBody(req)),
    );
    res.status(201).json(createApiSuccessResponse(detail));
  }),
);

router.patch(
  '/:roomId',
  asyncHandler(async (req: Request, res: Response) => {
    const body = readBody(req);
    const detail = roomsService.updateSettings(readRequiredString(req.params.roomId, 'roomId'), {
      permissionMode: body.permissionMode === undefined ? undefined : parseRoomPermissionMode(body.permissionMode),
      maxAutoTurns: body.maxAutoTurns === undefined ? undefined : Number(body.maxAutoTurns),
    });
    res.json(createApiSuccessResponse(detail));
  }),
);

router.post(
  '/:roomId/messages',
  asyncHandler(async (req: Request, res: Response) => {
    const result = roomsService.postUserMessage(
      readRequiredString(req.params.roomId, 'roomId'),
      readRequiredString(readBody(req).content, 'content'),
      readUserId(req),
    );
    res.status(202).json(createApiSuccessResponse(result));
  }),
);

router.post(
  '/:roomId/stop',
  asyncHandler(async (req: Request, res: Response) => {
    const state = await roomsService.stop(readRequiredString(req.params.roomId, 'roomId'));
    res.json(createApiSuccessResponse({ state }));
  }),
);

export default router;
