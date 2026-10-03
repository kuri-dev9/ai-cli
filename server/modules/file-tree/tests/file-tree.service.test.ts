import assert from 'node:assert/strict';
import path from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';

import { createFileTreeService } from '@/modules/file-tree/file-tree.service.js';
import type {
  FileTreeDirectoryEntry,
  FileTreeFileSystem,
  FileTreeServiceDependencies,
  FileTreeStats,
} from '@/shared/types.js';
import { AppError } from '@/shared/utils.js';

function createDirectoryEntry(name: string, directory: boolean): FileTreeDirectoryEntry {
  return {
    name,
    isDirectory: () => directory,
  };
}

/**
 * Adapts a path-keyed listing to the streaming directory contract so tests keep
 * describing directories as plain arrays.
 */
function createDirectoryReader(
  listDirectory: (directoryPath: string) => FileTreeDirectoryEntry[],
): FileTreeFileSystem['openDirectory'] {
  return async function* openDirectory(directoryPath) {
    yield* listDirectory(directoryPath);
  };
}

function createStats(directory: boolean, mode: number): FileTreeStats {
  return {
    size: directory ? 0 : 24,
    mtime: new Date('2026-01-02T03:04:05.000Z'),
    mode,
    isDirectory: () => directory,
    isSymbolicLink: () => false,
  };
}

async function streamToBuffer(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.from(chunk as Buffer));
  }
  return Buffer.concat(chunks);
}

function createFakeFileSystem(
  overrides: Partial<FileTreeFileSystem> = {},
): FileTreeFileSystem {
  const unexpectedOperation = async (): Promise<never> => {
    throw new Error('Unexpected File Tree filesystem operation');
  };

  return {
    access: unexpectedOperation,
    stat: unexpectedOperation,
    lstat: unexpectedOperation,
    openDirectory: () => ({
      [Symbol.asyncIterator]: () => ({ next: unexpectedOperation }),
    }),
    realpath: unexpectedOperation,
    readTextFile: unexpectedOperation,
    writeTextFile: unexpectedOperation,
    makeDirectory: unexpectedOperation,
    rename: unexpectedOperation,
    removeDirectory: unexpectedOperation,
    unlink: unexpectedOperation,
    copyFile: unexpectedOperation,
    createReadStream: () => Readable.from([]),
    ...overrides,
  };
}

function createDependencies(
  fileSystem: FileTreeFileSystem,
  projectRoot: string,
): FileTreeServiceDependencies {
  return {
    fileSystem,
    projects: {
      getProjectPathById: async () => projectRoot,
    },
    workspace: {
      rootPath: projectRoot,
      validatePath: async (candidatePath) => ({ valid: true, resolvedPath: candidatePath }),
    },
    resolveMimeType: () => 'text/plain',
    fileSystemConcurrency: 4,
    logger: { error: () => undefined },
  };
}

test('listProjectFiles applies gitignore alongside hard directory exclusions', async () => {
  const projectRoot = path.resolve('file-tree-test-project');
  const documentationDirectory = path.join(projectRoot, 'docs');
  const buildDocumentationDirectory = path.join(documentationDirectory, 'build');
  const gitDirectory = path.join(projectRoot, '.git');
  const nodeModulesDirectory = path.join(projectRoot, 'node_modules');
  const sourceDirectory = path.join(projectRoot, 'src');
  const readDirectories: string[] = [];
  const fileSystem = createFakeFileSystem({
    access: async () => undefined,
    readTextFile: async (filePath) => {
      assert.equal(filePath, path.join(projectRoot, '.gitignore'));
      return '*.log';
    },
    openDirectory: createDirectoryReader((directoryPath) => {
      readDirectories.push(directoryPath);
      if (directoryPath === projectRoot) {
        return [
          createDirectoryEntry('.git', true),
          createDirectoryEntry('node_modules', true),
          createDirectoryEntry('README.md', false),
          createDirectoryEntry('docs', true),
          createDirectoryEntry('src', true),
        ];
      }
      if (directoryPath === documentationDirectory) {
        return [createDirectoryEntry('build', true)];
      }
      if (directoryPath === buildDocumentationDirectory) {
        return [createDirectoryEntry('foo.md', false)];
      }
      if (directoryPath === sourceDirectory) {
        return [createDirectoryEntry('index.ts', false)];
      }
      return [];
    }),
    lstat: async (candidatePath) => createStats(
      candidatePath === documentationDirectory
        || candidatePath === buildDocumentationDirectory
        || candidatePath === sourceDirectory
        || candidatePath === gitDirectory
        || candidatePath === nodeModulesDirectory,
      0o754,
    ),
  });
  const service = createFileTreeService(createDependencies(fileSystem, projectRoot));

  const tree = await service.listProjectFiles('project-1', { respectGitignore: true });

  assert.deepEqual(tree.map((entry) => entry.name), ['docs', 'src', 'README.md']);
  const documentationEntry = tree[0];
  assert.deepEqual(documentationEntry?.children?.map((entry) => entry.name), ['build']);
  assert.deepEqual(documentationEntry?.children?.[0]?.children?.map((entry) => entry.name), ['foo.md']);
  const sourceEntry = tree[1];
  assert.ok(sourceEntry);
  assert.equal(sourceEntry.type, 'directory');
  assert.equal(sourceEntry.permissions, '754');
  assert.equal(sourceEntry.permissionsRwx, 'rwxr-xr--');
  assert.deepEqual(sourceEntry.children?.map((entry) => entry.name), ['index.ts']);
  assert.equal(readDirectories.includes(gitDirectory), false);
  assert.equal(readDirectories.includes(nodeModulesDirectory), false);
});

test('listProjectFiles excludes gitignored entries only when requested', async () => {
  const projectRoot = path.resolve('file-tree-test-project');
  const cacheDirectory = path.join(projectRoot, 'cache');
  const sourceDirectory = path.join(projectRoot, 'src');
  const readDirectories: string[] = [];
  const fileSystem = createFakeFileSystem({
    access: async () => undefined,
    readTextFile: async (filePath) => {
      assert.equal(filePath, path.join(projectRoot, '.gitignore'));
      return ['*.log', '!keep.log', 'cache/', 'src/generated.ts'].join('\n');
    },
    openDirectory: createDirectoryReader((directoryPath) => {
      readDirectories.push(directoryPath);
      if (directoryPath === projectRoot) {
        return [
          createDirectoryEntry('.gitignore', false),
          createDirectoryEntry('cache', true),
          createDirectoryEntry('ignored.log', false),
          createDirectoryEntry('keep.log', false),
          createDirectoryEntry('src', true),
        ];
      }
      if (directoryPath === cacheDirectory) {
        return [createDirectoryEntry('cached.txt', false)];
      }
      if (directoryPath === sourceDirectory) {
        return [
          createDirectoryEntry('generated.ts', false),
          createDirectoryEntry('index.ts', false),
        ];
      }
      return [];
    }),
    lstat: async (candidatePath) => createStats(
      candidatePath === cacheDirectory || candidatePath === sourceDirectory,
      0o644,
    ),
  });
  const service = createFileTreeService(createDependencies(fileSystem, projectRoot));

  const tree = await service.listProjectFiles('project-1', { respectGitignore: true });

  assert.deepEqual(tree.map((entry) => entry.name), ['src', '.gitignore', 'keep.log']);
  assert.deepEqual(tree[0]?.children?.map((entry) => entry.name), ['index.ts']);
  assert.equal(readDirectories.includes(cacheDirectory), false);
});

test('listProjectFiles falls back to conventional directory names when no gitignore exists', async () => {
  const projectRoot = path.resolve('file-tree-test-project');
  const documentationDirectory = path.join(projectRoot, 'docs');
  const buildDocumentationDirectory = path.join(documentationDirectory, 'build');
  const nodeModulesDirectory = path.join(projectRoot, 'node_modules');
  const readDirectories: string[] = [];
  const fileSystem = createFakeFileSystem({
    access: async () => undefined,
    readTextFile: async () => {
      throw Object.assign(new Error('missing'), { code: 'ENOENT' });
    },
    openDirectory: createDirectoryReader((directoryPath) => {
      readDirectories.push(directoryPath);
      if (directoryPath === projectRoot) {
        return [
          createDirectoryEntry('debug.log', false),
          createDirectoryEntry('docs', true),
          createDirectoryEntry('node_modules', true),
        ];
      }
      if (directoryPath === documentationDirectory) {
        return [
          createDirectoryEntry('build', true),
          createDirectoryEntry('guide.md', false),
        ];
      }
      if (directoryPath === buildDocumentationDirectory) {
        return [createDirectoryEntry('generated.md', false)];
      }
      return [];
    }),
    lstat: async (candidatePath) => createStats(candidatePath === documentationDirectory, 0o644),
  });
  const service = createFileTreeService(createDependencies(fileSystem, projectRoot));

  const tree = await service.listProjectFiles('project-1', { respectGitignore: true });

  assert.deepEqual(tree.map((entry) => entry.name), ['docs', 'debug.log']);
  assert.deepEqual(tree[0]?.children?.map((entry) => entry.name), ['guide.md']);
  assert.equal(readDirectories.includes(nodeModulesDirectory), false);
  assert.equal(readDirectories.includes(buildDocumentationDirectory), false);
});

test('listProjectFiles rejects a tree that exceeds the server entry limit', async () => {
  const projectRoot = path.resolve('file-tree-test-project');
  const fileSystem = createFakeFileSystem({
    access: async () => undefined,
    openDirectory: createDirectoryReader((directoryPath) => directoryPath === projectRoot
      ? Array.from({ length: 10_001 }, (_, index) => createDirectoryEntry(`file-${index}.txt`, false))
      : []),
    lstat: async () => createStats(false, 0o644),
  });
  const service = createFileTreeService(createDependencies(fileSystem, projectRoot));

  await assert.rejects(
    service.listProjectFiles('project-1'),
    (error: unknown) => error instanceof AppError
      && error.code === 'FILE_TREE_TOO_LARGE'
      && error.statusCode === 413,
  );
});

test('listProjectFiles abandons a directory stream as soon as the entry limit is passed', async () => {
  const projectRoot = path.resolve('file-tree-test-project');
  let streamedEntries = 0;
  const fileSystem = createFakeFileSystem({
    access: async () => undefined,
    // Endless on purpose: the walk has to stop consuming the stream itself
    // instead of waiting for the directory listing to be materialized.
    openDirectory: async function* (directoryPath) {
      if (directoryPath !== projectRoot) {
        return;
      }
      for (let index = 0; ; index += 1) {
        streamedEntries += 1;
        yield createDirectoryEntry(`file-${index}.txt`, false);
      }
    },
    lstat: async () => createStats(false, 0o644),
  });
  const service = createFileTreeService(createDependencies(fileSystem, projectRoot));

  await assert.rejects(
    service.listProjectFiles('project-1'),
    (error: unknown) => error instanceof AppError
      && error.code === 'FILE_TREE_TOO_LARGE'
      && error.statusCode === 413,
  );
  // The budget plus the single entry that proves it was exceeded.
  assert.equal(streamedEntries, 10_001);
});

test('listProjectFiles shares the entry limit across nested directories', async () => {
  const projectRoot = path.resolve('file-tree-test-project');
  const firstDirectory = path.join(projectRoot, 'first');
  const secondDirectory = path.join(projectRoot, 'second');
  const directoryPaths = new Set([firstDirectory, secondDirectory]);
  const fileSystem = createFakeFileSystem({
    access: async () => undefined,
    openDirectory: createDirectoryReader((directoryPath) => {
      if (directoryPath === projectRoot) {
        return [
          createDirectoryEntry('first', true),
          createDirectoryEntry('second', true),
        ];
      }
      if (directoryPaths.has(directoryPath)) {
        return Array.from(
          { length: 5_000 },
          (_, index) => createDirectoryEntry(`${path.basename(directoryPath)}-${index}.txt`, false),
        );
      }
      return [];
    }),
    lstat: async (candidatePath) => createStats(directoryPaths.has(candidatePath), 0o644),
  });
  const service = createFileTreeService(createDependencies(fileSystem, projectRoot));

  await assert.rejects(
    service.listProjectFiles('project-1'),
    (error: unknown) => error instanceof AppError
      && error.code === 'FILE_TREE_TOO_LARGE'
      && error.statusCode === 413,
  );
});

test('readTextFile rejects traversal before invoking the filesystem adapter', async () => {
  const projectRoot = path.resolve('file-tree-test-project');
  const readPaths: string[] = [];
  const fileSystem = createFakeFileSystem({
    readTextFile: async (filePath) => {
      readPaths.push(filePath);
      return 'should not be read';
    },
  });
  const service = createFileTreeService(createDependencies(fileSystem, projectRoot));

  await assert.rejects(
    service.readTextFile('project-1', '../secret.txt'),
    (error: unknown) => error instanceof AppError
      && error.code === 'PATH_OUTSIDE_PROJECT'
      && error.statusCode === 403,
  );
  assert.deepEqual(readPaths, []);
});

test('createEntry performs filesystem mutation only through the injected adapter', async () => {
  const projectRoot = path.resolve('file-tree-test-project');
  const targetPath = path.join(projectRoot, 'notes.txt');
  const writtenFiles: Array<{ filePath: string; content: string }> = [];
  const fileSystem = createFakeFileSystem({
    access: async (candidatePath) => {
      if (candidatePath === targetPath) {
        throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      }
    },
    writeTextFile: async (filePath, content) => {
      writtenFiles.push({ filePath, content });
    },
  });
  const service = createFileTreeService(createDependencies(fileSystem, projectRoot));

  const result = await service.createEntry({
    projectId: 'project-1',
    parentPath: projectRoot,
    type: 'file',
    name: 'notes.txt',
  });

  assert.equal(result.path, targetPath);
  assert.deepEqual(writtenFiles, [{ filePath: targetPath, content: '' }]);
});

/**
 * Builds a service whose only readable file is a fake audio track of
 * `trackBytes.length` bytes, and records every read-stream slice requested so
 * range handling can be asserted without touching the real filesystem.
 */
function createAudioTrackService(trackBytes: Buffer) {
  const projectRoot = path.resolve('file-tree-audio-project');
  const trackPath = path.join(projectRoot, 'track.flac');
  const readSlices: Array<{ start?: number; end?: number }> = [];
  const fileSystem = createFakeFileSystem({
    access: async () => undefined,
    stat: async () => ({
      ...createStats(false, 0o644),
      size: trackBytes.length,
    }),
    createReadStream: (filePath, options) => {
      assert.equal(filePath, trackPath);
      readSlices.push({ start: options?.start, end: options?.end });
      const start = options?.start ?? 0;
      const end = options?.end ?? trackBytes.length - 1;
      return Readable.from([trackBytes.subarray(start, end + 1)]);
    },
  });
  const services = createFileTreeService({
    ...createDependencies(fileSystem, projectRoot),
    resolveMimeType: () => 'audio/flac',
  });

  return { services, trackPath, readSlices };
}

test('openFile reports the full audio size and streams the whole file without a range header', async () => {
  const trackBytes = Buffer.from('0123456789');
  const { services, trackPath, readSlices } = createAudioTrackService(trackBytes);

  const file = await services.openFile('project-1', trackPath);

  assert.equal(file.contentType, 'audio/flac');
  assert.equal(file.size, trackBytes.length);
  assert.equal(file.contentRange, null);
  assert.deepEqual(readSlices, [{ start: undefined, end: undefined }]);
  const streamed = await streamToBuffer(file.stream);
  assert.equal(streamed.toString(), '0123456789');
});

test('openFile streams only the requested byte range so media players can seek', async () => {
  const trackBytes = Buffer.from('0123456789');
  const { services, trackPath, readSlices } = createAudioTrackService(trackBytes);

  const file = await services.openFile('project-1', trackPath, { rangeHeader: 'bytes=3-6' });

  assert.deepEqual(file.contentRange, { start: 3, end: 6 });
  assert.equal(file.size, trackBytes.length);
  assert.deepEqual(readSlices, [{ start: 3, end: 6 }]);
  const streamed = await streamToBuffer(file.stream);
  assert.equal(streamed.toString(), '3456');
});

test('openFile clamps an open-ended range to the last byte of the file', async () => {
  const { services, trackPath, readSlices } = createAudioTrackService(Buffer.from('0123456789'));

  const file = await services.openFile('project-1', trackPath, { rangeHeader: 'bytes=7-' });

  assert.deepEqual(file.contentRange, { start: 7, end: 9 });
  assert.deepEqual(readSlices, [{ start: 7, end: 9 }]);
});

test('openFile clamps a range end past the file size instead of over-reading', async () => {
  const { services, trackPath, readSlices } = createAudioTrackService(Buffer.from('0123456789'));

  const file = await services.openFile('project-1', trackPath, { rangeHeader: 'bytes=5-9999' });

  assert.deepEqual(file.contentRange, { start: 5, end: 9 });
  assert.deepEqual(readSlices, [{ start: 5, end: 9 }]);
});

test('openFile resolves a suffix range against the end of the file', async () => {
  const { services, trackPath } = createAudioTrackService(Buffer.from('0123456789'));

  const file = await services.openFile('project-1', trackPath, { rangeHeader: 'bytes=-4' });

  assert.deepEqual(file.contentRange, { start: 6, end: 9 });
});

test('openFile serves the whole file for a multi-range request it cannot satisfy piecewise', async () => {
  const { services, trackPath, readSlices } = createAudioTrackService(Buffer.from('0123456789'));

  const file = await services.openFile('project-1', trackPath, { rangeHeader: 'bytes=0-1,5-6' });

  assert.equal(file.contentRange, null);
  assert.deepEqual(readSlices, [{ start: undefined, end: undefined }]);
});

test('openFile rejects a range that starts past the end of the file with the real size', async () => {
  const { services, trackPath } = createAudioTrackService(Buffer.from('0123456789'));

  await assert.rejects(
    () => services.openFile('project-1', trackPath, { rangeHeader: 'bytes=10-20' }),
    (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.statusCode, 416);
      assert.equal(error.code, 'RANGE_NOT_SATISFIABLE');
      assert.deepEqual(error.details, { size: 10 });
      return true;
    },
  );
});

test('openFile rejects any range against an empty file', async () => {
  const { services, trackPath } = createAudioTrackService(Buffer.alloc(0));

  await assert.rejects(
    () => services.openFile('project-1', trackPath, { rangeHeader: 'bytes=0-' }),
    (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.statusCode, 416);
      assert.deepEqual(error.details, { size: 0 });
      return true;
    },
  );
});

test('resolveMimeType pins audio formats mime-types still reports with pre-standard subtypes', async () => {
  const { resolveMimeType } = await import('@/modules/file-tree/file-tree.module.js');

  // The browser preview refuses `audio/x-flac`, which is what `mime.lookup`
  // returns on its own.
  assert.equal(resolveMimeType('/tracks/Track.FLAC'), 'audio/flac');
  assert.equal(resolveMimeType('/tracks/track.opus'), 'audio/opus');
  // Formats without an override keep the library's answer.
  assert.equal(resolveMimeType('/tracks/track.mp3'), 'audio/mpeg');
  assert.equal(resolveMimeType('/tracks/track.wav'), 'audio/wav');
  assert.equal(resolveMimeType('/tracks/track.unknownext'), 'application/octet-stream');
});

/**
 * Builds a service for the player endpoint: the track lives outside any
 * project, so only workspace-root containment and the media MIME check stand
 * between the request and the bytes.
 */
function createMediaOnlyService(options: {
  trackBytes?: Buffer;
  mimeType?: string;
  validatePath?: FileTreeServiceDependencies['workspace']['validatePath'];
} = {}) {
  const trackBytes = options.trackBytes ?? Buffer.from('0123456789');
  const workspaceRoot = path.resolve('file-tree-workspace-root');
  const openedPaths: string[] = [];
  const fileSystem = createFakeFileSystem({
    access: async () => undefined,
    stat: async () => ({ ...createStats(false, 0o644), size: trackBytes.length }),
    createReadStream: (filePath, readOptions) => {
      openedPaths.push(filePath);
      const start = readOptions?.start ?? 0;
      const end = readOptions?.end ?? trackBytes.length - 1;
      return Readable.from([trackBytes.subarray(start, end + 1)]);
    },
  });
  const baseDependencies = createDependencies(fileSystem, workspaceRoot);
  const services = createFileTreeService({
    ...baseDependencies,
    workspace: {
      rootPath: workspaceRoot,
      validatePath: options.validatePath ?? baseDependencies.workspace.validatePath,
    },
    resolveMimeType: () => options.mimeType ?? 'audio/flac',
  });

  return { services, workspaceRoot, openedPaths, trackBytes };
}

test('openMediaFile streams a track that lives outside every project', async () => {
  const { services, openedPaths, trackBytes } = createMediaOnlyService();
  const outsideProject = path.resolve('file-tree-workspace-root', 'generated/tracks/song.flac');

  const file = await services.openMediaFile(outsideProject);

  assert.equal(file.contentType, 'audio/flac');
  assert.equal(file.size, trackBytes.length);
  assert.deepEqual(openedPaths, [outsideProject]);
  assert.equal((await streamToBuffer(file.stream)).toString(), '0123456789');
});

test('openMediaFile honours a byte range so the player can seek', async () => {
  const { services } = createMediaOnlyService();
  const track = path.resolve('file-tree-workspace-root', 'generated/song.flac');

  const file = await services.openMediaFile(track, { rangeHeader: 'bytes=2-5' });

  assert.deepEqual(file.contentRange, { start: 2, end: 5 });
  assert.equal((await streamToBuffer(file.stream)).toString(), '2345');
});

test('openMediaFile expands a workspace-relative "~" path', async () => {
  const { services, workspaceRoot, openedPaths } = createMediaOnlyService();

  await services.openMediaFile('~/generated/song.flac');

  assert.deepEqual(openedPaths, [path.join(workspaceRoot, 'generated/song.flac')]);
});

test('openMediaFile refuses a file that is not playable media', async () => {
  // The player must not become a general-purpose reader for source or config.
  for (const mimeType of ['text/plain', 'application/json', 'application/octet-stream', 'image/png', 'application/pdf']) {
    const { services, openedPaths } = createMediaOnlyService({ mimeType });

    await assert.rejects(
      () => services.openMediaFile(path.resolve('file-tree-workspace-root', 'secrets.env')),
      (error: unknown) => {
        assert.ok(error instanceof AppError);
        assert.equal(error.statusCode, 415);
        assert.equal(error.code, 'NOT_PLAYABLE_MEDIA');
        return true;
      },
      `${mimeType} must not be served by the player endpoint`,
    );
    assert.deepEqual(openedPaths, [], 'a rejected file must never be opened');
  }
});

test('openMediaFile refuses a path the workspace policy rejects', async () => {
  const { services, openedPaths } = createMediaOnlyService({
    validatePath: async () => ({ valid: false, error: 'Path is outside the workspace root' }),
  });

  await assert.rejects(
    () => services.openMediaFile('/etc/sounds/alert.flac'),
    (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.statusCode, 403);
      assert.equal(error.code, 'INVALID_WORKSPACE_PATH');
      return true;
    },
  );
  assert.deepEqual(openedPaths, []);
});

test('openMediaFile rejects an empty path before touching the filesystem', async () => {
  const { services, openedPaths } = createMediaOnlyService();

  await assert.rejects(
    () => services.openMediaFile('   '),
    (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.statusCode, 400);
      return true;
    },
  );
  assert.deepEqual(openedPaths, []);
});

/**
 * Builds a service over a fake media folder tree so library listing can be
 * asserted without touching the real filesystem.
 */
function createMediaLibraryService(tree: Record<string, Array<[string, boolean]>>, mimeByExtension: Record<string, string> = {}) {
  const workspaceRoot = path.resolve('media-library-root');
  const statted: string[] = [];
  const fileSystem = createFakeFileSystem({
    access: async () => undefined,
    // `stat` follows a symlink, `lstat` does not. The sizes differ on purpose so
    // a listing that reads the link instead of its target is caught.
    stat: async (candidatePath) => {
      statted.push(candidatePath);
      return tree[candidatePath]
        ? { ...createStats(true, 0o755), size: 0 }
        : { ...createStats(false, 0o644), size: 1234 };
    },
    lstat: async () => ({ ...createStats(false, 0o644), size: 73 }),
    openDirectory: createDirectoryReader((directoryPath) => {
      const entries = tree[directoryPath];
      if (!entries) {
        throw new Error(`Unreadable directory: ${directoryPath}`);
      }
      return entries.map(([name, isDirectory]) => createDirectoryEntry(name, isDirectory));
    }),
  });
  const base = createDependencies(fileSystem, workspaceRoot);
  const services = createFileTreeService({
    ...base,
    resolveMimeType: (filePath) => {
      const extension = filePath.split('.').pop()?.toLowerCase() ?? '';
      return mimeByExtension[extension] ?? 'application/octet-stream';
    },
  });

  return { services, workspaceRoot, statted };
}

const AUDIO_MIME = { flac: 'audio/flac', mp3: 'audio/mpeg', mp4: 'video/mp4' };

test('listMediaFiles reports only playable files and skips everything else', async () => {
  const root = path.resolve('media-library-root', 'tracks');
  const { services } = createMediaLibraryService({
    [root]: [
      ['song.flac', false],
      ['clip.mp4', false],
      ['notes.txt', false],
      ['library.db', false],
      ['cover.png', false],
    ],
  }, AUDIO_MIME);

  const result = await services.listMediaFiles(root);

  assert.deepEqual(
    result.files.map((file) => file.name).sort(),
    ['clip.mp4', 'song.flac'],
    'a media folder listing must not expose non-media files',
  );
  assert.equal(result.path, root);
  assert.equal(result.files[0].size, 1234);
});

test('listMediaFiles reports the size of what a symlink points at, not the link', async () => {
  // A media folder commonly holds symlinks into the tool's own output folder.
  // Reading the link itself would report a few dozen bytes for a whole track.
  const root = path.resolve('media-library-root', 'tracks');
  const { services } = createMediaLibraryService({
    [root]: [['linked.flac', false]],
  }, AUDIO_MIME);

  const result = await services.listMediaFiles(root);

  assert.equal(result.files[0].size, 1234);
});

test('listMediaFiles walks nested folders and labels each file by its relative path', async () => {
  const root = path.resolve('media-library-root', 'tracks');
  const nested = path.join(root, 'ambient');
  const { services } = createMediaLibraryService({
    [root]: [['ambient', true], ['top.flac', false]],
    [nested]: [['deep.flac', false]],
  }, AUDIO_MIME);

  const result = await services.listMediaFiles(root);

  assert.deepEqual(
    result.files.map((file) => file.relativePath).sort(),
    ['ambient/deep.flac', 'top.flac'],
  );
});

test('listMediaFiles keeps going when a subfolder cannot be read', async () => {
  const root = path.resolve('media-library-root', 'tracks');
  const { services } = createMediaLibraryService({
    // `locked` is absent from the tree, so reading it throws.
    [root]: [['locked', true], ['song.flac', false]],
  }, AUDIO_MIME);

  const result = await services.listMediaFiles(root);

  assert.deepEqual(result.files.map((file) => file.name), ['song.flac']);
});

test('listMediaFiles refuses a path the workspace policy rejects', async () => {
  const workspaceRoot = path.resolve('media-library-root');
  const fileSystem = createFakeFileSystem({});
  const base = createDependencies(fileSystem, workspaceRoot);
  const services = createFileTreeService({
    ...base,
    workspace: {
      rootPath: workspaceRoot,
      validatePath: async () => ({ valid: false, error: 'Path is outside the workspace root' }),
    },
  });

  await assert.rejects(
    () => services.listMediaFiles('/etc'),
    (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.statusCode, 403);
      return true;
    },
  );
});

test('listMediaFiles rejects a file that is not a directory', async () => {
  const root = path.resolve('media-library-root', 'tracks');
  const { services } = createMediaLibraryService({ [root]: [] }, AUDIO_MIME);
  const filePath = path.resolve('media-library-root', 'song.flac');

  await assert.rejects(
    () => services.listMediaFiles(filePath),
    (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.statusCode, 400);
      return true;
    },
  );
});

/** Builds a service whose filesystem records the mutations it is asked for. */
function createMediaMutationService(options: {
  mimeType?: string;
  existingPaths?: string[];
  renameError?: NodeJS.ErrnoException;
} = {}) {
  const workspaceRoot = path.resolve('media-library-root');
  const unlinked: string[] = [];
  const renamed: Array<[string, string]> = [];
  const existing = new Set(options.existingPaths ?? []);
  const fileSystem = createFakeFileSystem({
    access: async (candidatePath) => {
      if (!existing.has(candidatePath)) {
        throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      }
    },
    stat: async (candidatePath) => ({
      ...createStats(candidatePath.endsWith('tracks'), 0o755),
      size: 0,
    }),
    unlink: async (candidatePath) => {
      unlinked.push(candidatePath);
    },
    rename: async (from, to) => {
      if (options.renameError) {
        throw options.renameError;
      }
      renamed.push([from, to]);
    },
  });
  const base = createDependencies(fileSystem, workspaceRoot);
  const services = createFileTreeService({
    ...base,
    resolveMimeType: () => options.mimeType ?? 'audio/flac',
  });

  return { services, workspaceRoot, unlinked, renamed };
}

test('deleteMediaFile removes the file it was pointed at', async () => {
  const { services, unlinked } = createMediaMutationService();
  const track = path.resolve('media-library-root', 'tracks/song.flac');

  const result = await services.deleteMediaFile(track);

  assert.equal(result.success, true);
  assert.deepEqual(unlinked, [track]);
});

test('deleteMediaFile refuses anything that is not playable media', async () => {
  // The panel must never become a way to delete source or config files.
  const { services, unlinked } = createMediaMutationService({ mimeType: 'text/plain' });

  await assert.rejects(
    () => services.deleteMediaFile(path.resolve('media-library-root', '.env')),
    (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.statusCode, 415);
      return true;
    },
  );
  assert.deepEqual(unlinked, [], 'a rejected file must never be unlinked');
});

test('moveMediaFile moves the file into the target folder keeping its name', async () => {
  const { services, renamed } = createMediaMutationService();
  const track = path.resolve('media-library-root', 'tracks/song.flac');
  const target = path.resolve('media-library-root', 'archive-tracks');

  const result = await services.moveMediaFile(track, target);

  assert.deepEqual(renamed, [[track, path.join(target, 'song.flac')]]);
  assert.equal(result.path, path.join(target, 'song.flac'));
});

test('moveMediaFile refuses to overwrite a file already in the target', async () => {
  const target = path.resolve('media-library-root', 'archive-tracks');
  const { services, renamed } = createMediaMutationService({
    existingPaths: [path.join(target, 'song.flac')],
  });

  await assert.rejects(
    () => services.moveMediaFile(path.resolve('media-library-root', 'tracks/song.flac'), target),
    (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.statusCode, 409);
      return true;
    },
  );
  assert.deepEqual(renamed, [], 'the take being replaced must survive');
});

test('moveMediaFile refuses a non-media file and a target outside the workspace', async () => {
  const { services: textService } = createMediaMutationService({ mimeType: 'text/plain' });
  await assert.rejects(
    () => textService.moveMediaFile('/Users/me/notes.txt', '/Users/me/tracks'),
    (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.statusCode, 415);
      return true;
    },
  );

  const fileSystem = createFakeFileSystem({});
  const base = createDependencies(fileSystem, path.resolve('media-library-root'));
  const guarded = createFileTreeService({
    ...base,
    resolveMimeType: () => 'audio/flac',
    workspace: {
      rootPath: path.resolve('media-library-root'),
      validatePath: async () => ({ valid: false, error: 'Path is outside the workspace root' }),
    },
  });

  await assert.rejects(
    () => guarded.moveMediaFile('/Users/me/song.flac', '/etc'),
    (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.statusCode, 403);
      return true;
    },
  );
});
