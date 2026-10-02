import assert from 'node:assert/strict';

import { fireEvent, render, screen } from '@testing-library/react';
import React from 'react';
import { test } from 'vitest';

import MoveSessionModal from '@/modules/sidebar/modals/MoveSessionModal';
import type { PendingSessionMove, Project, SidebarProjectListProps } from '@/shared/types';

const t = ((key: string, fallback?: string) => fallback ?? key) as unknown as SidebarProjectListProps['t'];

const project = (projectId: string, displayName: string): Project => ({
  projectId,
  displayName,
  fullPath: `/work/${projectId}`,
});

const PROJECTS = [project('p-web', 'web'), project('p-api', 'api'), project('p-docs', 'docs')];

const MOVE: PendingSessionMove = {
  sessionId: 's1',
  sessionTitle: 'Fix the login bug',
  provider: 'claude',
  fromProjectId: 'p-web',
};

const renderModal = (overrides: Partial<React.ComponentProps<typeof MoveSessionModal>> = {}) => {
  const confirmed: string[] = [];
  const cancelled: number[] = [];
  const view = render(
    <MoveSessionModal
      move={MOVE}
      projects={PROJECTS}
      isMoving={false}
      onConfirm={(projectId) => confirmed.push(projectId)}
      onCancel={() => cancelled.push(1)}
      t={t}
      {...overrides}
    />,
  );
  return { ...view, confirmed, cancelled };
};

const choiceNames = (container: HTMLElement) =>
  [...container.querySelectorAll('[role="dialog"] .overflow-y-auto button p:first-child')]
    .map((node) => node.textContent);

test('lists every other project, sorted, and leaves out the one the session is in', () => {
  const { container } = renderModal();
  assert.deepEqual(choiceNames(container), ['api', 'docs']);
  screen.getByText('Fix the login bug');
});

test('picking a project confirms with its id', () => {
  const { confirmed } = renderModal();
  fireEvent.click(screen.getByText('docs'));
  assert.deepEqual(confirmed, ['p-docs']);
});

test('typing narrows the list by name or path', () => {
  const { container } = renderModal();
  fireEvent.change(screen.getByPlaceholderText('Find a project'), { target: { value: 'work/p-ap' } });
  assert.deepEqual(choiceNames(container), ['api']);
});

test('says so when there is nowhere to move to', () => {
  renderModal({ projects: [project('p-web', 'web')] });
  screen.getByText('No other project to move to.');
});

test('while a move runs, nothing else can be picked or cancelled', () => {
  const { confirmed, cancelled } = renderModal({ isMoving: true });

  fireEvent.click(screen.getByText('api'));
  fireEvent.click(screen.getByText('Moving…'));

  assert.deepEqual(confirmed, []);
  assert.deepEqual(cancelled, []);
});

test('clicking the backdrop cancels, clicking inside does not', () => {
  const { container, cancelled } = renderModal();
  fireEvent.click(container.querySelector('[role="dialog"]') as Element);
  assert.deepEqual(cancelled, []);
  fireEvent.click(container.firstElementChild as Element);
  assert.deepEqual(cancelled, [1]);
});
