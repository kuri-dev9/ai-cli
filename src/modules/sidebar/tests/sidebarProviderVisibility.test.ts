import assert from 'node:assert/strict';

import { test } from 'vitest';

import type { LLMProvider, Project } from '@/shared/types';
import { ALL_PROVIDERS, isVisibleProvider, toProviderName } from '@/shared/providerVisibility';
import { getAllSessions, getVisibleSessions } from '@/modules/sidebar/utils/sidebarProjectFormatting';

/**
 * 설정에서 CLI 를 꺼도 사이드바에는 그 CLI 로 만든 지난 대화가 그대로 남아 있었고,
 * 사용자는 그것을 보고 "그 CLI 가 연결돼 있다" 로 읽었다. 그래서 새 대화를 시작할
 * provider 뿐 아니라 과거 세션 목록도 같은 규칙으로 걸러야 한다.
 *
 * 여기서 지켜야 할 것은 하나 더 있다: **가리기만 하고 지우지 않는다.** 원본
 * `project.sessions` 가 남아 있어야 다시 켰을 때 대화가 돌아오고, 서버 페이지네이션이
 * offset 으로 쓰는 "받아 둔 세션 수" 도 어긋나지 않는다.
 */

const ALL: readonly LLMProvider[] = ALL_PROVIDERS;
const CLAUDE_ONLY: readonly LLMProvider[] = ['claude'];

const makeProject = (sessions: Array<{ id: string; provider?: string }>): Project => ({
  projectId: 'p',
  name: 'p',
  displayName: 'p',
  fullPath: '/tmp/p',
  sessions: sessions.map((session) => ({
    ...session,
    summary: session.id,
    lastActivity: '2026-08-21T10:00:00.000Z',
  })),
  sessionMeta: { total: sessions.length, hasMore: false },
}) as unknown as Project;

test('꺼 둔 provider 의 세션은 목록에서 빠진다', () => {
  const project = makeProject([
    { id: 's1', provider: 'claude' },
    { id: 's2', provider: 'codex' },
    { id: 's3', provider: 'cursor' },
  ]);

  const visible = getVisibleSessions(project, CLAUDE_ONLY);

  assert.deepEqual(visible.map((session) => session.id), ['s1']);
});

test('가릴 뿐 세션 데이터는 그대로 남는다', () => {
  const project = makeProject([
    { id: 's1', provider: 'claude' },
    { id: 's2', provider: 'codex' },
  ]);

  getVisibleSessions(project, CLAUDE_ONLY);

  // 원본이 남아 있어야 다시 켰을 때 돌아오고, "더 보기" 의 offset 도 맞는다.
  assert.equal(project.sessions?.length, 2);
  assert.equal(getAllSessions(project).length, 2);
  assert.deepEqual(getVisibleSessions(project, ALL).map((session) => session.id), ['s1', 's2']);
});

test('전부 켜져 있으면 거르지 않고 같은 배열을 그대로 돌려준다', () => {
  // 행 memo 경계가 이 배열의 동일성에 걸려 있다. 거를 게 없는데 새 배열을
  // 만들면 세션 델타가 올 때마다 사이드바 전체가 다시 그려진다.
  const project = makeProject([{ id: 's1', provider: 'claude' }]);

  assert.equal(getVisibleSessions(project, ALL), getAllSessions(project));
});

test('같은 조건으로 두 번 물으면 같은 배열을 돌려준다', () => {
  const project = makeProject([
    { id: 's1', provider: 'claude' },
    { id: 's2', provider: 'codex' },
  ]);

  assert.equal(
    getVisibleSessions(project, CLAUDE_ONLY),
    getVisibleSessions(project, CLAUDE_ONLY),
  );
});

test('켜 둔 목록이 바뀌면 캐시를 다시 계산한다', () => {
  const project = makeProject([
    { id: 's1', provider: 'claude' },
    { id: 's2', provider: 'codex' },
  ]);

  assert.deepEqual(getVisibleSessions(project, CLAUDE_ONLY).map((s) => s.id), ['s1']);
  assert.deepEqual(getVisibleSessions(project, ['codex']).map((s) => s.id), ['s2']);
  assert.deepEqual(getVisibleSessions(project, CLAUDE_ONLY).map((s) => s.id), ['s1']);
});

test('provider 가 비어 있는 옛 세션은 claude 로 본다', () => {
  // provider 컬럼이 생기기 전에 만들어진 세션. 알 수 없다고 감춰 버리면
  // Claude 만 켜 둔 사용자의 지난 대화가 통째로 사라진다.
  const project = makeProject([{ id: 'legacy' }, { id: 'blank', provider: '  ' }]);

  assert.equal(toProviderName(undefined), 'claude');
  assert.equal(isVisibleProvider(null, CLAUDE_ONLY), true);
  assert.deepEqual(getVisibleSessions(project, CLAUDE_ONLY).map((s) => s.id), ['legacy', 'blank']);
  assert.deepEqual(getVisibleSessions(project, ['codex']).map((s) => s.id), []);
});
