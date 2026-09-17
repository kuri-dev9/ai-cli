import { api } from '@/shared/api';

type UpdateProjectPathResponse = {
  success?: boolean;
  data?: { project?: Record<string, unknown> };
  error?: string | { message?: string; details?: string };
  details?: string;
};

function resolveErrorMessage(responseData: UpdateProjectPathResponse): string | null {
  if (typeof responseData.details === 'string' && responseData.details.trim().length > 0) {
    return responseData.details;
  }

  if (typeof responseData.error === 'string' && responseData.error.trim().length > 0) {
    return responseData.error;
  }

  if (responseData.error && typeof responseData.error === 'object') {
    // 서버는 무엇이 막았는지 `details` 에 담아 준다 — 사용자에게는 그쪽이 더 쓸모 있다.
    return responseData.error.details || responseData.error.message || null;
  }

  return null;
}

/**
 * Repoints an existing project at another folder.
 *
 * 폴더 자체는 옮기지 않는다. 폴더를 실제로 옮길 거라면 사용자가 먼저 옮긴 뒤
 * 이 요청으로 새 위치를 알려 주는 순서다.
 */
export const updateProjectPathRequest = async (projectId: string, projectPath: string) => {
  const response = await api.updateProjectPath(projectId, projectPath.trim());
  const data = (await response.json()) as UpdateProjectPathResponse;

  if (!response.ok) {
    throw new Error(resolveErrorMessage(data) || 'Failed to change the project path');
  }

  return data.data?.project;
};
