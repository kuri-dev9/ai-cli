import { beforeEach, describe, expect, it } from 'vitest';

import type { Project } from '@/shared/types';
import {
  findUnseenSessionIds,
  readPersistedAttentionIds,
  recordSessionViewed,
  writePersistedAttentionIds,
} from '@/shared/sessionAttention';

const buildProject = (sessions: Array<{ id: string; updated_at?: string }>): Project => ({
  projectId: 'project-1',
  displayName: 'Repo',
  fullPath: '/repo',
  sessions,
} as Project);

beforeEach(() => {
  localStorage.clear();
});

describe('확인하지 않은 대화 표시', () => {
  it('창을 닫았다 열어도 표시가 남는다', () => {
    writePersistedAttentionIds(new Set(['session-a', 'session-b']));

    expect(readPersistedAttentionIds()).toEqual(['session-a', 'session-b']);
  });

  it('저장된 값이 깨져 있으면 빈 목록으로 시작한다', () => {
    localStorage.setItem('sessionAttention', '{"not":"an array"}');

    expect(readPersistedAttentionIds()).toEqual([]);
  });

  it('마지막으로 열어 본 뒤에 갱신된 대화를 집어낸다', () => {
    recordSessionViewed('session-a', '2026-01-01T00:00:00.000Z');

    const projects = [buildProject([{ id: 'session-a', updated_at: '2026-01-01T01:00:00.000Z' }])];

    expect(findUnseenSessionIds(projects)).toEqual(['session-a']);
  });

  it('열어 본 뒤로 움직이지 않은 대화는 집어내지 않는다', () => {
    recordSessionViewed('session-a', '2026-01-01T02:00:00.000Z');

    const projects = [buildProject([{ id: 'session-a', updated_at: '2026-01-01T01:00:00.000Z' }])];

    expect(findUnseenSessionIds(projects)).toEqual([]);
  });

  it('한 번도 열어 본 적 없는 대화는 건드리지 않는다', () => {
    // 이 규칙이 없으면 기능을 켠 첫날 사이드바 전체에 점이 찍힌다.
    recordSessionViewed('session-a', '2026-01-01T00:00:00.000Z');

    const projects = [buildProject([
      { id: 'session-a', updated_at: '2026-01-01T00:00:00.000Z' },
      { id: 'never-opened', updated_at: '2026-06-01T00:00:00.000Z' },
    ])];

    expect(findUnseenSessionIds(projects)).toEqual([]);
  });

  it('SQLite 형식의 옛 시각도 ISO 와 같이 비교한다', () => {
    // 사전순으로 비교하면 'T'(0x54) 와 ' '(0x20) 때문에 조용히 뒤집힌다.
    recordSessionViewed('session-a', '2026-01-01 00:00:00');

    const projects = [buildProject([{ id: 'session-a', updated_at: '2026-01-01T01:00:00.000Z' }])];

    expect(findUnseenSessionIds(projects)).toEqual(['session-a']);
  });
});
