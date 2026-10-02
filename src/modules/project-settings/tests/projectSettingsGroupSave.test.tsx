import assert from 'node:assert/strict';

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { beforeEach, test, vi } from 'vitest';

import '@/modules/i18n';
import ProjectSettingsModal from '@/modules/project-settings/ProjectSettingsModal';
import { api } from '@/shared/api';
import { readUserPreference, writeUserPreference } from '@/shared/userSettings';
import type { Project } from '@/shared/types';

/**
 * 프로젝트 설정의 그룹 항목은 이 화면의 다른 항목과 같은 규칙을 따라야 한다:
 * 고르기만 해서는 아무것도 바뀌지 않고, 저장을 눌러야 사이드바에 반영된다.
 * 예전에는 select 를 바꾸는 즉시 반영되어서, 둘러보다 닫아도 프로젝트가
 * 이미 옮겨져 있었다.
 */

const PROJECT: Project = {
  projectId: 'p1',
  displayName: 'P1',
  fullPath: '/work/p1',
  path: '/work/p1',
  isStarred: false,
};

const readAssignments = () =>
  readUserPreference<{ assignments: Record<string, string> }>('projectGroups', { assignments: {} })
    .assignments;

beforeEach(() => {
  // 서버 왕복은 전부 끊는다 — 여기서 검증하는 것은 로컬 환경설정의 시점뿐이다.
  vi.spyOn(api.user, 'savePreferences').mockResolvedValue({ ok: true } as Response);
  writeUserPreference('projectGroups', {
    groups: [{ id: 'g1', name: '회사', collapsed: false }],
    assignments: {},
  });
});

function renderModal() {
  const onClose = vi.fn();
  const onSaved = vi.fn();
  const { container } = render(
    <ProjectSettingsModal
      project={PROJECT}
      onClose={onClose}
      onSaved={onSaved}
      onRequestDelete={vi.fn()}
    />,
  );
  // 푸터의 버튼 순서는 [제거, 취소, 저장]으로 고정이다. 레이블은 실행
  // 환경의 로케일을 따라가므로 글자가 아니라 자리로 집는다.
  const footerButtons = [...container.querySelectorAll<HTMLButtonElement>('button')];
  const saveButton = footerButtons[footerButtons.length - 1];
  const cancelButton = footerButtons[footerButtons.length - 2];
  return { onClose, onSaved, saveButton, cancelButton };
}

test('그룹을 골라도 저장 전에는 아무것도 바뀌지 않는다', () => {
  renderModal();

  fireEvent.change(screen.getByRole('combobox'), { target: { value: 'g1' } });

  assert.deepEqual(readAssignments(), {});
});

test('저장을 누르면 그 그룹으로 들어가고 화면이 닫힌다', async () => {
  const { onClose, onSaved, saveButton } = renderModal();

  fireEvent.change(screen.getByRole('combobox'), { target: { value: 'g1' } });
  // 그룹만 바꿔도 저장이 눌린다 — 비활성 버튼이면 클릭이 통하지 않아
  // 아래 대기가 실패한다.
  fireEvent.click(saveButton);

  await waitFor(() => assert.equal(onClose.mock.calls.length, 1));
  assert.deepEqual(readAssignments(), { p1: 'g1' });
  assert.equal(onSaved.mock.calls.length, 1);
});

test('고르기만 하고 닫으면 원래 그룹에 그대로 남는다', () => {
  const { onClose, cancelButton } = renderModal();

  fireEvent.change(screen.getByRole('combobox'), { target: { value: 'g1' } });
  fireEvent.click(cancelButton);

  assert.equal(onClose.mock.calls.length, 1);
  assert.deepEqual(readAssignments(), {});
});
