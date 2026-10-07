import assert from 'node:assert/strict';

import { test } from 'vitest';

import {
  findTranscriptContentElement,
  readAimedDistanceFromBottom,
  resolveFollowIntent,
} from '@/modules/chat/hooks/useChatSessionState';

/**
 * 스트리밍 중 바닥 따라가기의 세 재료.
 *
 * - 휠/터치 방향 읽기. 위로 올리면 결론(놓는다), 아래로 내리면 조준일 뿐이다.
 * - 조준한 바닥까지의 거리. 입력이 들어온 순간의 높이를 기준으로 재야
 *   스트리밍으로 자란 만큼이 거리에 끼어들지 않는다.
 * - ResizeObserver 가 지켜볼 본문 요소 선택. 내보내기 메뉴(sticky) 래퍼가
 *   첫 자식으로 끼어들면서 firstElementChild 를 관찰하던 코드가 스트리밍
 *   성장(메시지 개수는 그대로, 마지막 메시지만 길어짐)을 통째로 놓쳤다.
 */

test('휠을 위로 굴리면 어디에 있든 따라가기를 놓는다', () => {
  assert.equal(resolveFollowIntent(-1), 'release');
  assert.equal(resolveFollowIntent(-120), 'release');
});

test('아래로 굴리는 것은 결론이 아니라 바닥 조준이다', () => {
  assert.equal(resolveFollowIntent(100), 'aim');
  assert.equal(resolveFollowIntent(1), 'aim');
  assert.equal(resolveFollowIntent(0), null);
});

test('조준한 뒤 자란 분량은 바닥까지의 거리에 넣지 않는다', () => {
  // 입력 시점 높이 2000, 그 뒤 스트리밍으로 2600 까지 자랐다. 사용자는
  // 겨냥했던 바닥(2000)까지 끝내 내려갔다 — 닿은 것으로 봐야 한다.
  assert.equal(readAimedDistanceFromBottom(2000, 1200, 800, 2600), 0);
});

test('기준이 없으면 지금의 바닥까지를 그대로 쓴다', () => {
  assert.equal(readAimedDistanceFromBottom(null, 1200, 800, 2600), 600);
});

test('조준해도 중간에 멈추면 바닥에 닿지 않은 거리가 나온다', () => {
  assert.equal(readAimedDistanceFromBottom(2000, 400, 800, 2600), 800);
});

test('기준이 지금 바닥보다 멀면 가까운 쪽을 믿는다', () => {
  // 컨테이너가 줄어들어 기준이 실제 바닥보다 멀어진 경우. 실제로 끝까지
  // 내려간 사람을 낡은 기준으로 붙잡아 두지 않는다.
  assert.equal(readAimedDistanceFromBottom(3000, 1200, 800, 2000), 0);
});

test('본문 표식이 있으면 첫 자식(내보내기 메뉴 래퍼)이 아니라 본문을 관찰한다', () => {
  const container = document.createElement('div');

  const exportMenuWrapper = document.createElement('div');
  container.appendChild(exportMenuWrapper);

  const content = document.createElement('div');
  content.setAttribute('data-chat-scroll-content', '');
  container.appendChild(content);

  assert.equal(findTranscriptContentElement(container), content);
});

test('표식이 없으면 예전처럼 첫 자식으로, 그마저 없으면 컨테이너로 물러난다', () => {
  const container = document.createElement('div');
  assert.equal(findTranscriptContentElement(container), container);

  const onlyChild = document.createElement('div');
  container.appendChild(onlyChild);
  assert.equal(findTranscriptContentElement(container), onlyChild);
});
