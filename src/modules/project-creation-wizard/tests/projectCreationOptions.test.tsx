import assert from 'node:assert/strict';

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, test, vi } from 'vitest';

import '@/modules/i18n';
import ProjectCreationWizard from '@/modules/project-creation-wizard/ProjectCreationWizard';
import { NEW_PROJECT_GROUP } from '@/modules/project-creation-wizard/ProjectOptionsFields';
import { api } from '@/shared/api';
import { readUserPreference, writeUserPreference } from '@/shared/userSettings';

/**
 * 새 프로젝트를 만들면서 이름·그룹·즐겨찾기를 한 번에 정한다.
 * 만든 뒤 설정 창을 다시 열 필요가 없어야 한다.
 */

type GroupsPreference = {
  groups: { id: string; name: string }[];
  assignments: Record<string, string>;
};

const readGroups = () =>
  readUserPreference<GroupsPreference>('projectGroups', { groups: [], assignments: {} });

const jsonResponse = (body: unknown) =>
  ({ ok: true, status: 200, json: async () => body }) as Response;

let createProject: ReturnType<typeof vi.fn>;
let toggleProjectStar: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(api.user, 'savePreferences').mockResolvedValue({ ok: true } as Response);
  vi.spyOn(api, 'browseFilesystem').mockResolvedValue(jsonResponse({ suggestions: [] }));
  createProject = vi.fn().mockResolvedValue(
    jsonResponse({ success: true, project: { projectId: 'p-new', isStarred: false } }),
  );
  toggleProjectStar = vi.fn().mockResolvedValue(jsonResponse({ success: true }));
  vi.spyOn(api, 'createProject').mockImplementation(createProject);
  vi.spyOn(api, 'toggleProjectStar').mockImplementation(toggleProjectStar);
  writeUserPreference('projectGroups', {
    groups: [{ id: 'g1', name: '회사', collapsed: false }],
    assignments: {},
  });
});

/** 경로를 넣고 확인 단계로 넘어간다. 버튼은 로케일과 상관없이 푸터 마지막 자리로 집는다. */
async function openReviewStep() {
  const onClose = vi.fn();
  const onProjectCreated = vi.fn();
  const { container } = render(
    <ProjectCreationWizard onClose={onClose} onProjectCreated={onProjectCreated} />,
  );
  const lastButton = () => {
    const buttons = [...container.querySelectorAll<HTMLButtonElement>('button')];
    return buttons[buttons.length - 1];
  };

  fireEvent.change(container.querySelector('input')!, { target: { value: '/work/sheet-helper' } });
  fireEvent.click(lastButton());
  await screen.findByRole('combobox');

  return { container, onClose, onProjectCreated, lastButton };
}

test('이름·기존 그룹·즐겨찾기를 고르면 만들면서 함께 적용된다', async () => {
  const { container, onClose, lastButton } = await openReviewStep();

  fireEvent.change(container.querySelector('#project-wizard-display-name')!, { target: { value: '시트 도우미' } });
  fireEvent.change(screen.getByRole('combobox'), { target: { value: 'g1' } });
  fireEvent.click(screen.getByRole('checkbox'));
  fireEvent.click(lastButton());

  await waitFor(() => assert.equal(onClose.mock.calls.length, 1));
  assert.deepEqual(createProject.mock.calls[0][0], { path: '/work/sheet-helper', customName: '시트 도우미' });
  assert.deepEqual(toggleProjectStar.mock.calls, [['p-new']]);
  assert.deepEqual(readGroups().assignments, { 'p-new': 'g1' });
});

test('새 그룹을 고르면 이름을 넣기 전에는 만들 수 없고, 넣으면 그 그룹이 생긴다', async () => {
  const { container, onClose, lastButton } = await openReviewStep();

  fireEvent.change(screen.getByRole('combobox'), { target: { value: NEW_PROJECT_GROUP } });
  assert.equal(lastButton().disabled, true);

  const groupNameInput = [...container.querySelectorAll('input[type="text"]')].pop()!;
  fireEvent.change(groupNameInput, { target: { value: '사이드' } });
  assert.equal(lastButton().disabled, false);
  fireEvent.click(lastButton());

  await waitFor(() => assert.equal(onClose.mock.calls.length, 1));
  const { groups, assignments } = readGroups();
  const created = groups.find((group) => group.name === '사이드');
  assert.ok(created, '새 그룹이 만들어져야 한다');
  assert.deepEqual(assignments, { 'p-new': created.id });
  // 이름을 비워 두면 서버가 폴더 이름을 쓰도록 customName 을 보내지 않는다.
  assert.deepEqual(createProject.mock.calls[0][0], { path: '/work/sheet-helper' });
  assert.equal(toggleProjectStar.mock.calls.length, 0);
});
