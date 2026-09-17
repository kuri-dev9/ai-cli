import assert from 'node:assert/strict';

import { test } from 'vitest';

import { partitionProjectsByGroup } from '@/modules/sidebar/projectGroups';

/**
 * 그룹은 화면에만 존재하는 묶음이다. 여기서 검증하는 것은 "어느 프로젝트가 어느
 * 머리글 밑에 그려지는가" 하나뿐 — 파일시스템은 건드리지 않는다.
 */

const project = (projectId: string) => ({ projectId });

test('그룹에 배정되지 않은 프로젝트는 미분류로 남는다', () => {
  const { ungrouped, byGroup } = partitionProjectsByGroup(
    [project('a'), project('b')],
    { groups: [{ id: 'g1', name: '작업', collapsed: false }], assignments: { a: 'g1' } },
  );

  assert.deepEqual(byGroup.get('g1')?.map((item) => item.projectId), ['a']);
  assert.deepEqual(ungrouped.map((item) => item.projectId), ['b']);
});

test('사라진 그룹을 가리키는 배정은 프로젝트를 잃지 않고 미분류로 돌린다', () => {
  const { ungrouped, byGroup } = partitionProjectsByGroup(
    [project('a')],
    { groups: [], assignments: { a: 'deleted-group' } },
  );

  assert.equal(byGroup.size, 0);
  assert.deepEqual(ungrouped.map((item) => item.projectId), ['a']);
});

test('그룹은 비어 있어도 자리를 지킨다', () => {
  const { byGroup } = partitionProjectsByGroup(
    [],
    { groups: [{ id: 'g1', name: '보관', collapsed: true }], assignments: {} },
  );

  assert.deepEqual(byGroup.get('g1'), []);
});

test('프로젝트 순서는 그룹 안에서도 목록 순서를 따른다', () => {
  const { byGroup } = partitionProjectsByGroup(
    [project('c'), project('a'), project('b')],
    {
      groups: [{ id: 'g1', name: '작업', collapsed: false }],
      assignments: { a: 'g1', b: 'g1', c: 'g1' },
    },
  );

  assert.deepEqual(byGroup.get('g1')?.map((item) => item.projectId), ['c', 'a', 'b']);
});
