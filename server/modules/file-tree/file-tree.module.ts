import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs, { promises as fsPromises } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import mime from 'mime-types';
import multer from 'multer';

import { projectsDb } from '@/modules/database/index.js';
import { createFileTreeRouter } from '@/modules/file-tree/file-tree.routes.js';
import { createFileTreeService } from '@/modules/file-tree/file-tree.service.js';
import type {
  FileTreeFileSystem,
  FileTreeLogger,
  FileTreeMediaTranscoder,
  FileTreeProjectGateway,
  FileTreeWorkspaceGateway,
} from '@/shared/types.js';
import { WORKSPACES_ROOT, validateWorkspacePath } from '@/shared/utils.js';

const MAXIMUM_UPLOAD_SIZE_MEGABYTES = 200;
const MAXIMUM_UPLOAD_SIZE_BYTES = MAXIMUM_UPLOAD_SIZE_MEGABYTES * 1024 * 1024;
const MAXIMUM_UPLOAD_FILE_COUNT = 20;

function readFileSystemConcurrency(): number {
  const configuredConcurrency = Number.parseInt(process.env.FS_CONCURRENCY ?? '', 10);
  return Number.isFinite(configuredConcurrency) && configuredConcurrency > 0
    ? configuredConcurrency
    : 64;
}

// `mime-types` still reports pre-standard `x-` subtypes for a few media
// formats, and browsers refuse to decode some of them (Safari plays
// `audio/flac` but not `audio/x-flac`). Pinning the registered type here keeps
// the server's Content-Type aligned with what the browser preview expects.
const MIME_TYPE_OVERRIDES: Record<string, string> = {
  '.flac': 'audio/flac',
  '.opus': 'audio/opus',
};

/**
 * Content-Type the File Tree content endpoint reports for a workspace file.
 * Exported so the override table stays covered by tests without standing up
 * the whole composition root.
 */
export function resolveMimeType(filePath: string): string {
  const extension = path.extname(filePath).toLowerCase();
  // `mime.lookup` returns `false` (not null) for unknown extensions.
  return MIME_TYPE_OVERRIDES[extension] || mime.lookup(filePath) || 'application/octet-stream';
}

/**
 * Production filesystem adapter owned by the File Tree composition root.
 * Application services receive this complete capability explicitly and never
 * import Node's mutable filesystem APIs themselves.
 */
const fileTreeFileSystem: FileTreeFileSystem = {
  access: (candidatePath) => fsPromises.access(candidatePath),
  stat: (candidatePath) => fsPromises.stat(candidatePath),
  lstat: (candidatePath) => fsPromises.lstat(candidatePath),
  // `opendir` streams entries in batches and the handle is closed by the
  // iterator protocol, including when the caller stops early at the entry cap.
  openDirectory: async function* (directoryPath) {
    yield* await fsPromises.opendir(directoryPath);
  },
  realpath: (candidatePath) => fsPromises.realpath(candidatePath),
  readTextFile: (filePath) => fsPromises.readFile(filePath, 'utf8'),
  writeTextFile: (filePath, content) => fsPromises.writeFile(filePath, content, 'utf8'),
  async makeDirectory(directoryPath, recursive) {
    await fsPromises.mkdir(directoryPath, { recursive });
  },
  rename: (oldPath, newPath) => fsPromises.rename(oldPath, newPath),
  async removeDirectory(directoryPath) {
    await fsPromises.rm(directoryPath, { recursive: true, force: true });
  },
  unlink: (filePath) => fsPromises.unlink(filePath),
  copyFile: (sourcePath, destinationPath) => fsPromises.copyFile(sourcePath, destinationPath),
  createReadStream: (filePath, options) => fs.createReadStream(filePath, options),
};

/**
 * Database boundary used only by File Tree production composition.
 * The Database module is consumed through its barrel; services and routes see
 * only the narrow project-path lookup contract.
 */
const fileTreeProjects: FileTreeProjectGateway = {
  getProjectPathById: (projectId) => projectsDb.getProjectPathById(projectId),
};

/**
 * Workspace-policy boundary used only by File Tree production composition.
 * Keeping both the configured root and symlink-aware validator together makes
 * the path policy explicit for every service instance.
 */
const fileTreeWorkspace: FileTreeWorkspaceGateway = {
  rootPath: WORKSPACES_ROOT,
  validatePath: (candidatePath) => validateWorkspacePath(candidatePath),
};

const fileTreeLogger: FileTreeLogger = {
  error: (message, error) => console.error(message, error),
};

// ffmpeg is the converter because it is the one every platform already has a
// package for, and `FFMPEG_PATH` covers installs that keep it off the PATH.
const FFMPEG_BINARY = process.env.FFMPEG_PATH || 'ffmpeg';
// Converting one track takes seconds. The ceiling is only there so a process
// that wedges cannot hold an HTTP request open forever.
const TRANSCODE_TIMEOUT_MILLISECONDS = 10 * 60 * 1000;
const FFMPEG_PROBE_TIMEOUT_MILLISECONDS = 10_000;

/**
 * Runs ffmpeg and resolves only on a clean exit.
 *
 * The rejection carries ffmpeg's own last line, which names the actual problem
 * (an unsupported codec, a missing encoder) far better than an exit code does.
 */
function runFfmpeg(args: string[], timeoutMilliseconds: number): Promise<void> {
  return new Promise((resolve, reject) => {
    // `-nostdin` matters: ffmpeg otherwise waits on a prompt nobody can answer.
    const child = spawn(FFMPEG_BINARY, ['-nostdin', ...args], {
      stdio: ['ignore', 'ignore', 'pipe'],
    });

    let diagnostics = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMilliseconds);

    // Only the tail is kept: a long encode writes more than any error needs.
    child.stderr?.on('data', (chunk: Buffer) => {
      diagnostics = (diagnostics + chunk.toString()).slice(-2000);
    });

    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      if (timedOut) {
        reject(new Error('Converting the file took too long'));
        return;
      }
      if (code === 0) {
        resolve();
        return;
      }
      const lastLine = diagnostics.trim().split('\n').pop()?.trim();
      reject(new Error(lastLine || `ffmpeg exited with code ${code}`));
    });
  });
}

// Probed once per process: whether ffmpeg is installed does not change while
// the server runs, and the panel asks on every open.
let ffmpegAvailability: Promise<boolean> | null = null;

/**
 * Conversion boundary used only by File Tree production composition.
 * Absent ffmpeg is an answer, not an error — the panel then stops offering it.
 */
const fileTreeMediaTranscoder: FileTreeMediaTranscoder = {
  isAvailable() {
    ffmpegAvailability ??= runFfmpeg(['-version'], FFMPEG_PROBE_TIMEOUT_MILLISECONDS)
      .then(() => true, () => false);
    return ffmpegAvailability;
  },
  // The destination extension is what picks the container and codecs, so the
  // format the caller asked for is carried entirely by the path.
  transcode: (sourcePath, destinationPath) => runFfmpeg(
    ['-loglevel', 'error', '-i', sourcePath, destinationPath],
    TRANSCODE_TIMEOUT_MILLISECONDS,
  ),
};

const fileTreeServices = createFileTreeService({
  fileSystem: fileTreeFileSystem,
  projects: fileTreeProjects,
  workspace: fileTreeWorkspace,
  resolveMimeType,
  fileSystemConcurrency: readFileSystemConcurrency(),
  logger: fileTreeLogger,
  transcoder: fileTreeMediaTranscoder,
});

const fileUploadMiddleware = multer({
  storage: multer.diskStorage({
    destination: os.tmpdir(),
    filename: (_request, _file, callback) => {
      callback(null, `cloudcli-file-upload-${randomUUID()}`);
    },
  }),
  limits: {
    fileSize: MAXIMUM_UPLOAD_SIZE_BYTES,
    files: MAXIMUM_UPLOAD_FILE_COUNT,
  },
}).array('files', MAXIMUM_UPLOAD_FILE_COUNT);

/**
 * File Tree router used by the server entrypoint to mount the authenticated
 * browsing, editing, file-management, and upload API under `/api/file-tree`.
 */
export const fileTreeRoutes = createFileTreeRouter(
  fileTreeServices,
  fileUploadMiddleware,
  {
    maximumFileSizeMegabytes: MAXIMUM_UPLOAD_SIZE_MEGABYTES,
    maximumFileCount: MAXIMUM_UPLOAD_FILE_COUNT,
  },
  fileTreeLogger,
);
