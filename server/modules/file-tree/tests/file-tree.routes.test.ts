import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { Readable } from 'node:stream';
import test from 'node:test';

import express, { type RequestHandler } from 'express';

import { createFileTreeRouter } from '@/modules/file-tree/file-tree.routes.js';
import type { FileTreeServices } from '@/shared/types.js';
import { AppError } from '@/shared/utils.js';

function createFakeServices(overrides: Partial<FileTreeServices> = {}): FileTreeServices {
  const unexpectedOperation = async (): Promise<never> => {
    throw new Error('Unexpected File Tree service call');
  };

  return {
    browseWorkspace: unexpectedOperation,
    createWorkspaceFolder: unexpectedOperation,
    readTextFile: unexpectedOperation,
    openFile: unexpectedOperation,
    openMediaFile: unexpectedOperation,
    listMediaFiles: unexpectedOperation,
    deleteMediaFile: unexpectedOperation,
    moveMediaFile: unexpectedOperation,
    transcodeMediaFile: unexpectedOperation,
    mediaCapabilities: unexpectedOperation,
    saveTextFile: unexpectedOperation,
    listProjectFiles: unexpectedOperation,
    createEntry: unexpectedOperation,
    renameEntry: unexpectedOperation,
    deleteEntry: unexpectedOperation,
    storeUploadedFiles: unexpectedOperation,
    ...overrides,
  };
}

const passUploadRequest: RequestHandler = (_request, _response, next) => next();

async function withFileTreeServer(
  services: FileTreeServices,
  run: (baseUrl: string) => Promise<void>,
): Promise<void> {
  const app = express();
  app.use(express.json());
  app.use('/api/file-tree', createFileTreeRouter(
    services,
    passUploadRequest,
    { maximumFileSizeMegabytes: 200, maximumFileCount: 20 },
    { error: () => undefined },
  ));

  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');

  try {
    const address = server.address() as AddressInfo;
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }
}

test('project files route uses the File Tree API namespace and forwards the project id', async () => {
  const inputs: Parameters<FileTreeServices['listProjectFiles']>[] = [];
  const services = createFakeServices({
    listProjectFiles: async (...input) => {
      inputs.push(input);
      return [];
    },
  });

  await withFileTreeServer(services, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/file-tree/projects/project-1/files`);

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), []);
  });

  assert.deepEqual(inputs, [['project-1', { respectGitignore: false }]]);
});

test('project files route requests gitignore filtering when explicitly enabled', async () => {
  const inputs: Parameters<FileTreeServices['listProjectFiles']>[] = [];
  const services = createFakeServices({
    listProjectFiles: async (...input) => {
      inputs.push(input);
      return [];
    },
  });

  await withFileTreeServer(services, async (baseUrl) => {
    const response = await fetch(
      `${baseUrl}/api/file-tree/projects/project-1/files?respectGitignore=true`,
    );

    assert.equal(response.status, 200);
  });

  assert.deepEqual(inputs, [['project-1', { respectGitignore: true }]]);
});

test('create route parses the transport payload before invoking the service', async () => {
  const inputs: Parameters<FileTreeServices['createEntry']>[0][] = [];
  const services = createFakeServices({
    createEntry: async (input) => {
      inputs.push(input);
      return {
        success: true,
        path: '/workspace/project/src/example.ts',
        name: input.name,
        type: input.type,
        message: 'File created successfully',
      };
    },
  });

  await withFileTreeServer(services, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/file-tree/projects/project-1/files/create`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        path: '/workspace/project/src',
        type: 'file',
        name: 'example.ts',
      }),
    });

    assert.equal(response.status, 200);
  });

  assert.deepEqual(inputs, [{
    projectId: 'project-1',
    parentPath: '/workspace/project/src',
    type: 'file',
    name: 'example.ts',
  }]);
});

test('create route rejects invalid entry types without calling the service', async () => {
  let createCalled = false;
  const services = createFakeServices({
    createEntry: async () => {
      createCalled = true;
      throw new Error('createEntry should not run for invalid input');
    },
  });

  await withFileTreeServer(services, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/file-tree/projects/project-1/files/create`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'link', name: 'example' }),
    });
    const payload = await response.json() as { error: string };

    assert.equal(response.status, 400);
    assert.equal(payload.error, 'Type must be "file" or "directory"');
  });

  assert.equal(createCalled, false);
});

test('content route advertises range support and the full length for an unranged read', async () => {
  const trackBytes = Buffer.from('0123456789');
  const receivedRangeHeaders: Array<string | null | undefined> = [];
  const services = createFakeServices({
    openFile: async (_projectId, _filePath, options) => {
      receivedRangeHeaders.push(options?.rangeHeader);
      return {
        contentType: 'audio/flac',
        stream: Readable.from([trackBytes]),
        size: trackBytes.length,
        modifiedAt: null,
        contentRange: null,
      };
    },
  });

  await withFileTreeServer(services, async (baseUrl) => {
    const response = await fetch(
      `${baseUrl}/api/file-tree/projects/project-1/files/content?path=/tracks/track.flac`,
    );

    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'audio/flac');
    assert.equal(response.headers.get('accept-ranges'), 'bytes');
    assert.equal(response.headers.get('content-length'), '10');
    assert.equal(response.headers.get('content-range'), null);
    assert.equal(await response.text(), '0123456789');
  });

  assert.deepEqual(receivedRangeHeaders, [null]);
});

test('content route forwards the Range header and answers a partial read with 206', async () => {
  const receivedRangeHeaders: Array<string | null | undefined> = [];
  const services = createFakeServices({
    openFile: async (_projectId, _filePath, options) => {
      receivedRangeHeaders.push(options?.rangeHeader);
      return {
        contentType: 'audio/flac',
        stream: Readable.from([Buffer.from('3456')]),
        size: 10,
        modifiedAt: null,
        contentRange: { start: 3, end: 6 },
      };
    },
  });

  await withFileTreeServer(services, async (baseUrl) => {
    const response = await fetch(
      `${baseUrl}/api/file-tree/projects/project-1/files/content?path=/tracks/track.flac`,
      { headers: { Range: 'bytes=3-6' } },
    );

    assert.equal(response.status, 206);
    assert.equal(response.headers.get('accept-ranges'), 'bytes');
    assert.equal(response.headers.get('content-range'), 'bytes 3-6/10');
    assert.equal(response.headers.get('content-length'), '4');
    assert.equal(await response.text(), '3456');
  });

  assert.deepEqual(receivedRangeHeaders, ['bytes=3-6']);
});

test('content route answers an unsatisfiable range with 416 and the resource length', async () => {
  const services = createFakeServices({
    openFile: async () => {
      throw new AppError('Requested range not satisfiable', {
        statusCode: 416,
        code: 'RANGE_NOT_SATISFIABLE',
        details: { size: 10 },
      });
    },
  });

  await withFileTreeServer(services, async (baseUrl) => {
    const response = await fetch(
      `${baseUrl}/api/file-tree/projects/project-1/files/content?path=/tracks/track.flac`,
      { headers: { Range: 'bytes=99-' } },
    );

    assert.equal(response.status, 416);
    assert.equal(response.headers.get('content-range'), 'bytes */10');
  });
});

test('media route streams a player file by absolute path with no project id', async () => {
  const requestedPaths: string[] = [];
  const services = createFakeServices({
    openMediaFile: async (filePath, options) => {
      requestedPaths.push(filePath);
      assert.equal(options?.rangeHeader, null);
      return {
        contentType: 'audio/flac',
        stream: Readable.from([Buffer.from('0123456789')]),
        size: 10,
        modifiedAt: null,
        contentRange: null,
      };
    },
  });

  await withFileTreeServer(services, async (baseUrl) => {
    const response = await fetch(
      `${baseUrl}/api/file-tree/media/content?path=${encodeURIComponent('/Users/me/generated/song.flac')}`,
    );

    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'audio/flac');
    assert.equal(response.headers.get('accept-ranges'), 'bytes');
    assert.equal(response.headers.get('content-length'), '10');
    assert.equal(await response.text(), '0123456789');
  });

  assert.deepEqual(requestedPaths, ['/Users/me/generated/song.flac']);
});

test('media route answers a seek with 206 and forwards the Range header', async () => {
  const services = createFakeServices({
    openMediaFile: async (_filePath, options) => {
      assert.equal(options?.rangeHeader, 'bytes=4-7');
      return {
        contentType: 'audio/flac',
        stream: Readable.from([Buffer.from('4567')]),
        size: 10,
        modifiedAt: null,
        contentRange: { start: 4, end: 7 },
      };
    },
  });

  await withFileTreeServer(services, async (baseUrl) => {
    const response = await fetch(
      `${baseUrl}/api/file-tree/media/content?path=${encodeURIComponent('/Users/me/generated/song.flac')}`,
      { headers: { Range: 'bytes=4-7' } },
    );

    assert.equal(response.status, 206);
    assert.equal(response.headers.get('content-range'), 'bytes 4-7/10');
    assert.equal(await response.text(), '4567');
  });
});

test('media route requires a path', async () => {
  const services = createFakeServices();

  await withFileTreeServer(services, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/file-tree/media/content`);
    assert.equal(response.status, 400);
  });
});

test('media list route returns the folder contents for the configured path', async () => {
  const requested: string[] = [];
  const services = createFakeServices({
    listMediaFiles: async (folderPath) => {
      requested.push(folderPath);
      return {
        path: folderPath,
        files: [{
          name: 'song.flac',
          path: `${folderPath}/song.flac`,
          relativePath: 'song.flac',
          size: 4300000,
          modifiedAt: '2026-10-03T10:00:00.000Z',
          contentType: 'audio/flac',
        }],
      };
    },
  });

  await withFileTreeServer(services, async (baseUrl) => {
    const response = await fetch(
      `${baseUrl}/api/file-tree/media/list?path=${encodeURIComponent('/Users/me/tracks')}`,
    );

    assert.equal(response.status, 200);
    const body = await response.json() as { files: Array<{ name: string; size: number }> };
    assert.equal(body.files.length, 1);
    assert.equal(body.files[0].name, 'song.flac');
    assert.equal(body.files[0].size, 4300000);
  });

  assert.deepEqual(requested, ['/Users/me/tracks']);
});

test('media list route requires a path', async () => {
  await withFileTreeServer(createFakeServices(), async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/file-tree/media/list`);
    assert.equal(response.status, 400);
  });
});

test('a HEAD on the media route answers from the headers without reading the file', async () => {
  // No data listener: attaching one would put the stream in flowing mode and
  // read it here, which is exactly what this test is checking the route avoids.
  const stream = Readable.from([Buffer.from('0123456789')]);

  const services = createFakeServices({
    openMediaFile: async () => ({
      contentType: 'audio/flac',
      stream,
      size: 10,
      modifiedAt: new Date('2026-10-03T10:00:00.000Z'),
      contentRange: null,
    }),
  });

  await withFileTreeServer(services, async (baseUrl) => {
    const response = await fetch(
      `${baseUrl}/api/file-tree/media/content?path=${encodeURIComponent('/Users/me/song.flac')}`,
      { method: 'HEAD' },
    );

    assert.equal(response.status, 200);
    // The player reads size and date from these two headers alone.
    assert.equal(response.headers.get('content-length'), '10');
    assert.equal(response.headers.get('last-modified'), 'Sat, 03 Oct 2026 10:00:00 GMT');
    assert.equal(await response.text(), '');
  });

  assert.equal(stream.destroyed, true, 'a metadata request must not read the file off disk');
  assert.equal(stream.readableEnded, false, 'the bytes must never have been consumed');
});

test('media delete route forwards the path to the service', async () => {
  const deleted: string[] = [];
  const services = createFakeServices({
    deleteMediaFile: async (filePath) => {
      deleted.push(filePath);
      return { success: true as const, path: filePath };
    },
  });

  await withFileTreeServer(services, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/file-tree/media/file`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: '/Users/me/tracks/song.flac' }),
    });

    assert.equal(response.status, 200);
  });

  assert.deepEqual(deleted, ['/Users/me/tracks/song.flac']);
});

test('media move route forwards both the file and the target folder', async () => {
  const moves: Array<[string, string | null, string | null | undefined]> = [];
  const services = createFakeServices({
    moveMediaFile: async (filePath, targetFolder, newName) => {
      moves.push([filePath, targetFolder, newName]);
      return { success: true as const, path: `${targetFolder}/song.flac` };
    },
  });

  await withFileTreeServer(services, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/file-tree/media/move`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: '/Users/me/tracks/song.flac', targetFolder: '/Users/me/keep' }),
    });

    assert.equal(response.status, 200);
  });

  assert.deepEqual(moves, [['/Users/me/tracks/song.flac', '/Users/me/keep', null]]);
});

test('media move route accepts a rename with no folder at all', async () => {
  // Renaming in place goes through the same endpoint, so a request without a
  // target folder has to reach the service rather than being refused here.
  const moves: Array<[string, string | null, string | null | undefined]> = [];
  const services = createFakeServices({
    moveMediaFile: async (filePath, targetFolder, newName) => {
      moves.push([filePath, targetFolder, newName]);
      return { success: true as const, path: '/Users/me/tracks/better.flac' };
    },
  });

  await withFileTreeServer(services, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/file-tree/media/move`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: '/Users/me/tracks/song.flac', name: 'better.flac' }),
    });

    assert.equal(response.status, 200);
  });

  assert.deepEqual(moves, [['/Users/me/tracks/song.flac', null, 'better.flac']]);
});

test('media transcode route forwards the format and where the result goes', async () => {
  const requests: unknown[] = [];
  const services = createFakeServices({
    transcodeMediaFile: async (filePath, format, options) => {
      requests.push([filePath, format, options]);
      return { success: true as const, path: '/Users/me/Music/song.mp4' };
    },
  });

  await withFileTreeServer(services, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/file-tree/media/transcode`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        path: '/Users/me/tracks/song.flac',
        format: 'mp4',
        targetFolder: '/Users/me/Music',
        name: 'song.mp4',
      }),
    });

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      success: true,
      path: '/Users/me/Music/song.mp4',
    });

    // Left out entirely, the destination falls back to beside the original.
    await fetch(`${baseUrl}/api/file-tree/media/transcode`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: '/Users/me/tracks/song.flac', format: 'mp3' }),
    });
  });

  assert.deepEqual(requests, [
    ['/Users/me/tracks/song.flac', 'mp4', { targetFolder: '/Users/me/Music', name: 'song.mp4' }],
    ['/Users/me/tracks/song.flac', 'mp3', { targetFolder: null, name: null }],
  ]);
});

test('media capabilities route reports what conversion can do here', async () => {
  const services = createFakeServices({
    mediaCapabilities: async () => ({ transcode: false, formats: [] }),
  });

  await withFileTreeServer(services, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/file-tree/media/capabilities`);

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { transcode: false, formats: [] });
  });
});

test('media mutation routes refuse an incomplete request without calling the service', async () => {
  const services = createFakeServices();

  await withFileTreeServer(services, async (baseUrl) => {
    const noPath = await fetch(`${baseUrl}/api/file-tree/media/file`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.equal(noPath.status, 400);

    const noTarget = await fetch(`${baseUrl}/api/file-tree/media/move`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: '/Users/me/tracks/song.flac' }),
    });
    assert.equal(noTarget.status, 400);

    const noFormat = await fetch(`${baseUrl}/api/file-tree/media/transcode`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: '/Users/me/tracks/song.flac' }),
    });
    assert.equal(noFormat.status, 400);
  });
});
