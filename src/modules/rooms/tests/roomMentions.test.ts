import { describe, expect, it } from 'vitest';

import {
  applyMention,
  filterMentionCandidates,
  findMentionQuery,
  splitByMentions,
} from '@/modules/rooms/utils/roomMentions';

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

  it('splits text so each mention can be tinted on its own', () => {
    const names = ['에스터', '메이커'];
    expect(splitByMentions('@에스터 2번 테스트 먼저', names)).toEqual([
      { text: '@에스터', mentionedName: '에스터' },
      { text: ' 2번 테스트 먼저', mentionedName: null },
    ]);
    // 한 줄에 여럿을 불러도 각자 제 이름으로 잡힌다.
    expect(splitByMentions('@메이커 와 @에스터', names)).toEqual([
      { text: '@메이커', mentionedName: '메이커' },
      { text: ' 와 ', mentionedName: null },
      { text: '@에스터', mentionedName: '에스터' },
    ]);
  });

  it('leaves alone what is not a participant mention', () => {
    const names = ['빌더', '빌더2'];
    // 메일 주소의 @ 는 부르는 말이 아니다.
    expect(splitByMentions('mail@빌더 보내줘', names)).toEqual([
      { text: 'mail@빌더 보내줘', mentionedName: null },
    ]);
    // 명단에 없는 이름도 그냥 글자다.
    expect(splitByMentions('@없는사람 불러', names)).toEqual([
      { text: '@없는사람 불러', mentionedName: null },
    ]);
    // 앞부분이 겹치면 긴 이름이 이긴다.
    expect(splitByMentions('@빌더2 고쳐', names)).toEqual([
      { text: '@빌더2', mentionedName: '빌더2' },
      { text: ' 고쳐', mentionedName: null },
    ]);
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
