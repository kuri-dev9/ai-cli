import type { ChatMessage } from '@/shared/types';

/**
 * 진행 중인 차례에서 지난 도구 호출을 접는다.
 *
 * 한 참가자가 조사하는 동안 셸 호출이 수십 줄씩 쌓인다. 룸은 그런 참가자가
 * 여럿이라 화면이 금세 도구 호출로만 채워지고, 정작 무엇을 하고 있는지는
 * 맨 아래 한 줄에서만 읽힌다.
 *
 * 그래서 **최근 몇 개만 남기고 앞의 호출은 한 줄로 묶는다**. 참가자가 중간에
 * 한 말(텍스트)은 접지 않는다 — 그건 과정이 아니라 결론에 가깝고, 읽는 사람이
 * 흐름을 쫓는 단서다.
 */

/** 진행 중인 차례에 펼쳐 두는 도구 호출 수. */
export const LIVE_TOOL_TAIL = 3;

export type FoldedLiveTurn = {
  /** 그릴 메시지. 접힌 것은 빠져 있다. */
  rows: ChatMessage[];
  /** 접힘 줄이 들어갈 자리. 접은 것이 없으면 -1. */
  foldAtIndex: number;
  /** 접어 둔 도구 호출 수. */
  hiddenCount: number;
};

/**
 * `expanded` 면 아무것도 접지 않는다. 접을 것이 `LIVE_TOOL_TAIL` 이하일 때도
 * 그대로 둔다 — 한두 개를 접어 봐야 줄 수가 줄지 않고 누를 거리만 생긴다.
 */
export function foldLiveTurn(messages: ChatMessage[], expanded: boolean): FoldedLiveTurn {
  if (expanded) {
    return { rows: messages, foldAtIndex: -1, hiddenCount: 0 };
  }

  const toolIndices: number[] = [];
  messages.forEach((message, index) => {
    if (message.isToolUse) {
      toolIndices.push(index);
    }
  });
  if (toolIndices.length <= LIVE_TOOL_TAIL) {
    return { rows: messages, foldAtIndex: -1, hiddenCount: 0 };
  }

  // 마지막 `LIVE_TOOL_TAIL` 개의 도구 호출이 시작되는 자리. 그 뒤는 손대지 않는다.
  const cutoff = toolIndices[toolIndices.length - LIVE_TOOL_TAIL];
  const head = messages.slice(0, cutoff);
  const hiddenCount = head.filter((message) => message.isToolUse).length;
  // 앞쪽이라도 참가자가 한 말은 남긴다.
  const keptHead = head.filter((message) => !message.isToolUse);

  return {
    rows: [...keptHead, ...messages.slice(cutoff)],
    foldAtIndex: keptHead.length,
    hiddenCount,
  };
}
