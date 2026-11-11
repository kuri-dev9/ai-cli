import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { i18n } from '@/modules/i18n';
import type { ChatMessage, Project } from '@/shared/types';
import type * as ApiModule from '@/shared/api';
import SessionSettingsModal from '@/modules/chat/modals/SessionSettingsModal';

const calls: Array<{ name: string; args: unknown[] }> = [];

vi.mock('@/shared/api', async (importOriginal) => {
  const actual = await importOriginal<typeof ApiModule>();
  const ok = (data: unknown) => Promise.resolve(new Response(JSON.stringify({ success: true, data }), { status: 200 }));
  return {
    ...actual,
    api: {
      ...actual.api,
      sessionSettings: () => ok({ autoCompactEveryTurns: 0, autoCompactTokens: 0, turnsSinceCompact: 4 }),
      updateSessionSettings: (...args: unknown[]) => {
        calls.push({ name: 'updateSessionSettings', args });
        return ok({ autoCompactEveryTurns: 10, autoCompactTokens: 0, turnsSinceCompact: 4 });
      },
      renameSession: (...args: unknown[]) => {
        calls.push({ name: 'renameSession', args });
        return ok({});
      },
      projects: () => Promise.resolve(new Response(JSON.stringify([
        { projectId: 'p-1', displayName: '지금 프로젝트', fullPath: '/work/now' },
        { projectId: 'p-2', displayName: '다른 프로젝트', fullPath: '/work/other' },
      ]), { status: 200 })),
    },
  };
});

const project = { projectId: 'p-1', displayName: '지금 프로젝트', fullPath: '/work/now', path: '/work/now' } as Project;
const messages: ChatMessage[] = [
  { type: 'user', content: '봐 줘', timestamp: 1, files: [{ path: '/assets/a.txt', name: 'a.txt', size: 10 }] },
  { type: 'user', content: '또', timestamp: 2, files: [{ path: '/assets/a.txt', name: 'a.txt', size: 10 }, { path: '/assets/b.md', name: 'b.md' }] },
];

let initialLanguage = 'en';
beforeAll(async () => {
  initialLanguage = i18n.language;
  await i18n.changeLanguage('ko');
});
afterAll(async () => {
  await i18n.changeLanguage(initialLanguage);
});

function renderModal(overrides: Partial<Parameters<typeof SessionSettingsModal>[0]> = {}) {
  const onSelectPermissionMode = vi.fn();
  render(
    <SessionSettingsModal
      open
      onOpenChange={() => {}}
      sessionId="s-1"
      sessionName="원래 이름"
      provider="claude"
      providerLabel="Claude"
      model="opus"
      project={project}
      permissionMode="default"
      permissionModes={['default', 'acceptEdits', 'plan']}
      onSelectPermissionMode={onSelectPermissionMode}
      supportsMove
      isProcessing={false}
      messages={messages}
      allMessagesLoaded
      {...overrides}
    />,
  );
  return { onSelectPermissionMode };
}

describe('SessionSettingsModal', () => {
  it('이름·위치·권한·자동 압축·오간 첨부를 한 창에 보여 준다', async () => {
    renderModal();

    expect(screen.getByDisplayValue('원래 이름')).toBeTruthy();
    expect(screen.getByText('/work/now')).toBeTruthy();
    // 옮길 곳에는 지금 프로젝트가 빠진다.
    await waitFor(() => expect(screen.getByRole('option', { name: '다른 프로젝트' })).toBeTruthy());
    expect(screen.queryByRole('option', { name: '지금 프로젝트' })).toBeNull();
    // 같은 첨부는 한 번만 센다.
    expect(screen.getByText('오간 첨부 (2)')).toBeTruthy();
    await waitFor(() => expect(screen.getAllByRole('slider')).toHaveLength(2));
    expect(screen.getAllByText('끔').length).toBe(2);
  });

  it('슬라이더는 놓을 때 한 번만 저장하고, 권한과 이름도 그 자리에서 바꾼다', async () => {
    const { onSelectPermissionMode } = renderModal();
    calls.length = 0;

    const [everyTurns] = await screen.findAllByRole('slider');
    fireEvent.change(everyTurns, { target: { value: '5' } });
    fireEvent.change(everyTurns, { target: { value: '10' } });
    expect(calls).toHaveLength(0);
    fireEvent.pointerUp(everyTurns);
    await waitFor(() => expect(calls).toEqual([{ name: 'updateSessionSettings', args: ['s-1', { autoCompactEveryTurns: 10, autoCompactTokens: undefined }] }]));

    fireEvent.click(screen.getByRole('button', { name: /acceptEdits|수락|편집/ }));
    expect(onSelectPermissionMode).toHaveBeenCalledWith('acceptEdits');

    fireEvent.change(screen.getByDisplayValue('원래 이름'), { target: { value: '새 이름' } });
    fireEvent.click(screen.getByRole('button', { name: '저장' }));
    await waitFor(() => expect(calls.at(-1)).toEqual({ name: 'renameSession', args: ['s-1', '새 이름'] }));
  });

  it('/compact 를 모르는 프로바이더에는 슬라이더 대신 안내를 보인다', () => {
    renderModal({ provider: 'cursor', providerLabel: 'Cursor', supportsMove: false });
    expect(screen.queryAllByRole('slider')).toHaveLength(0);
    expect(screen.getByText(/Cursor 은\(는\) \/compact/)).toBeTruthy();
    expect(screen.getByText(/다른 프로젝트로 옮길 수 없습니다/)).toBeTruthy();
  });
});
