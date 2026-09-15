import assert from 'node:assert/strict';

import { beforeEach, test } from 'vitest';

import {
  ALL_PROVIDERS,
  canDisableProvider,
  isProviderEnabled,
  readDisabledProviders,
  readEnabledProviders,
  setProviderEnabled,
} from '@/shared/providerVisibility';
import { readSelectedProvider, writeSelectedProvider } from '@/shared/selectedProvider';
import { readUserPreference, resetUserPreferences, writeUserPreference } from '@/shared/userSettings';

/**
 * 어떤 CLI 를 화면에 노출할지는 빌드타임 `VITE_ENABLED_PROVIDERS` 였다가 사용자
 * 설정으로 옮겨 왔다. 여기서 지켜야 할 것은 세 가지다: 설정한 적 없으면 전부 켬,
 * 마지막 하나는 끌 수 없음, 껐다 켜도 고르던 provider 가 살아 있음.
 */

beforeEach(() => {
  localStorage.clear();
  // 설정 저장소는 모듈 스코프 싱글턴이라 localStorage.clear() 로는 안 지워진다.
  resetUserPreferences();
});

test('설정한 적이 없으면 네 provider 가 모두 켜져 있다', () => {
  assert.deepEqual(readDisabledProviders(), []);
  assert.deepEqual(readEnabledProviders(), [...ALL_PROVIDERS]);
  assert.equal(isProviderEnabled('opencode'), true);
});

test('하나를 끄면 그것만 목록에서 빠진다', () => {
  assert.equal(setProviderEnabled('cursor', false), true);

  assert.equal(isProviderEnabled('cursor'), false);
  assert.deepEqual(readEnabledProviders(), ['claude', 'codex', 'opencode']);
});

test('다시 켜면 표준 순서 그대로 돌아온다', () => {
  setProviderEnabled('claude', false);
  setProviderEnabled('claude', true);

  assert.deepEqual(readEnabledProviders(), [...ALL_PROVIDERS]);
});

test('마지막으로 남은 하나는 끌 수 없다', () => {
  setProviderEnabled('cursor', false);
  setProviderEnabled('codex', false);
  setProviderEnabled('opencode', false);

  assert.equal(canDisableProvider('claude'), false);
  assert.equal(setProviderEnabled('claude', false), false);
  assert.deepEqual(readEnabledProviders(), ['claude']);
});

test('저장값이 네 개를 전부 끄고 있으면 무시하고 전부 켠다', () => {
  // UI 로는 나올 수 없는 상태지만, 손상된 값 하나로 앱이 잠기면 안 된다.
  writeUserPreference('disabledProviders', ['claude', 'cursor', 'codex', 'opencode']);

  assert.deepEqual(readEnabledProviders(), [...ALL_PROVIDERS]);
});

test('배열이 아니거나 모르는 이름이 든 저장값은 걸러진다', () => {
  writeUserPreference('disabledProviders', 'cursor');
  assert.deepEqual(readEnabledProviders(), [...ALL_PROVIDERS]);

  writeUserPreference('disabledProviders', ['cursor', 'gemini', 'cursor']);
  assert.deepEqual(readDisabledProviders(), ['cursor']);
});

test('꺼 둔 provider 가 선택돼 있으면 켜져 있는 것을 대신 주되 저장값은 남긴다', () => {
  writeSelectedProvider('codex');
  setProviderEnabled('codex', false);

  // 꺼 둔 CLI 로 채팅이 열려서는 안 된다.
  assert.equal(readSelectedProvider(), 'claude');
  // 그렇다고 선택이 날아가서도 안 된다 — 잠깐 껐다 켜는 경우가 있다.
  assert.equal(readUserPreference('selectedProvider', null), 'codex');

  setProviderEnabled('codex', true);
  assert.equal(readSelectedProvider(), 'codex');
});

test('claude 가 꺼져 있으면 켜져 있는 것 중 첫 번째로 되돌아간다', () => {
  setProviderEnabled('claude', false);

  assert.equal(readSelectedProvider(), 'cursor');
});
