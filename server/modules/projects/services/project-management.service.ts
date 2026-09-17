import fs from 'node:fs/promises';
import path from 'node:path';

import { projectsDb } from '@/modules/database/index.js';
import type {
  CreateProjectPathResult,
  ProjectRepositoryRow,
  WorkspacePathValidationResult,
} from '@/shared/types.js';
import { AppError, normalizeProjectPath, validateWorkspacePath } from '@/shared/utils.js';

type CreateProjectInput = {
  projectPath: string;
  customName?: string | null;
};

type CreateProjectDependencies = {
  validatePath: (projectPath: string) => Promise<WorkspacePathValidationResult>;
  ensureWorkspaceDirectory: (projectPath: string) => Promise<void>;
  persistProjectPath: (projectPath: string, customName: string | null) => CreateProjectPathResult;
  getProjectByPath: (projectPath: string) => ProjectRepositoryRow | null;
};

type ProjectApiView = {
  projectId: string;
  path: string;
  fullPath: string;
  displayName: string;
  customName: string | null;
  isArchived: boolean;
  isStarred: boolean;
  sessions: [];
  sessionMeta: {
    hasMore: false;
    total: 0;
  };
};

type CreateProjectServiceResult = {
  outcome: 'created' | 'reactivated_archived';
  project: ProjectApiView;
};

const defaultDependencies: CreateProjectDependencies = {
  validatePath: validateWorkspacePath,
  ensureWorkspaceDirectory: async (projectPath: string): Promise<void> => {
    await fs.mkdir(projectPath, { recursive: true });
    const directoryStats = await fs.stat(projectPath);
    if (!directoryStats.isDirectory()) {
      throw new AppError('Path exists but is not a directory', {
        code: 'PROJECT_PATH_NOT_DIRECTORY',
        statusCode: 400,
      });
    }
  },
  persistProjectPath: (projectPath: string, customName: string | null): CreateProjectPathResult =>
    projectsDb.createProjectPath(projectPath, customName),
  getProjectByPath: (projectPath: string): ProjectRepositoryRow | null =>
    projectsDb.getProjectPath(projectPath),
};

function resolveDisplayName(customName: string | null | undefined, projectPath: string): string {
  const trimmedCustomName = typeof customName === 'string' ? customName.trim() : '';
  if (trimmedCustomName.length > 0) {
    return trimmedCustomName;
  }

  return path.basename(projectPath) || projectPath;
}

function mapProjectRowToApiView(projectRow: ProjectRepositoryRow): ProjectApiView {
  return {
    projectId: projectRow.project_id,
    path: projectRow.project_path,
    fullPath: projectRow.project_path,
    displayName: resolveDisplayName(projectRow.custom_project_name, projectRow.project_path),
    customName: projectRow.custom_project_name,
    isArchived: Boolean(projectRow.isArchived),
    isStarred: Boolean(projectRow.isStarred),
    sessions: [],
    sessionMeta: {
      hasMore: false,
      total: 0,
    },
  };
}

export async function createProject(
  input: CreateProjectInput,
  dependencies: CreateProjectDependencies = defaultDependencies,
): Promise<CreateProjectServiceResult> {
  const normalizedPath = normalizeProjectPath(input.projectPath || '');
  if (!normalizedPath) {
    throw new AppError('path is required', {
      code: 'PROJECT_PATH_REQUIRED',
      statusCode: 400,
    });
  }

  const pathValidation = await dependencies.validatePath(normalizedPath);
  if (!pathValidation.valid || !pathValidation.resolvedPath) {
    throw new AppError('Invalid project path', {
      code: 'INVALID_PROJECT_PATH',
      statusCode: 400,
      details: pathValidation.error ?? 'Path validation failed',
    });
  }

  const resolvedProjectPath = normalizeProjectPath(pathValidation.resolvedPath);
  await dependencies.ensureWorkspaceDirectory(resolvedProjectPath);

  const normalizedCustomName = resolveDisplayName(input.customName ?? null, resolvedProjectPath);
  const persistedProject = dependencies.persistProjectPath(resolvedProjectPath, normalizedCustomName);

  if (persistedProject.outcome === 'active_conflict') {
    throw new AppError('Project path already exists and is active', {
      code: 'PROJECT_ALREADY_EXISTS',
      statusCode: 409,
      details: `Project path already exists: ${resolvedProjectPath}`,
    });
  }

  const projectRow = persistedProject.project ?? dependencies.getProjectByPath(resolvedProjectPath);
  if (!projectRow) {
    throw new AppError('Failed to resolve project after creation', {
      code: 'PROJECT_CREATE_FAILED',
      statusCode: 500,
    });
  }

  // Archived rows intentionally remain archived when reused, as requested.
  return {
    outcome: persistedProject.outcome,
    project: mapProjectRowToApiView(projectRow),
  };
}

/**
 * Sets `projects.custom_project_name` for the given `projectId` (or clears it when empty).
 */
export function updateProjectDisplayName(projectId: string, newDisplayName: unknown): void {
  const trimmed = typeof newDisplayName === 'string' ? newDisplayName.trim() : '';
  projectsDb.updateCustomProjectNameById(projectId, trimmed.length > 0 ? trimmed : null);
}

type UpdateProjectPathInput = {
  projectId: string;
  newPath: string;
  /**
   * 표시 이름이 예전 폴더 이름 그대로였다면 새 폴더 이름으로 같이 바꾼다.
   * 사용자가 직접 지은 이름은 건드리지 않는다.
   */
  syncDisplayName?: boolean;
};

type UpdateProjectPathDependencies = {
  validatePath: (projectPath: string) => Promise<WorkspacePathValidationResult>;
  assertDirectoryExists: (projectPath: string) => Promise<void>;
  getProjectById: (projectId: string) => ProjectRepositoryRow | null;
  getProjectByPath: (projectPath: string) => ProjectRepositoryRow | null;
  persistProjectPath: (projectId: string, projectPath: string) => void;
  persistDisplayName: (projectId: string, displayName: string | null) => void;
};

const defaultUpdatePathDependencies: UpdateProjectPathDependencies = {
  validatePath: validateWorkspacePath,
  assertDirectoryExists: async (projectPath: string): Promise<void> => {
    let directoryStats: Awaited<ReturnType<typeof fs.stat>>;
    try {
      directoryStats = await fs.stat(projectPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new AppError('The new project path does not exist', {
          code: 'PROJECT_PATH_NOT_FOUND',
          statusCode: 400,
          details: `No such directory: ${projectPath}`,
        });
      }

      throw error;
    }

    if (!directoryStats.isDirectory()) {
      throw new AppError('Path exists but is not a directory', {
        code: 'PROJECT_PATH_NOT_DIRECTORY',
        statusCode: 400,
      });
    }
  },
  getProjectById: (projectId: string): ProjectRepositoryRow | null =>
    projectsDb.getProjectById(projectId),
  getProjectByPath: (projectPath: string): ProjectRepositoryRow | null =>
    projectsDb.getProjectPath(projectPath),
  persistProjectPath: (projectId: string, projectPath: string): void => {
    projectsDb.updateProjectPathById(projectId, projectPath);
  },
  persistDisplayName: (projectId: string, displayName: string | null): void => {
    projectsDb.updateCustomProjectNameById(projectId, displayName);
  },
};

/**
 * Repoints an existing project at a different folder.
 *
 * DB 의 경로만 바꾼다 — 폴더를 옮기지는 않는다. 세션 기록은
 * `sessions.project_path` 의 `ON UPDATE CASCADE` 를 통해 따라온다.
 */
export async function updateProjectPath(
  input: UpdateProjectPathInput,
  dependencies: UpdateProjectPathDependencies = defaultUpdatePathDependencies,
): Promise<{ project: ProjectApiView }> {
  const existingProject = dependencies.getProjectById(input.projectId);
  if (!existingProject) {
    throw new AppError('Project not found', {
      code: 'PROJECT_NOT_FOUND',
      statusCode: 404,
    });
  }

  const normalizedPath = normalizeProjectPath(input.newPath || '');
  if (!normalizedPath) {
    throw new AppError('path is required', {
      code: 'PROJECT_PATH_REQUIRED',
      statusCode: 400,
    });
  }

  const pathValidation = await dependencies.validatePath(normalizedPath);
  if (!pathValidation.valid || !pathValidation.resolvedPath) {
    throw new AppError('Invalid project path', {
      code: 'INVALID_PROJECT_PATH',
      statusCode: 400,
      details: pathValidation.error ?? 'Path validation failed',
    });
  }

  const resolvedProjectPath = normalizeProjectPath(pathValidation.resolvedPath);

  if (resolvedProjectPath === existingProject.project_path) {
    return { project: mapProjectRowToApiView(existingProject) };
  }

  const conflictingProject = dependencies.getProjectByPath(resolvedProjectPath);
  if (conflictingProject) {
    throw new AppError('Another project already uses this path', {
      code: 'PROJECT_PATH_ALREADY_USED',
      statusCode: 409,
      details: `Path already registered: ${resolvedProjectPath}`,
    });
  }

  await dependencies.assertDirectoryExists(resolvedProjectPath);

  dependencies.persistProjectPath(input.projectId, resolvedProjectPath);

  let displayName = existingProject.custom_project_name;
  const displayNameFollowedFolder =
    !displayName || displayName === path.basename(existingProject.project_path);
  if (input.syncDisplayName !== false && displayNameFollowedFolder) {
    displayName = path.basename(resolvedProjectPath) || resolvedProjectPath;
    dependencies.persistDisplayName(input.projectId, displayName);
  }

  return {
    project: mapProjectRowToApiView({
      ...existingProject,
      project_path: resolvedProjectPath,
      custom_project_name: displayName,
    }),
  };
}
