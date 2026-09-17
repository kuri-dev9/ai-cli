import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';

import { projectsDb } from '@/modules/database/index.js';
import { resolveRepositoryName } from '@/modules/projects/services/project-clone.service.js';
import type { WorkspacePathValidationResult } from '@/shared/types.js';
import { AppError, normalizeProjectPath, validateWorkspacePath } from '@/shared/utils.js';

/** preflight 결과 한 폴더분. `directPath` 와 `subdirectoryPath` 각각에 대해 채운다. */
export type CloneTargetInspection = {
  path: string;
  exists: boolean;
  isDirectory: boolean;
  isEmpty: boolean;
  entryCount: number;
  /** 사용자에게 "무엇이 들어있는지" 보여주기 위한 앞쪽 몇 개. */
  sampleEntries: string[];
  /** `.git` 이 있으면 이미 clone 된 작업 폴더일 가능성이 높다. */
  hasGitRepository: boolean;
  /** 이 경로가 이미 프로젝트로 등록되어 있으면 그 표시 이름. */
  registeredProjectName: string | null;
};

export type CloneTargetPreflightResult = {
  repositoryName: string;
  direct: CloneTargetInspection;
  /** githubUrl 이 없으면 하위 폴더 개념이 없으므로 null. */
  subdirectory: CloneTargetInspection | null;
  /** 지정한 폴더가 비어 있지 않아 사용자 확인이 필요한 상태. */
  requiresConfirmation: boolean;
  /** 위 상태에서 UI 가 미리 골라둘 기본 선택지. */
  recommendedTarget: 'direct' | 'subdirectory';
};

type PreflightDependencies = {
  validatePath: (requestedPath: string) => Promise<WorkspacePathValidationResult>;
  readDirectory: (targetPath: string) => Promise<string[] | null>;
  isDirectory: (targetPath: string) => Promise<boolean>;
  getRegisteredProjectName: (targetPath: string) => string | null;
};

const SAMPLE_ENTRY_LIMIT = 8;

async function defaultReadDirectory(targetPath: string): Promise<string[] | null> {
  try {
    return await readdir(targetPath);
  } catch (error) {
    const fileError = error as NodeJS.ErrnoException;
    if (fileError.code === 'ENOENT' || fileError.code === 'ENOTDIR') {
      return null;
    }

    throw error;
  }
}

async function defaultIsDirectory(targetPath: string): Promise<boolean> {
  try {
    const stats = await stat(targetPath);
    return stats.isDirectory();
  } catch (error) {
    const fileError = error as NodeJS.ErrnoException;
    if (fileError.code === 'ENOENT') {
      return false;
    }

    throw error;
  }
}

const defaultDependencies: PreflightDependencies = {
  validatePath: validateWorkspacePath,
  readDirectory: defaultReadDirectory,
  isDirectory: defaultIsDirectory,
  getRegisteredProjectName: (targetPath: string): string | null => {
    const projectRow = projectsDb.getProjectPath(normalizeProjectPath(targetPath));
    if (!projectRow) {
      return null;
    }

    return projectRow.custom_project_name || path.basename(projectRow.project_path);
  },
};

async function inspectTarget(
  targetPath: string,
  dependencies: PreflightDependencies,
): Promise<CloneTargetInspection> {
  const entries = await dependencies.readDirectory(targetPath);

  if (entries === null) {
    // 폴더가 없을 수도 있고, 같은 이름의 파일일 수도 있다.
    const existsAsSomething = await dependencies.isDirectory(targetPath);
    return {
      path: targetPath,
      exists: existsAsSomething,
      isDirectory: existsAsSomething,
      isEmpty: true,
      entryCount: 0,
      sampleEntries: [],
      hasGitRepository: false,
      registeredProjectName: dependencies.getRegisteredProjectName(targetPath),
    };
  }

  return {
    path: targetPath,
    exists: true,
    isDirectory: true,
    isEmpty: entries.length === 0,
    entryCount: entries.length,
    sampleEntries: entries.slice(0, SAMPLE_ENTRY_LIMIT),
    hasGitRepository: entries.includes('.git'),
    registeredProjectName: dependencies.getRegisteredProjectName(targetPath),
  };
}

/**
 * clone 을 시작하기 전에 대상 폴더의 상태를 조사한다.
 *
 * 기존 소스가 들어 있는 폴더에 그대로 clone 하면 git 이 실패하거나, 예전처럼
 * 하위 폴더를 하나 더 만들어 버린다. 클라이언트는 이 결과를 보고 "그냥 등록",
 * "하위 폴더에 clone", "취소" 중 하나를 사용자에게 고르게 한다.
 */
export async function inspectCloneTarget(
  input: { workspacePath: string; githubUrl?: string | null },
  dependencies: PreflightDependencies = defaultDependencies,
): Promise<CloneTargetPreflightResult> {
  const normalizedWorkspacePath = input.workspacePath.trim();
  if (!normalizedWorkspacePath) {
    throw new AppError('workspacePath is required', {
      code: 'WORKSPACE_PATH_REQUIRED',
      statusCode: 400,
    });
  }

  const pathValidation = await dependencies.validatePath(normalizedWorkspacePath);
  if (!pathValidation.valid || !pathValidation.resolvedPath) {
    throw new AppError(pathValidation.error || 'Invalid workspace path', {
      code: 'INVALID_PROJECT_PATH',
      statusCode: 400,
    });
  }

  const absolutePath = pathValidation.resolvedPath;
  const trimmedGithubUrl = (input.githubUrl || '').trim();
  const repositoryName = trimmedGithubUrl ? resolveRepositoryName(trimmedGithubUrl) : '';

  const direct = await inspectTarget(absolutePath, dependencies);
  const subdirectory = repositoryName
    ? await inspectTarget(path.join(absolutePath, repositoryName), dependencies)
    : null;

  const requiresConfirmation = Boolean(trimmedGithubUrl) && direct.exists && !direct.isEmpty;
  const recommendedTarget =
    requiresConfirmation && subdirectory && !subdirectory.exists ? 'subdirectory' : 'direct';

  return {
    repositoryName,
    direct,
    subdirectory,
    requiresConfirmation,
    recommendedTarget,
  };
}
