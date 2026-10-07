import express from 'express';
import type { NextFunction, Request, RequestHandler, Response } from 'express';

import type {
  FileTreeLogger,
  FileTreeOpenedFile,
  FileTreeServices,
  FileTreeUploadedFile,
} from '@/shared/types.js';
import { AppError } from '@/shared/utils.js';

type FileTreeUploadLimits = {
  maximumFileSizeMegabytes: number;
  maximumFileCount: number;
};

type UploadedRequest = Request & {
  files?: Express.Multer.File[];
};

function readBody(request: Request): Record<string, unknown> {
  return typeof request.body === 'object' && request.body !== null
    ? request.body as Record<string, unknown>
    : {};
}

function readRequiredString(value: unknown, fieldName: string, message?: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new AppError(message ?? `${fieldName} is required`, {
      code: 'INVALID_FILE_TREE_REQUEST',
      statusCode: 400,
    });
  }
  return value;
}

function readOptionalString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function readProjectId(request: Request): string {
  return readRequiredString(request.params.projectId, 'projectId');
}

function readEntryType(value: unknown): 'file' | 'directory' {
  if (value !== 'file' && value !== 'directory') {
    throw new AppError('Type must be "file" or "directory"', {
      code: 'INVALID_FILE_TREE_ENTRY_TYPE',
      statusCode: 400,
    });
  }
  return value;
}

function readRelativePaths(value: unknown): string[] {
  if (typeof value !== 'string' || !value) {
    return [];
  }

  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((entry): entry is string => typeof entry === 'string')
      : [];
  } catch {
    return [];
  }
}

function readRequestedFileCount(value: unknown, fallbackCount: number): number {
  const parsedCount = typeof value === 'string' ? Number.parseInt(value, 10) : Number.NaN;
  return Number.isFinite(parsedCount) && parsedCount > 0 ? parsedCount : fallbackCount;
}

function normalizeUploadedFiles(request: UploadedRequest): FileTreeUploadedFile[] {
  return Array.isArray(request.files)
    ? request.files.map((file) => ({
        originalName: file.originalname,
        temporaryPath: file.path,
        size: file.size,
        mimeType: file.mimetype,
      }))
    : [];
}

function readUnsatisfiableRangeSize(error: AppError): number | null {
  if (error.code !== 'RANGE_NOT_SATISFIABLE') {
    return null;
  }
  const details = error.details;
  const size = typeof details === 'object' && details !== null && 'size' in details
    ? (details as { size: unknown }).size
    : null;
  return typeof size === 'number' ? size : null;
}

function streamOpenedFile(
  request: Request,
  response: Response,
  file: FileTreeOpenedFile,
  logger: FileTreeLogger,
): void {
  response.setHeader('Content-Type', file.contentType);
  // Advertised unconditionally so media elements know they may seek with a
  // ranged request on a later load instead of refetching the whole file.
  response.setHeader('Accept-Ranges', 'bytes');
  if (file.modifiedAt) {
    response.setHeader('Last-Modified', file.modifiedAt.toUTCString());
  }

  if (file.contentRange) {
    const { start, end } = file.contentRange;
    response.status(206);
    response.setHeader('Content-Range', `bytes ${start}-${end}/${file.size}`);
    response.setHeader('Content-Length', String(end - start + 1));
  } else {
    response.setHeader('Content-Length', String(file.size));
  }

  // Express routes a HEAD at the matching GET handler. Answer it from the
  // headers alone — a player asking only for size and date should not make the
  // server read the file off disk.
  if (request.method === 'HEAD') {
    file.stream.destroy();
    response.end();
    return;
  }

  file.stream.pipe(response);
  file.stream.on('error', (error) => {
    logger.error('Error streaming File Tree content', error);
    if (!response.headersSent) {
      response.status(500).json({ error: 'Error reading file' });
    }
  });
}

function createRouteHandler(
  operation: (request: Request, response: Response) => void | Promise<void>,
  logger: FileTreeLogger,
): RequestHandler {
  return async (request, response) => {
    try {
      await operation(request, response);
    } catch (error) {
      if (error instanceof AppError) {
        // A 416 must state the real resource length so the client can retry
        // with a range it can actually satisfy.
        const unsatisfiableSize = readUnsatisfiableRangeSize(error);
        if (unsatisfiableSize !== null) {
          response.setHeader('Content-Range', `bytes */${unsatisfiableSize}`);
        }
        response.status(error.statusCode).json({ error: error.message });
        return;
      }

      const message = error instanceof Error ? error.message : String(error);
      logger.error('File Tree API error', error);
      response.status(500).json({ error: message });
    }
  };
}

/**
 * Builds the File Tree HTTP router for the server composition root and route tests.
 * Paths are relative to the module's `/api/file-tree` mount point so the
 * complete HTTP surface has one feature-owned namespace.
 */
export function createFileTreeRouter(
  services: FileTreeServices,
  uploadFilesMiddleware: RequestHandler,
  uploadLimits: FileTreeUploadLimits,
  logger: FileTreeLogger,
): express.Router {
  const router = express.Router();

  router.get('/browse-filesystem', createRouteHandler(async (request, response) => {
    response.json(await services.browseWorkspace(readOptionalString(request.query.path)));
  }, logger));

  router.post('/create-folder', createRouteHandler(async (request, response) => {
    const body = readBody(request);
    const folderPath = readRequiredString(body.path, 'path', 'Path is required');
    response.json(await services.createWorkspaceFolder(folderPath));
  }, logger));

  router.get('/projects/:projectId/file', createRouteHandler(async (request, response) => {
    const filePath = readRequiredString(request.query.filePath, 'filePath', 'Invalid file path');
    response.json(await services.readTextFile(readProjectId(request), filePath));
  }, logger));

  router.get('/projects/:projectId/files/content', createRouteHandler(async (request, response) => {
    const filePath = readRequiredString(request.query.path, 'path', 'Invalid file path');
    streamOpenedFile(request, response, await services.openFile(readProjectId(request), filePath, {
      rangeHeader: request.headers.range ?? null,
    }), logger);
  }, logger));

  // Serves one playable media file the in-app player was pointed at, which
  // commonly lives outside the open project (for example output an external
  // tool wrote to its own folder). The service restricts this to the workspace
  // root and to audio/video MIME types.
  router.get('/media/content', createRouteHandler(async (request, response) => {
    const filePath = readRequiredString(request.query.path, 'path', 'Invalid file path');
    streamOpenedFile(request, response, await services.openMediaFile(filePath, {
      rangeHeader: request.headers.range ?? null,
    }), logger);
  }, logger));

  // Lists the playable files in one configured media folder. The service keeps
  // this to the workspace root and to audio/video, so it cannot enumerate an
  // arbitrary directory.
  router.get('/media/list', createRouteHandler(async (request, response) => {
    const folderPath = readRequiredString(request.query.path, 'path', 'Invalid folder path');
    response.json(await services.listMediaFiles(folderPath));
  }, logger));

  router.delete('/media/file', createRouteHandler(async (request, response) => {
    const body = readBody(request);
    const filePath = readRequiredString(body.path, 'path', 'Invalid file path');
    response.json(await services.deleteMediaFile(filePath));
  }, logger));

  // Moving and renaming are the same filesystem operation, so one endpoint
  // serves both: the panel sends a folder, a name, or both at once.
  router.post('/media/move', createRouteHandler(async (request, response) => {
    const body = readBody(request);
    const filePath = readRequiredString(body.path, 'path', 'Invalid file path');
    const targetFolder = readOptionalString(body.targetFolder)?.trim() || null;
    const newName = readOptionalString(body.name)?.trim() || null;
    if (!targetFolder && !newName) {
      throw new AppError('Invalid target folder', {
        code: 'INVALID_FILE_TREE_REQUEST',
        statusCode: 400,
      });
    }
    response.json(await services.moveMediaFile(filePath, targetFolder, newName));
  }, logger));

  // Writes the same track in another format, where the caller asked for it. The
  // request is held for the length of the conversion, seconds for one file.
  router.post('/media/transcode', createRouteHandler(async (request, response) => {
    const body = readBody(request);
    const filePath = readRequiredString(body.path, 'path', 'Invalid file path');
    const format = readRequiredString(body.format, 'format', 'Invalid target format');
    response.json(await services.transcodeMediaFile(filePath, format, {
      targetFolder: readOptionalString(body.targetFolder)?.trim() || null,
      name: readOptionalString(body.name)?.trim() || null,
    }));
  }, logger));

  // Lets the panel hide conversion entirely where no converter is installed,
  // rather than offering a button that can only fail.
  router.get('/media/capabilities', createRouteHandler(async (_request, response) => {
    response.json(await services.mediaCapabilities());
  }, logger));

  router.put('/projects/:projectId/file', createRouteHandler(async (request, response) => {
    const body = readBody(request);
    const filePath = readRequiredString(body.filePath, 'filePath', 'Invalid file path');
    if (body.content === undefined) {
      throw new AppError('Content is required', {
        code: 'FILE_CONTENT_REQUIRED',
        statusCode: 400,
      });
    }
    if (typeof body.content !== 'string') {
      throw new AppError('Content must be a string', {
        code: 'INVALID_FILE_CONTENT',
        statusCode: 400,
      });
    }
    response.json(await services.saveTextFile(readProjectId(request), filePath, body.content));
  }, logger));

  router.get('/projects/:projectId/files', createRouteHandler(async (request, response) => {
    response.json(await services.listProjectFiles(readProjectId(request), {
      respectGitignore: request.query.respectGitignore === 'true',
    }));
  }, logger));

  router.post('/projects/:projectId/files/create', createRouteHandler(async (request, response) => {
    const body = readBody(request);
    if (!body.name || !body.type) {
      throw new AppError('Name and type are required', {
        code: 'FILE_TREE_ENTRY_FIELDS_REQUIRED',
        statusCode: 400,
      });
    }
    const name = readRequiredString(body.name, 'name');
    const type = readEntryType(body.type);
    const parentPath = readOptionalString(body.path) ?? '';
    response.json(await services.createEntry({
      projectId: readProjectId(request),
      parentPath,
      type,
      name,
    }));
  }, logger));

  router.put('/projects/:projectId/files/rename', createRouteHandler(async (request, response) => {
    const body = readBody(request);
    if (!body.oldPath || !body.newName) {
      throw new AppError('oldPath and newName are required', {
        code: 'FILE_TREE_RENAME_FIELDS_REQUIRED',
        statusCode: 400,
      });
    }
    response.json(await services.renameEntry({
      projectId: readProjectId(request),
      oldPath: readRequiredString(body.oldPath, 'oldPath'),
      newName: readRequiredString(body.newName, 'newName'),
    }));
  }, logger));

  router.delete('/projects/:projectId/files', createRouteHandler(async (request, response) => {
    const body = readBody(request);
    const targetPath = readRequiredString(body.path, 'path', 'Path is required');
    response.json(await services.deleteEntry({
      projectId: readProjectId(request),
      targetPath,
    }));
  }, logger));

  const uploadHandler = createRouteHandler(async (request, response) => {
    const uploadedRequest = request as UploadedRequest;
    const body = readBody(request);
    const files = normalizeUploadedFiles(uploadedRequest);
    response.json(await services.storeUploadedFiles({
      projectId: readProjectId(request),
      targetPath: readOptionalString(body.targetPath) ?? '',
      relativePaths: readRelativePaths(body.relativePaths),
      requestedFileCount: readRequestedFileCount(body.requestedFileCount, files.length),
      files,
    }));
  }, logger);

  router.post(
    '/projects/:projectId/files/upload',
    (request: Request, response: Response, next: NextFunction) => {
      uploadFilesMiddleware(request, response, (error?: unknown) => {
        if (!error) {
          void uploadHandler(request, response, next);
          return;
        }

        const errorCode = typeof error === 'object' && error !== null && 'code' in error
          ? String(error.code)
          : null;
        if (errorCode === 'LIMIT_FILE_SIZE') {
          response.status(400).json({
            error: `File too large. Maximum size is ${uploadLimits.maximumFileSizeMegabytes}MB.`,
          });
          return;
        }
        if (errorCode === 'LIMIT_FILE_COUNT') {
          response.status(400).json({
            error: `Too many files. Maximum is ${uploadLimits.maximumFileCount} files.`,
          });
          return;
        }

        const message = error instanceof Error ? error.message : String(error);
        response.status(500).json({ error: message });
      });
    },
  );

  return router;
}
