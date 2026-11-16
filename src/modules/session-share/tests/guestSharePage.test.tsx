import assert from 'node:assert/strict';

import { afterEach, beforeEach, test, vi } from 'vitest';
import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';

import '@/modules/i18n';
import { GuestSharePage, readShareTokenFromPath } from '@/modules/session-share';
import { readAppBasePath } from '@/modules/session-share/guestApi';

/**
 * 공유 링크로 들어온 게스트 화면.
 *
 * 게스트는 로그인 없이 들어온다. 그래서 (1) 요청에 주인의 로그인 토큰이 실리면
 * 안 되고, (2) 끊긴 링크면 대화 대신 안내가 나와야 하며, (3) 질문을 보내면
 * 실행이 끝날 때까지 따라가다 끝나면 기록을 다시 읽어야 한다.
 */

const TOKEN = 'abcdefghijklmnopqrstuvwxyz012345';

type Handler = (url: string, init?: RequestInit) => { status: number; body: unknown };
let handler: Handler;
const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
  const { status, body } = handler(String(input), init);
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
});

const snapshot = (overrides: Record<string, unknown> = {}) => ({
  title: '버그 조사',
  expiresAt: null,
  messages: [
    { id: 'm1', kind: 'text', role: 'user', content: '이 버그 봐줘', timestamp: '2026-11-14T00:00:00Z' },
    { id: 'm2', kind: 'tool', toolName: 'Read', detail: 'src/app.ts', timestamp: '2026-11-14T00:00:01Z' },
    { id: 'm3', kind: 'text', role: 'assistant', content: '원인은 **캐시**입니다.', timestamp: '2026-11-14T00:00:02Z' },
  ],
  hasMore: false,
  isProcessing: false,
  runKey: null,
  lastSeq: 0,
  awaitingApproval: false,
  ...overrides,
});

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockClear();
  // 같은 브라우저에 주인의 로그인 토큰이 남아 있는 상황.
  localStorage.setItem('auth-token', 'owner-secret-token');
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  localStorage.clear();
});

test('주소에서 토큰과 앱 기준 경로를 읽는다', () => {
  assert.equal(readShareTokenFromPath(`/share/${TOKEN}`), TOKEN);
  assert.equal(readShareTokenFromPath(`/ai/share/${TOKEN}/`), TOKEN);
  assert.equal(readShareTokenFromPath('/session/abc'), null);
  assert.equal(readShareTokenFromPath('/share/short'), null);
  assert.equal(readAppBasePath(`/ai/share/${TOKEN}`), '/ai');
  assert.equal(readAppBasePath(`/share/${TOKEN}`), '');
});

test('기록을 그리고, 요청에는 로그인 토큰을 싣지 않는다', async () => {
  handler = () => ({ status: 200, body: snapshot() });
  render(React.createElement(GuestSharePage, { token: TOKEN }));

  await screen.findByText('버그 조사');
  await screen.findByText('이 버그 봐줘');
  await screen.findByText('캐시');
  await screen.findByText('src/app.ts');

  const [url, init] = fetchMock.mock.calls[0];
  assert.equal(String(url), `/api/share/${TOKEN}`);
  const headers = (init?.headers ?? {}) as Record<string, string>;
  assert.equal(headers.Authorization, undefined);
  assert.equal(init?.credentials, 'omit');
});

test('끊긴 링크면 대화 대신 안내가 나온다', async () => {
  handler = () => ({ status: 404, body: { success: false, error: { code: 'SHARE_NOT_FOUND', message: 'gone' } } });
  render(React.createElement(GuestSharePage, { token: TOKEN }));

  await screen.findByText('열 수 없는 링크입니다');
  assert.equal(screen.queryByRole('textbox'), null);
});

test('질문을 보내면 실행을 따라가고, 끝나면 기록을 다시 읽는다', async () => {
  let phase: 'idle' | 'running' | 'done' = 'idle';
  const sent: unknown[] = [];

  handler = (url, init) => {
    if (init?.method === 'POST') {
      sent.push(JSON.parse(String(init.body)));
      phase = 'running';
      return { status: 202, body: { accepted: true } };
    }
    if (url.includes('/events')) {
      if (phase === 'running') {
        phase = 'done';
        return {
          status: 200,
          body: {
            isProcessing: true,
            runKey: 'run-1',
            lastSeq: 2,
            awaitingApproval: true,
            events: [
              { id: 'local_1', kind: 'text', role: 'user', content: '고쳐줘', timestamp: '', source: 'share' },
              { kind: 'delta', content: '고치는 중' },
            ],
          },
        };
      }
      return { status: 200, body: { isProcessing: false, runKey: 'run-1', lastSeq: 5, awaitingApproval: false, events: [] } };
    }
    return {
      status: 200,
      body: phase === 'done'
        ? snapshot({
          runKey: 'run-1',
          lastSeq: 5,
          messages: [
            { id: 'q', kind: 'text', role: 'user', content: '고쳐줘', timestamp: '', source: 'share' },
            { id: 'a', kind: 'text', role: 'assistant', content: '다 고쳤습니다.', timestamp: '' },
          ],
        })
        : snapshot(),
    };
  };

  render(React.createElement(GuestSharePage, { token: TOKEN }));
  const input = await screen.findByRole('textbox');

  fireEvent.change(input, { target: { value: '고쳐줘' } });
  fireEvent.keyDown(input, { key: 'Enter' });

  await waitFor(() => assert.deepEqual(sent, [{ content: '고쳐줘' }]));
  // 보낸 질문은 바로 보인다.
  await screen.findByText('고쳐줘');

  // 실행 중: 써지는 중인 답과 승인 대기 안내.
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1_100);
  });
  await screen.findByText('고치는 중');
  await screen.findByText(/작업 승인을 기다리는 중입니다/);
  // 보내던 질문은 실행 스트림에 나타난 줄로 바뀐다. 두 번 보이지 않는다.
  assert.equal(screen.getAllByText('고쳐줘').length, 1);

  // 실행이 끝나면 기록을 다시 읽는다.
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1_100);
  });
  await screen.findByText('다 고쳤습니다.');
  assert.equal(screen.queryByText('고치는 중'), null);
  assert.equal(screen.getAllByText('고쳐줘').length, 1);
});

test('작업 중이라 거절되면 그렇게 알린다', async () => {
  handler = (_url, init) => (init?.method === 'POST'
    ? { status: 409, body: { success: false, error: { code: 'SHARE_SESSION_BUSY', message: 'busy' } } }
    : { status: 200, body: snapshot() });

  render(React.createElement(GuestSharePage, { token: TOKEN }));
  const input = await screen.findByRole('textbox');
  fireEvent.change(input, { target: { value: '하나 더' } });
  fireEvent.click(screen.getByRole('button', { name: '보내기' }));

  await screen.findByText('지금 다른 작업이 진행 중입니다. 끝난 뒤에 다시 보내 주세요.');
  // 거절된 질문은 입력창에 남아 다시 보낼 수 있다.
  assert.equal((input as HTMLTextAreaElement).value, '하나 더');
});
