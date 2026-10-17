import React from 'react';

/**
 * 번호 목록의 왼쪽 여백. 가장 큰 번호의 자릿수만큼 넓힌다.
 *
 * 번호(marker)는 목록 바깥 여백에 그려지는데, 메시지 상자에는 넘친 내용을
 * 그리지 않는 containment(`.chat-message { contain: paint }`)가 걸려 있다.
 * 고정 20px 로는 "82." 부터 앞자리가 상자 밖으로 나가 잘렸다. 한 자리 목록은
 * 예전 그대로 1.25rem 이다.
 */
export function orderedListIndent(start: number | undefined, children: React.ReactNode): string {
  const itemCount = React.Children.toArray(children).filter(React.isValidElement).length;
  const lastNumber = (start ?? 1) + Math.max(itemCount, 1) - 1;
  const digits = String(Math.abs(lastNumber)).length;
  // 번호 자릿수 + "." 과 번호·본문 사이 간격만큼.
  return digits <= 1 ? '1.25rem' : `calc(${digits + 1}ch + 0.25rem)`;
}
