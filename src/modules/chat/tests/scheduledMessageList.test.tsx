import { fireEvent, render, screen, within } from '@testing-library/react';
import React from 'react';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { ScheduledMessagesPanel, ScheduledMessagesTrigger } from '@/modules/chat/composer/ScheduledMessageList';
import { i18n } from '@/modules/i18n';
import type { ScheduledMessage } from '@/shared/types';

const initialLanguage = i18n.language;
beforeAll(async () => {
  await i18n.changeLanguage('ko');
  await i18n.loadNamespaces('chat');
});
afterAll(async () => {
  await i18n.changeLanguage(initialLanguage);
});

const at = (minutesFromNow: number) => new Date(Date.now() + minutesFromNow * 60_000);
// 분의 시작에 맞춘다. 그냥 30분 뒤로 두면 실행 시각이 몇 분 55초 이후일 때 5초 뒤 예약이
// 다음 분으로 넘어가 묶음이 갈라졌다 — 전체 실행에서 가끔 실패하던 원인이다.
const sameMinute = (() => {
  const base = at(30);
  base.setSeconds(0, 0);
  return base;
})();
const message = (id: string, when: Date, content: string, status: ScheduledMessage['status'] = 'pending'): ScheduledMessage => ({
  id, sessionId: 's', content, options: {}, scheduledFor: when.toISOString(), status, failureReason: status === 'failed' ? '세션 없음' : null, createdAt: '',
});

describe('ScheduledMessages', () => {
  const messages = () => [
    message('a', sameMinute, '첫째'),
    message('b', new Date(sameMinute.getTime() + 5_000), '둘째'),
    message('c', at(90), '셋째'),
    message('d', at(-5), '실패한 것', 'failed'),
    message('e', at(10), '보낸 것', 'sent'),
  ];

  it('shows the count, the next slot and failures on the toolbar trigger', () => {
    const onToggle = vi.fn();
    render(React.createElement(ScheduledMessagesTrigger, { scheduledMessages: messages(), open: false, onToggle }));
    const trigger = screen.getByRole('button', { name: /예약 3/ });
    expect(trigger.textContent).toMatch(/실패 1/);
    fireEvent.click(trigger);
    expect(onToggle).toHaveBeenCalled();
  });

  it('groups schedules by time slot in the panel, failures first', () => {
    const onCancel = vi.fn();
    render(React.createElement(ScheduledMessagesPanel, { scheduledMessages: messages(), onCancel, onClose: vi.fn() }));
    const panel = screen.getByRole('dialog', { name: '예약 3개' });
    const sections = within(panel).getAllByRole('heading', { level: 4 });
    // 실패 묶음이 먼저, 그다음 시각 순. 같은 분의 두 예약은 한 칸에 묶인다.
    expect(sections.map((heading) => heading.textContent)).toEqual([
      '전송 안 됨',
      expect.stringMatching(/· 2$/),
      expect.not.stringMatching(/·/),
    ]);
    expect(within(panel).queryByText('보낸 것')).toBeNull();

    fireEvent.click(within(panel).getAllByRole('button', { name: '예약 취소' })[0]);
    expect(onCancel).toHaveBeenCalledWith('a');
  });

  it('renders nothing when nothing is waiting', () => {
    const { container } = render(React.createElement(ScheduledMessagesTrigger, {
      scheduledMessages: [message('e', at(10), '보낸 것', 'sent')], open: false, onToggle: vi.fn(),
    }));
    expect(container.firstChild).toBeNull();
  });
});
