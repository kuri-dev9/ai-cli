import { describe, expect, it } from 'vitest';

import { applyMention, filterMentionCandidates, findMentionQuery } from '@/modules/rooms/utils/roomMentions';

describe('room mentions', () => {
  it('finds the mention being typed at the caret', () => {
    expect(findMentionQuery('@설', 2)).toEqual({ start: 0, query: '설' });
    expect(findMentionQuery('hi @rev', 7)).toEqual({ start: 3, query: 'rev' });
    expect(findMentionQuery('hi @', 4)).toEqual({ start: 3, query: '' });
  });

  it('ignores @ inside words and finished mentions', () => {
    expect(findMentionQuery('mail@example', 12)).toBeNull();
    expect(findMentionQuery('@리뷰어 봐줘', 8)).toBeNull();
  });

  it('filters candidates by case-insensitive prefix', () => {
    expect(filterMentionCandidates(['Reviewer', '설계자', 'reader'], 're')).toEqual(['Reviewer', 'reader']);
    expect(filterMentionCandidates(['Reviewer', '설계자'], '')).toEqual(['Reviewer', '설계자']);
  });

  it('replaces the partial mention with the chosen name', () => {
    const text = '이거 @리 확인';
    const mention = findMentionQuery(text, 5)!;
    expect(applyMention(text, 5, mention, '리뷰어')).toEqual({ text: '이거 @리뷰어 확인', caret: 8 });
  });
});
