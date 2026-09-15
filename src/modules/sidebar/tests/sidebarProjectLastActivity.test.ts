import assert from 'node:assert/strict';

import { test } from 'vitest';

import type { LLMProvider, Project } from '@/shared/types';
import { ALL_PROVIDERS } from '@/shared/providerVisibility';
import {
  formatCompactAge,
  getVisibleLastActivity,
  getVisibleSessions,
} from '@/modules/sidebar/utils/sidebarProjectFormatting';

/**
 * 프로젝트 행은 접힌 상태에서도 마지막 대화 시각을 보여준다. 그 값이 어디서
 * 오는지가 이 테스트의 주제다.
 *
 * - 세션은 첫 페이지만 내려오므로 화면에 있는 목록만으로는 계산할 수 없다.
 *   서버가 내려준 provider 별 집계가 그 빈자리를 메운다.
 * - 반대로 집계는 다음 `/api/projects` 까지 갱신되지 않으므로, 방금 주고받은
 *   대화는 들고 있는 세션 목록에서 온다.
 * - 어느 쪽이든 꺼 둔 CLI 의 대화 시각은 보여주면 안 된다. 사용자가 목록에서
 *   볼 수 없는 대화의 시각이기 때문이다.
 */

const ALL: readonly LLMProvider[] = ALL_PROVIDERS;
const CLAUDE_ONLY: readonly LLMProvider[] = ['claude'];

type SessionSeed = { id: string; provider?: string; lastActivity: string };

const makeProject = (
  sessions: SessionSeed[],
  lastActivityByProvider?: Record<string, string>,
): Project => ({
  projectId: 'p',
  displayName: 'p',
  fullPath: '/tmp/p',
  sessions: sessions.map((session) => ({ ...session, summary: session.id })),
  ...(lastActivityByProvider ? { lastActivityByProvider } : {}),
  sessionMeta: { total: sessions.length, hasMore: false },
}) as unknown as Project;

const lastActivityOf = (project: Project, enabled: readonly LLMProvider[]): string =>
  getVisibleLastActivity(project, getVisibleSessions(project, enabled), enabled);

test('세션을 아직 안 받은 접힌 프로젝트도 서버 집계로 시각을 보여준다', () => {
  const project = makeProject([], { claude: '2026-09-02T10:00:00.000Z' });

  assert.equal(lastActivityOf(project, ALL), '2026-09-02T10:00:00.000Z');
});

test('집계된 여러 provider 중 가장 최근 것을 고른다', () => {
  const project = makeProject([], {
    claude: '2026-09-02T10:00:00.000Z',
    codex: '2026-09-04T10:00:00.000Z',
  });

  assert.equal(lastActivityOf(project, ALL), '2026-09-04T10:00:00.000Z');
});

test('꺼 둔 provider 의 대화가 더 최근이어도 그 시각은 쓰지 않는다', () => {
  const project = makeProject([], {
    claude: '2026-09-02T10:00:00.000Z',
    codex: '2026-09-04T10:00:00.000Z',
  });

  assert.equal(lastActivityOf(project, CLAUDE_ONLY), '2026-09-02T10:00:00.000Z');
});

test('집계보다 새로 들어온 세션이 있으면 그쪽을 쓴다', () => {
  // websocket 으로 세션이 갱신돼도 집계는 다음 프로젝트 목록 요청까지 그대로다.
  const project = makeProject(
    [{ id: 's1', provider: 'claude', lastActivity: '2026-09-05T10:00:00.000Z' }],
    { claude: '2026-09-02T10:00:00.000Z' },
  );

  assert.equal(lastActivityOf(project, ALL), '2026-09-05T10:00:00.000Z');
});

test('꺼 둔 provider 의 세션은 들고 있어도 시각에 반영하지 않는다', () => {
  const project = makeProject(
    [
      { id: 's1', provider: 'claude', lastActivity: '2026-09-01T10:00:00.000Z' },
      { id: 's2', provider: 'codex', lastActivity: '2026-09-06T10:00:00.000Z' },
    ],
    { claude: '2026-09-01T10:00:00.000Z', codex: '2026-09-06T10:00:00.000Z' },
  );

  assert.equal(lastActivityOf(project, CLAUDE_ONLY), '2026-09-01T10:00:00.000Z');
  assert.equal(lastActivityOf(project, ALL), '2026-09-06T10:00:00.000Z');
});

test('대화가 하나도 없으면 빈 문자열이라 시각을 그리지 않는다', () => {
  const project = makeProject([]);

  assert.equal(lastActivityOf(project, ALL), '');
  assert.equal(formatCompactAge('', new Date()), '');
});

test('프로젝트 행의 시각은 세션 행과 같은 포맷 함수를 쓴다', () => {
  const now = new Date('2026-09-05T12:00:00.000Z');
  const project = makeProject([], { claude: '2026-09-05T10:00:00.000Z' });

  assert.equal(formatCompactAge(lastActivityOf(project, ALL), now), '2hr');
});
