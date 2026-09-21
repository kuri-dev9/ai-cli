import assert from 'node:assert/strict';
import net from 'node:net';
import test from 'node:test';

/**
 * 이름으로 연결할 때 Node 가 IPv4 로 넘어가지 못하고 매달리는 환경이 있다.
 * 부팅 모듈이 그 자동 선택을 꺼 두는지만 확인한다 — 이 설정이 조용히 사라지면
 * `fetch failed`(ETIMEDOUT) 하나만 남고 원인을 다시 처음부터 찾게 된다.
 */
test('부팅 시 주소 자동 선택을 끈다', async () => {
  // 기본값이 이미 false 면 이 테스트가 아무것도 지키지 못한다.
  net.setDefaultAutoSelectFamily(true);

  await import('@/configure-network.js');

  assert.equal(net.getDefaultAutoSelectFamily(), false);
});
