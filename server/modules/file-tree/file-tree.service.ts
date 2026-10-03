import path from 'node:path';

import ignore from 'ignore';

import type {
  FileTreeDirectoryEntry,
  FileTreeMediaEntry,
  FileTreeNode,
  FileTreeOpenedFile,
  FileTreeServiceDependencies,
  FileTreeServices,
  FileTreeUploadedFile,
} from '@/shared/types.js';
import { AppError, FORBIDDEN_WORKSPACE_PATHS, normalizeProjectPath } from '@/shared/utils.js';

const HARD_EXCLUDED_DIRECTORY_NAMES = new Set([
  'node_modules', '.git', '.svn', '.hg',
]);

const IGNORED_DIRECTORY_NAMES = new Set([
  ...HARD_EXCLUDED_DIRECTORY_NAMES,
  'dist', 'build', '.next', '.nuxt', '.cache', '.parcel-cache',
  '__pycache__', '.pytest_cache', '.mypy_cache', '.tox', 'venv', '.venv',
  'target', 'vendor',
  '.gradle', '.idea', 'coverage', '.nyc_output',
]);

const COMMON_WORKSPACE_DIRECTORY_NAMES = [
  'Desktop',
  'Documents',
  'Projects',
  'Development',
  'Dev',
  'Code',
  'workspace',
];

// File Tree consumes this guard when recursively listing a project so a very
// broad workspace (for example, a user's home directory) cannot exhaust the
// server heap before the browser has a chance to switch to a narrower project.
const MAXIMUM_FILE_TREE_ENTRIES = 10_000;

// Only formats a browser can hand to an <audio>/<video> element are served
// outside a project boundary. Everything else — source, config, archives,
// documents — stays project-scoped, so this endpoint cannot be used to read a
// file the user did not open a player for.
const PLAYABLE_MEDIA_MIME_PREFIXES = ['audio/', 'video/'];

// Bounds for a configured media folder walk. A library is a folder of tracks,
// not a source tree, so a few levels and a generous file cap are plenty while
// still protecting a setting pointed at something enormous.
const MAXIMUM_MEDIA_LIBRARY_DEPTH = 3;
const MAXIMUM_MEDIA_LIBRARY_ENTRIES = 1_000;

type FileTreeEntryFilter = (entryPath: string, isDirectory: boolean) => boolean;

function includeEntryByHardExclusions(entryPath: string, isDirectory: boolean): boolean {
  return !isDirectory || !HARD_EXCLUDED_DIRECTORY_NAMES.has(path.basename(entryPath));
}

function includeEntryByFallbackDirectoryNames(entryPath: string, isDirectory: boolean): boolean {
  return includeEntryByHardExclusions(entryPath, isDirectory)
    && (!isDirectory || !IGNORED_DIRECTORY_NAMES.has(path.basename(entryPath)));
}

function createFileTreeError(message: string, statusCode: number, code: string): AppError {
  return new AppError(message, { statusCode, code });
}

// Single-range byte parser for media playback. `<audio>`/`<video>` elements send
// a lone `bytes=start-end` (or an open-ended `bytes=start-`) when seeking, so
// multi-range requests are deliberately treated as "no range" and answered with
// the whole file, which the HTTP spec permits.
function parseByteRange(
  rangeHeader: string | null | undefined,
  size: number,
): { start: number; end: number } | null | 'unsatisfiable' {
  if (!rangeHeader) {
    return null;
  }

  const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim());
  if (!match) {
    return null;
  }

  const [, rawStart, rawEnd] = match;
  if (!rawStart && !rawEnd) {
    return null;
  }

  // An empty file can satisfy no range at all, not even `bytes=0-`.
  if (size === 0) {
    return 'unsatisfiable';
  }

  // `bytes=-500` asks for the trailing 500 bytes.
  const start = rawStart ? Number.parseInt(rawStart, 10) : Math.max(size - Number.parseInt(rawEnd, 10), 0);
  const end = rawStart
    ? Math.min(rawEnd ? Number.parseInt(rawEnd, 10) : size - 1, size - 1)
    : size - 1;

  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= size) {
    return 'unsatisfiable';
  }

  return { start, end };
}

function readErrorCode(error: unknown): string | null {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String(error.code)
    : null;
}

function readErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function permissionBitsToRwx(permissionBits: number): string {
  const read = permissionBits & 4 ? 'r' : '-';
  const write = permissionBits & 2 ? 'w' : '-';
  const execute = permissionBits & 1 ? 'x' : '-';
  return read + write + execute;
}

function validateFilename(name: string): void {
  if (!name.trim()) {
    throw createFileTreeError('Filename cannot be empty', 400, 'INVALID_FILENAME');
  }

  if (/[<>:"/\\|?*\x00-\x1f]/.test(name)) {
    throw createFileTreeError('Filename contains invalid characters', 400, 'INVALID_FILENAME');
  }

  if (/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i.test(name)) {
    throw createFileTreeError('Filename is a reserved name', 400, 'INVALID_FILENAME');
  }

  if (/^\.+$/.test(name)) {
    throw createFileTreeError('Filename cannot be only dots', 400, 'INVALID_FILENAME');
  }
}

function resolvePathInsideProject(projectRoot: string, targetPath: string): string {
  const resolvedPath = path.isAbsolute(targetPath)
    ? path.resolve(targetPath)
    : path.resolve(projectRoot, targetPath);
  const normalizedProjectRoot = path.resolve(projectRoot) + path.sep;

  if (!resolvedPath.startsWith(normalizedProjectRoot)) {
    throw createFileTreeError('Path must be under project root', 403, 'PATH_OUTSIDE_PROJECT');
  }

  return resolvedPath;
}

function expandWorkspacePath(workspaceRoot: string, inputPath: string): string {
  if (inputPath === '~') {
    return workspaceRoot;
  }
  if (inputPath.startsWith('~/') || inputPath.startsWith('~\\')) {
    return path.join(workspaceRoot, inputPath.slice(2));
  }
  return inputPath;
}

function createConcurrencyLimiter(maximumConcurrency: number) {
  let activeOperations = 0;
  const pendingOperations: Array<() => void> = [];

  async function acquire(): Promise<void> {
    if (activeOperations < maximumConcurrency) {
      activeOperations += 1;
      return;
    }

    await new Promise<void>((resolve) => {
      pendingOperations.push(resolve);
    });
  }

  function release(): void {
    const nextOperation = pendingOperations.shift();
    if (nextOperation) {
      nextOperation();
      return;
    }

    activeOperations = Math.max(0, activeOperations - 1);
  }

  return { acquire, release };
}

function mapFileSystemError(
  error: unknown,
  messages: Partial<Record<string, { message: string; statusCode: number }>>,
): never {
  const errorCode = readErrorCode(error);
  const mappedError = errorCode ? messages[errorCode] : undefined;
  if (mappedError) {
    throw createFileTreeError(mappedError.message, mappedError.statusCode, errorCode ?? 'FILE_TREE_ERROR');
  }

  throw error;
}

function createGitignoreEntryFilter(
  projectRoot: string,
  gitignoreContent: string,
): FileTreeEntryFilter {
  const gitignore = ignore().add(gitignoreContent);

  return (entryPath, isDirectory) => {
    if (!includeEntryByHardExclusions(entryPath, isDirectory)) return false;

    const relativePath = path.relative(projectRoot, entryPath).split(path.sep).join('/');
    const matchPath = isDirectory ? `${relativePath}/` : relativePath;
    return !gitignore.ignores(matchPath);
  };
}

/**
 * Creates File Tree workflows for the module composition root and route tests.
 * Every filesystem, project, workspace, environment, and logging dependency is
 * required explicitly so this service has no machine-wide production defaults.
 */
export function createFileTreeService(dependencies: FileTreeServiceDependencies): FileTreeServices {
  const fileSystem = dependencies.fileSystem;
  const concurrencyLimit = Number.isFinite(dependencies.fileSystemConcurrency)
    && dependencies.fileSystemConcurrency > 0
    ? Math.floor(dependencies.fileSystemConcurrency)
    : 1;
  const { acquire, release } = createConcurrencyLimiter(concurrencyLimit);

  async function resolveProjectRoot(projectId: string): Promise<string> {
    const projectRoot = await dependencies.projects.getProjectPathById(projectId);
    if (!projectRoot) {
      throw createFileTreeError('Project not found', 404, 'PROJECT_NOT_FOUND');
    }
    return projectRoot;
  }

  /**
   * Streams one directory and keeps only the entries the tree will show.
   *
   * Entries are filtered and charged against the shared budget one at a time,
   * so a pathologically large directory stops the walk at the cap instead of
   * being read into memory in full first.
   */
  async function collectVisibleEntries(
    directoryPath: string,
    includeEntry: FileTreeEntryFilter,
    remainingEntries: { value: number },
  ): Promise<FileTreeDirectoryEntry[]> {
    const visibleEntries: FileTreeDirectoryEntry[] = [];

    await acquire();
    try {
      for await (const entry of fileSystem.openDirectory(directoryPath)) {
        const isDirectory = entry.isDirectory();
        if (!includeEntry(path.join(directoryPath, entry.name), isDirectory)) {
          continue;
        }

        // Charged after visibility filtering so ignored entries never consume
        // the budget. Every recursive branch shares one counter, so the cap
        // applies to the whole tree rather than per directory.
        if (remainingEntries.value <= 0) {
          throw createFileTreeError(
            `Project file tree exceeds the ${MAXIMUM_FILE_TREE_ENTRIES.toLocaleString()} entry limit. Choose a narrower project directory or add ignore rules.`,
            413,
            'FILE_TREE_TOO_LARGE',
          );
        }
        remainingEntries.value -= 1;
        visibleEntries.push(entry);
      }
    } catch (error) {
      // The entry cap is a caller-visible outcome, not an unreadable directory.
      if (error instanceof AppError) {
        throw error;
      }
      const errorCode = readErrorCode(error);
      if (errorCode !== 'EACCES' && errorCode !== 'EPERM') {
        dependencies.logger.error(`Error reading directory "${directoryPath}"`, error);
      }
      return [];
    } finally {
      release();
    }

    return visibleEntries;
  }

  async function buildFileTree(
    directoryPath: string,
    maximumDepth: number,
    currentDepth = 0,
    includeEntry: FileTreeEntryFilter = includeEntryByFallbackDirectoryNames,
    remainingEntries = { value: MAXIMUM_FILE_TREE_ENTRIES },
  ): Promise<FileTreeNode[]> {
    const visibleEntries = await collectVisibleEntries(directoryPath, includeEntry, remainingEntries);

    const items = await Promise.all(visibleEntries.map(async (entry): Promise<FileTreeNode> => {
      const itemPath = path.join(directoryPath, entry.name);
      const item: FileTreeNode = {
        name: entry.name,
        path: itemPath,
        type: entry.isDirectory() ? 'directory' : 'file',
        size: 0,
        modified: null,
        permissions: '000',
        permissionsRwx: '---------',
      };

      try {
        await acquire();
        try {
          const stats = await fileSystem.lstat(itemPath);
          const ownerPermissions = (stats.mode >> 6) & 7;
          const groupPermissions = (stats.mode >> 3) & 7;
          const otherPermissions = stats.mode & 7;

          item.size = stats.size;
          item.modified = stats.mtime.toISOString();
          item.permissions = `${ownerPermissions}${groupPermissions}${otherPermissions}`;
          item.permissionsRwx = permissionBitsToRwx(ownerPermissions)
            + permissionBitsToRwx(groupPermissions)
            + permissionBitsToRwx(otherPermissions);
          if (stats.isSymbolicLink()) {
            item.isSymlink = true;
          }
        } finally {
          release();
        }
      } catch {
        // Metadata failures should not hide an otherwise readable tree entry.
      }

      // Skip recursing into pseudo-filesystems and other system-critical
      // directories (e.g. /proc, /sys) — they're never valid project roots,
      // and /proc in particular can contain thousands of virtual entries
      // that make traversal from a broad root (e.g. "/") pathologically slow.
      const isForbiddenSystemDir = FORBIDDEN_WORKSPACE_PATHS.includes(normalizeProjectPath(itemPath));

      if (entry.isDirectory() && currentDepth < maximumDepth && !isForbiddenSystemDir) {
        item.children = await buildFileTree(
          itemPath,
          maximumDepth,
          currentDepth + 1,
          includeEntry,
          remainingEntries,
        );
      }

      return item;
    }));

    return items.sort((left, right) => {
      if (left.type !== right.type) {
        return left.type === 'directory' ? -1 : 1;
      }
      return left.name.localeCompare(right.name);
    });
  }

  function isPlayableMedia(candidatePath: string): boolean {
    const contentType = dependencies.resolveMimeType(candidatePath);
    return PLAYABLE_MEDIA_MIME_PREFIXES.some((prefix) => contentType.startsWith(prefix));
  }

  /**
   * Resolves a caller-supplied path against the workspace root and refuses
   * anything the workspace policy rejects. This is the only path check the
   * media endpoints apply: the files a player is pointed at commonly live
   * outside the open project, for example output an external tool wrote to its
   * own folder.
   */
  async function resolveInsideWorkspace(inputPath: string): Promise<string> {
    if (!inputPath.trim()) {
      throw createFileTreeError('Invalid file path', 400, 'INVALID_FILE_PATH');
    }

    const resolvedInput = path.resolve(
      expandWorkspacePath(dependencies.workspace.rootPath, inputPath),
    );
    const validation = await dependencies.workspace.validatePath(resolvedInput);
    if (!validation.valid) {
      throw createFileTreeError(
        validation.error ?? 'Path is outside the workspace root',
        403,
        'INVALID_WORKSPACE_PATH',
      );
    }

    return validation.resolvedPath || resolvedInput;
  }

  /**
   * Walks a media folder and collects the files a player can open.
   *
   * Bounded on both axes so pointing the setting at a huge tree cannot stall
   * the server: nested folders are followed only a few levels down, and the
   * walk stops once the cap is reached.
   */
  async function collectMediaFiles(
    rootPath: string,
    directoryPath: string,
    depth: number,
    found: FileTreeMediaEntry[],
  ): Promise<void> {
    if (found.length >= MAXIMUM_MEDIA_LIBRARY_ENTRIES) {
      return;
    }

    let entries: FileTreeDirectoryEntry[];
    try {
      entries = [];
      for await (const entry of fileSystem.openDirectory(directoryPath)) {
        entries.push(entry);
      }
    } catch {
      // An unreadable subfolder should not empty the whole library.
      return;
    }

    for (const entry of entries) {
      if (found.length >= MAXIMUM_MEDIA_LIBRARY_ENTRIES) {
        return;
      }

      const entryPath = path.join(directoryPath, entry.name);

      if (entry.isDirectory()) {
        if (depth < MAXIMUM_MEDIA_LIBRARY_DEPTH && !IGNORED_DIRECTORY_NAMES.has(entry.name)) {
          await collectMediaFiles(rootPath, entryPath, depth + 1, found);
        }
        continue;
      }

      if (!isPlayableMedia(entryPath)) {
        continue;
      }

      let size = 0;
      let modifiedAt: string | null = null;
      try {
        // `stat`, not `lstat`: a library commonly holds symlinks into the tool's
        // own output folder, and the link's own size (a few dozen bytes) is not
        // what the player should report.
        const stats = await fileSystem.stat(entryPath);
        size = stats.size;
        modifiedAt = stats.mtime.toISOString();
      } catch {
        // Keep the entry: it is still playable even if its metadata is not
        // readable, and the player shows what it can.
      }

      found.push({
        name: entry.name,
        path: entryPath,
        relativePath: path.relative(rootPath, entryPath).split(path.sep).join('/'),
        size,
        modifiedAt,
        contentType: dependencies.resolveMimeType(entryPath),
      });
    }
  }

  /**
   * Stats one already-authorized path and returns it as a streamable response,
   * honouring a byte range when the caller asked for one. Shared by the
   * project-scoped and media openers so range handling has one implementation.
   */
  async function openResolvedFile(
    resolvedPath: string,
    rangeHeader: string | null | undefined,
  ): Promise<FileTreeOpenedFile> {
    let size: number;
    let modifiedAt: Date | null;
    try {
      await fileSystem.access(resolvedPath);
      const stats = await fileSystem.stat(resolvedPath);
      size = stats.size;
      modifiedAt = stats.mtime;
    } catch {
      throw createFileTreeError('File not found', 404, 'FILE_NOT_FOUND');
    }

    const contentType = dependencies.resolveMimeType(resolvedPath);
    const requestedRange = parseByteRange(rangeHeader, size);

    if (requestedRange === 'unsatisfiable') {
      // The size travels with the error so the route can answer with the
      // `Content-Range: bytes */<size>` header a 416 response requires.
      throw new AppError('Requested range not satisfiable', {
        statusCode: 416,
        code: 'RANGE_NOT_SATISFIABLE',
        details: { size },
      });
    }

    if (!requestedRange) {
      return {
        contentType,
        stream: fileSystem.createReadStream(resolvedPath),
        size,
        modifiedAt,
        contentRange: null,
      };
    }

    return {
      contentType,
      stream: fileSystem.createReadStream(resolvedPath, {
        start: requestedRange.start,
        end: requestedRange.end,
      }),
      size,
      modifiedAt,
      contentRange: requestedRange,
    };
  }

  async function cleanupTemporaryFiles(files: FileTreeUploadedFile[]): Promise<void> {
    await Promise.all(files.map(async (file) => {
      try {
        await fileSystem.unlink(file.temporaryPath);
      } catch {
        // A successfully moved file no longer has a temporary source to clean.
      }
    }));
  }

  return {
    async browseWorkspace(inputPath) {
      const requestedPath = inputPath
        ? expandWorkspacePath(dependencies.workspace.rootPath, inputPath)
        : dependencies.workspace.rootPath;
      const targetPath = path.resolve(requestedPath);
      const validation = await dependencies.workspace.validatePath(targetPath);
      if (!validation.valid) {
        throw createFileTreeError(validation.error ?? 'Path is outside the workspace root', 403, 'INVALID_WORKSPACE_PATH');
      }

      const resolvedPath = validation.resolvedPath || targetPath;
      try {
        await fileSystem.access(resolvedPath);
        const stats = await fileSystem.stat(resolvedPath);
        if (!stats.isDirectory()) {
          throw createFileTreeError('Path is not a directory', 400, 'NOT_A_DIRECTORY');
        }
      } catch (error) {
        if (error instanceof AppError) throw error;
        throw createFileTreeError('Directory not accessible', 404, 'DIRECTORY_NOT_ACCESSIBLE');
      }

      const fileTree = await buildFileTree(resolvedPath, 1);
      const directories = fileTree
        .filter((item) => item.type === 'directory')
        .map((item) => ({ path: item.path, name: item.name, type: 'directory' as const }))
        .sort((left, right) => {
          const leftHidden = left.name.startsWith('.');
          const rightHidden = right.name.startsWith('.');
          if (leftHidden && !rightHidden) return 1;
          if (!leftHidden && rightHidden) return -1;
          return left.name.localeCompare(right.name);
        });

      let resolvedWorkspaceRoot = dependencies.workspace.rootPath;
      try {
        resolvedWorkspaceRoot = await fileSystem.realpath(dependencies.workspace.rootPath);
      } catch {
        // The configured workspace root remains the comparison fallback.
      }

      const suggestions = resolvedPath === resolvedWorkspaceRoot
        ? [
            ...directories.filter((directory) => COMMON_WORKSPACE_DIRECTORY_NAMES.includes(directory.name)),
            ...directories.filter((directory) => !COMMON_WORKSPACE_DIRECTORY_NAMES.includes(directory.name)),
          ]
        : directories;

      return { path: resolvedPath, suggestions };
    },

    async createWorkspaceFolder(folderPath) {
      const expandedPath = expandWorkspacePath(dependencies.workspace.rootPath, folderPath);
      const resolvedInput = path.resolve(expandedPath);
      const validation = await dependencies.workspace.validatePath(resolvedInput);
      if (!validation.valid) {
        throw createFileTreeError(validation.error ?? 'Path is outside the workspace root', 403, 'INVALID_WORKSPACE_PATH');
      }

      const targetPath = validation.resolvedPath || resolvedInput;
      try {
        await fileSystem.access(path.dirname(targetPath));
      } catch {
        throw createFileTreeError('Parent directory does not exist', 404, 'PARENT_DIRECTORY_NOT_FOUND');
      }

      try {
        await fileSystem.access(targetPath);
        throw createFileTreeError('Folder already exists', 409, 'FOLDER_ALREADY_EXISTS');
      } catch (error) {
        if (error instanceof AppError) throw error;
      }

      try {
        await fileSystem.makeDirectory(targetPath, false);
      } catch (error) {
        mapFileSystemError(error, {
          EEXIST: { message: 'Folder already exists', statusCode: 409 },
        });
      }

      return { success: true, path: targetPath };
    },

    async readTextFile(projectId, filePath) {
      const projectRoot = await resolveProjectRoot(projectId);
      const resolvedPath = resolvePathInsideProject(projectRoot, filePath);
      try {
        const content = await fileSystem.readTextFile(resolvedPath);
        return { content, path: resolvedPath };
      } catch (error) {
        mapFileSystemError(error, {
          ENOENT: { message: 'File not found', statusCode: 404 },
          EACCES: { message: 'Permission denied', statusCode: 403 },
        });
      }
    },

    async openFile(projectId, filePath, options) {
      const projectRoot = await resolveProjectRoot(projectId);
      return openResolvedFile(
        resolvePathInsideProject(projectRoot, filePath),
        options?.rangeHeader,
      );
    },

    async openMediaFile(filePath, options) {
      const resolvedPath = await resolveInsideWorkspace(filePath);
      if (!isPlayableMedia(resolvedPath)) {
        throw createFileTreeError('File is not playable media', 415, 'NOT_PLAYABLE_MEDIA');
      }

      return openResolvedFile(resolvedPath, options?.rangeHeader);
    },

    async listMediaFiles(folderPath) {
      const resolvedFolder = await resolveInsideWorkspace(folderPath);
      try {
        const stats = await fileSystem.stat(resolvedFolder);
        if (!stats.isDirectory()) {
          throw createFileTreeError('Path is not a directory', 400, 'NOT_A_DIRECTORY');
        }
      } catch (error) {
        if (error instanceof AppError) throw error;
        throw createFileTreeError('Folder not found', 404, 'FOLDER_NOT_FOUND');
      }

      const found: FileTreeMediaEntry[] = [];
      await collectMediaFiles(resolvedFolder, resolvedFolder, 0, found);

      // Newest first: a library is usually opened to reach what was just made.
      found.sort((left, right) => (right.modifiedAt ?? '').localeCompare(left.modifiedAt ?? ''));

      return { path: resolvedFolder, files: found };
    },

    async saveTextFile(projectId, filePath, content) {
      const projectRoot = await resolveProjectRoot(projectId);
      const resolvedPath = resolvePathInsideProject(projectRoot, filePath);
      try {
        await fileSystem.writeTextFile(resolvedPath, content);
      } catch (error) {
        mapFileSystemError(error, {
          ENOENT: { message: 'File or directory not found', statusCode: 404 },
          EACCES: { message: 'Permission denied', statusCode: 403 },
        });
      }

      return { success: true, path: resolvedPath, message: 'File saved successfully' };
    },

    async listProjectFiles(projectId, options) {
      const projectRoot = await resolveProjectRoot(projectId);
      try {
        await fileSystem.access(projectRoot);
      } catch {
        throw createFileTreeError(`Project path not found: ${projectRoot}`, 404, 'PROJECT_PATH_NOT_FOUND');
      }

      let includeEntry: FileTreeEntryFilter | undefined;
      if (options?.respectGitignore) {
        try {
          const gitignoreContent = await fileSystem.readTextFile(path.join(projectRoot, '.gitignore'));
          includeEntry = createGitignoreEntryFilter(projectRoot, gitignoreContent);
        } catch (error) {
          if (readErrorCode(error) !== 'ENOENT') {
            dependencies.logger.error(`Error reading .gitignore in "${projectRoot}"`, error);
          }
        }
      }

      return buildFileTree(projectRoot, 10, 0, includeEntry);
    },

    async createEntry(input) {
      validateFilename(input.name);
      const projectRoot = await resolveProjectRoot(input.projectId);
      const targetPath = input.parentPath
        ? path.join(input.parentPath, input.name)
        : input.name;
      const resolvedPath = resolvePathInsideProject(projectRoot, targetPath);

      try {
        await fileSystem.access(resolvedPath);
        throw createFileTreeError(
          `${input.type === 'file' ? 'File' : 'Directory'} already exists`,
          409,
          'FILE_TREE_ENTRY_EXISTS',
        );
      } catch (error) {
        if (error instanceof AppError) throw error;
      }

      try {
        if (input.type === 'directory') {
          await fileSystem.makeDirectory(resolvedPath, false);
        } else {
          const parentDirectory = path.dirname(resolvedPath);
          try {
            await fileSystem.access(parentDirectory);
          } catch {
            await fileSystem.makeDirectory(parentDirectory, true);
          }
          await fileSystem.writeTextFile(resolvedPath, '');
        }
      } catch (error) {
        mapFileSystemError(error, {
          EACCES: { message: 'Permission denied', statusCode: 403 },
          ENOENT: { message: 'Parent directory not found', statusCode: 404 },
        });
      }

      return {
        success: true,
        path: resolvedPath,
        name: input.name,
        type: input.type,
        message: `${input.type === 'file' ? 'File' : 'Directory'} created successfully`,
      };
    },

    async renameEntry(input) {
      validateFilename(input.newName);
      const projectRoot = await resolveProjectRoot(input.projectId);
      const resolvedOldPath = resolvePathInsideProject(projectRoot, input.oldPath);

      try {
        await fileSystem.access(resolvedOldPath);
      } catch {
        throw createFileTreeError('File or directory not found', 404, 'FILE_TREE_ENTRY_NOT_FOUND');
      }

      const resolvedNewPath = path.join(path.dirname(resolvedOldPath), input.newName);
      resolvePathInsideProject(projectRoot, resolvedNewPath);
      try {
        await fileSystem.access(resolvedNewPath);
        throw createFileTreeError(
          'A file or directory with this name already exists',
          409,
          'FILE_TREE_ENTRY_EXISTS',
        );
      } catch (error) {
        if (error instanceof AppError) throw error;
      }

      try {
        await fileSystem.rename(resolvedOldPath, resolvedNewPath);
      } catch (error) {
        mapFileSystemError(error, {
          EACCES: { message: 'Permission denied', statusCode: 403 },
          ENOENT: { message: 'File or directory not found', statusCode: 404 },
          EXDEV: { message: 'Cannot move across different filesystems', statusCode: 400 },
        });
      }

      return {
        success: true,
        oldPath: resolvedOldPath,
        newPath: resolvedNewPath,
        newName: input.newName,
        message: 'Renamed successfully',
      };
    },

    async deleteEntry(input) {
      const projectRoot = await resolveProjectRoot(input.projectId);
      const resolvedPath = resolvePathInsideProject(projectRoot, input.targetPath);
      let stats;
      try {
        stats = await fileSystem.stat(resolvedPath);
      } catch {
        throw createFileTreeError('File or directory not found', 404, 'FILE_TREE_ENTRY_NOT_FOUND');
      }

      if (resolvedPath === path.resolve(projectRoot)) {
        throw createFileTreeError('Cannot delete project root directory', 403, 'PROJECT_ROOT_DELETE_FORBIDDEN');
      }

      try {
        if (stats.isDirectory()) {
          await fileSystem.removeDirectory(resolvedPath);
        } else {
          await fileSystem.unlink(resolvedPath);
        }
      } catch (error) {
        mapFileSystemError(error, {
          EACCES: { message: 'Permission denied', statusCode: 403 },
          ENOENT: { message: 'File or directory not found', statusCode: 404 },
          ENOTEMPTY: { message: 'Directory is not empty', statusCode: 400 },
        });
      }

      const entryType = stats.isDirectory() ? 'directory' as const : 'file' as const;
      return {
        success: true,
        path: resolvedPath,
        type: entryType,
        message: 'Deleted successfully',
      };
    },

    async storeUploadedFiles(input) {
      if (input.files.length === 0) {
        throw createFileTreeError('No files provided', 400, 'UPLOAD_FILES_REQUIRED');
      }

      try {
        const projectRoot = await resolveProjectRoot(input.projectId);
        const resolvedTargetDirectory = !input.targetPath
          || input.targetPath === '.'
          || input.targetPath === './'
          ? path.resolve(projectRoot)
          : resolvePathInsideProject(projectRoot, input.targetPath);

        try {
          await fileSystem.access(resolvedTargetDirectory);
        } catch {
          await fileSystem.makeDirectory(resolvedTargetDirectory, true);
        }

        const uploadedFiles: Array<{ name: string; path: string; size: number; mimeType: string }> = [];
        for (let fileIndex = 0; fileIndex < input.files.length; fileIndex += 1) {
          const file = input.files[fileIndex];
          const fileName = input.relativePaths[fileIndex] || file.originalName;
          const destinationPath = path.join(resolvedTargetDirectory, fileName);

          try {
            resolvePathInsideProject(projectRoot, destinationPath);
          } catch (error) {
            if (error instanceof AppError && error.statusCode === 403) {
              await cleanupTemporaryFiles([file]);
              continue;
            }
            throw error;
          }

          const parentDirectory = path.dirname(destinationPath);
          try {
            await fileSystem.access(parentDirectory);
          } catch {
            await fileSystem.makeDirectory(parentDirectory, true);
          }

          await fileSystem.copyFile(file.temporaryPath, destinationPath);
          await fileSystem.unlink(file.temporaryPath);
          uploadedFiles.push({
            name: fileName,
            path: destinationPath,
            size: file.size,
            mimeType: file.mimeType,
          });
        }

        return {
          success: true,
          files: uploadedFiles,
          uploadedCount: uploadedFiles.length,
          requestedFileCount: input.requestedFileCount,
          targetPath: resolvedTargetDirectory,
          message: `Uploaded ${uploadedFiles.length} ${uploadedFiles.length === 1 ? 'file' : 'files'} successfully`,
        };
      } catch (error) {
        await cleanupTemporaryFiles(input.files);
        if (readErrorCode(error) === 'EACCES') {
          throw createFileTreeError('Permission denied', 403, 'EACCES');
        }
        if (error instanceof AppError) throw error;
        dependencies.logger.error(`Error uploading files: ${readErrorMessage(error)}`, error);
        throw error;
      }
    },
  };
}
