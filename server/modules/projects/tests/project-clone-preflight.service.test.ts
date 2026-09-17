import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

import { inspectCloneTarget } from '@/modules/projects/services/project-clone-preflight.service.js';
import { AppError } from '@/shared/utils.js';

type PreflightDependencies = Parameters<typeof inspectCloneTarget>[1];

function buildDependencies(
  overrides: Partial<NonNullable<PreflightDependencies>> = {},
): NonNullable<PreflightDependencies> {
  return {
    validatePath: async (requestedPath: string) => ({ valid: true, resolvedPath: requestedPath }),
    readDirectory: async () => [],
    isDirectory: async () => true,
    getRegisteredProjectName: () => null,
    ...overrides,
  };
}

test('inspectCloneTarget requires a workspace path', async () => {
  await assert.rejects(
    async () => inspectCloneTarget({ workspacePath: '  ' }, buildDependencies()),
    (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.code, 'WORKSPACE_PATH_REQUIRED');
      return true;
    },
  );
});

test('inspectCloneTarget asks for no confirmation when the folder is empty', async () => {
  const result = await inspectCloneTarget(
    { workspacePath: '/workspace/Liberty-Life', githubUrl: 'https://github.com/kuri/Liberty-Life.git' },
    buildDependencies(),
  );

  assert.equal(result.repositoryName, 'Liberty-Life');
  assert.equal(result.direct.path, '/workspace/Liberty-Life');
  assert.equal(result.direct.isEmpty, true);
  assert.equal(result.requiresConfirmation, false);
  assert.equal(result.recommendedTarget, 'direct');
});

test('inspectCloneTarget asks for confirmation when the folder already holds source', async () => {
  const result = await inspectCloneTarget(
    { workspacePath: '/workspace/Liberty-Life', githubUrl: 'https://github.com/kuri/Liberty-Life.git' },
    buildDependencies({
      readDirectory: async (targetPath: string) =>
        targetPath === '/workspace/Liberty-Life' ? ['main.py', 'core', '.git'] : null,
      isDirectory: async (targetPath: string) => targetPath === '/workspace/Liberty-Life',
    }),
  );

  assert.equal(result.requiresConfirmation, true);
  assert.equal(result.direct.entryCount, 3);
  assert.deepEqual(result.direct.sampleEntries, ['main.py', 'core', '.git']);
  assert.equal(result.direct.hasGitRepository, true);
  // 하위 폴더가 비어 있으니 그쪽을 기본으로 권한다.
  assert.equal(result.recommendedTarget, 'subdirectory');
  assert.equal(result.subdirectory?.path, path.join('/workspace/Liberty-Life', 'Liberty-Life'));
  assert.equal(result.subdirectory?.exists, false);
});

test('inspectCloneTarget stops recommending the subdirectory when it is taken', async () => {
  const result = await inspectCloneTarget(
    { workspacePath: '/workspace/Liberty-Life', githubUrl: 'https://github.com/kuri/Liberty-Life.git' },
    buildDependencies({
      readDirectory: async () => ['Liberty-Life'],
    }),
  );

  assert.equal(result.requiresConfirmation, true);
  assert.equal(result.subdirectory?.exists, true);
  assert.equal(result.recommendedTarget, 'direct');
});

test('inspectCloneTarget reports no subdirectory when no repository was given', async () => {
  const result = await inspectCloneTarget(
    { workspacePath: '/workspace/Liberty-Life' },
    buildDependencies({ readDirectory: async () => ['main.py'] }),
  );

  assert.equal(result.repositoryName, '');
  assert.equal(result.subdirectory, null);
  // clone 하지 않는 흐름이라 확인을 물을 이유가 없다.
  assert.equal(result.requiresConfirmation, false);
});

test('inspectCloneTarget surfaces a folder that is already a registered project', async () => {
  const result = await inspectCloneTarget(
    { workspacePath: '/workspace/Liberty-Life', githubUrl: 'https://github.com/kuri/Liberty-Life.git' },
    buildDependencies({
      readDirectory: async (targetPath: string) =>
        targetPath === '/workspace/Liberty-Life' ? ['main.py'] : null,
      getRegisteredProjectName: (targetPath: string) =>
        targetPath === '/workspace/Liberty-Life' ? 'Liberty-Life' : null,
    }),
  );

  assert.equal(result.direct.registeredProjectName, 'Liberty-Life');
});
