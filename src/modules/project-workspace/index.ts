export { default as ProjectWorkspaceRoute } from '@/modules/project-workspace/ProjectWorkspaceRoute';
// 지금 열려 있는 세션. 퀵 설정 패널이 세션 단위 텔레그램 알림 토글을 그릴 때
// 쓴다 — 패널은 이 워크스페이스 안에서만 렌더된다.
export { useProjectActiveSessionState } from '@/modules/project-workspace/context/ProjectsStateContext';
