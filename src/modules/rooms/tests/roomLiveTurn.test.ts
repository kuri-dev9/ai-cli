import { describe, expect, it } from 'vitest';

import { foldLiveTurn, LIVE_TOOL_TAIL } from '@/modules/rooms/utils/roomLiveTurn';
import type { ChatMessage } from '@/shared/types';

const tool = (name: string): ChatMessage => ({ type: 'assistant', isToolUse: true, toolName: name, timestamp: '' });
const text = (content: string): ChatMessage => ({ type: 'assistant', content, timestamp: '' });

describe('folding a live turn', () => {
  it('leaves a short run of tool calls alone', () => {
    const messages = [text('시작합니다'), tool('Bash'), tool('Read')];
    const folded = foldLiveTurn(messages, false);

    expect(folded.rows).toEqual(messages);
    expect(folded.hiddenCount).toBe(0);
    expect(folded.foldAtIndex).toBe(-1);
  });

  it('keeps only the most recent tool calls once they pile up', () => {
    const messages = [
      tool('Bash1'), tool('Bash2'), tool('Bash3'), tool('Bash4'), tool('Bash5'), tool('Bash6'),
    ];
    const folded = foldLiveTurn(messages, false);

    expect(folded.rows).toHaveLength(LIVE_TOOL_TAIL);
    expect(folded.rows.map((row) => row.toolName)).toEqual(['Bash4', 'Bash5', 'Bash6']);
    expect(folded.hiddenCount).toBe(3);
    // 접은 것이 맨 앞이므로 접힘 줄도 맨 앞에 선다.
    expect(folded.foldAtIndex).toBe(0);
  });

  it('never folds away what the participant said', () => {
    const messages = [
      text('먼저 호출부를 봅니다'),
      tool('Bash1'), tool('Bash2'), tool('Bash3'),
      text('여기가 문제였습니다'),
      tool('Bash4'), tool('Bash5'),
    ];
    const folded = foldLiveTurn(messages, false);

    // 도구는 최근 셋만 남고 말은 둘 다 남는다. 남은 것끼리의 순서는 그대로다 —
    // 어떤 말 뒤에 어떤 호출이 왔는지가 흐름을 읽는 단서다.
    expect(folded.rows.map((row) => row.content ?? row.toolName))
      .toEqual(['먼저 호출부를 봅니다', 'Bash3', '여기가 문제였습니다', 'Bash4', 'Bash5']);
    expect(folded.hiddenCount).toBe(2);
    // 접은 두 호출이 있던 자리, 곧 남긴 첫 말 바로 뒤에 접힘 줄이 선다.
    expect(folded.foldAtIndex).toBe(1);
  });

  it('shows everything once the user expands it', () => {
    const messages = [tool('a'), tool('b'), tool('c'), tool('d'), tool('e')];
    const folded = foldLiveTurn(messages, true);

    expect(folded.rows).toEqual(messages);
    expect(folded.hiddenCount).toBe(0);
  });
});
