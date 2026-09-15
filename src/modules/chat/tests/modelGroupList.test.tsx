import { describe, expect, it, vi } from 'vitest';
import React, { useState } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';

import '@/modules/i18n';
import ModelGroupList, { type ModelGroup } from '@/modules/chat/composer/ModelGroupList';
import { Command, CommandInput, CommandList } from '@/shared/ui';
import type { LLMProvider } from '@/shared/types';

// cmdk 는 목록 높이를 ResizeObserver 로 따라가는데 jsdom 에는 그것이 없다.
// 여기서 보는 것은 어떤 줄이 그려지는가이지 높이가 아니므로, 아무 일도 하지 않는
// 관찰자면 충분하다.
if (typeof globalThis.ResizeObserver === 'undefined') {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
}

// cmdk 는 선택된 줄을 보이게 하려고 scrollIntoView 를 부른다. jsdom 에는 그것도
// 없고, 레이아웃이 없는 곳에서 스크롤은 의미가 없으므로 빈 함수로 둔다.
if (typeof Element.prototype.scrollIntoView !== 'function') {
  Element.prototype.scrollIntoView = function scrollIntoView() {};
}

// ProviderSelectionEmptyState 가 Command 에 넘기는 필터와 같은 규칙. 그 모듈은
// 전사 화면 하나를 통째로 끌고 오므로 여기서는 같은 동작만 다시 적는다.
function modelSearchFilter(value: string, search: string): number {
  const haystack = value.toLowerCase();
  const tokens = search.toLowerCase().split(/\s+/).filter(Boolean);
  return tokens.every((token) => haystack.includes(token)) ? 1 : 0;
}

const model = (value: string, label: string) => ({ value, label });

const ALL_GROUPS: ModelGroup[] = [
  {
    key: 'claude',
    provider: 'claude',
    name: 'Anthropic',
    models: [model('claude-opus-4', 'Claude Opus 4'), model('claude-haiku-4', 'Claude Haiku 4')],
  },
  { key: 'codex', provider: 'codex', name: 'OpenAI', models: [model('gpt-5.1', 'GPT-5.1')] },
  { key: 'cursor', provider: 'cursor', name: 'Cursor', models: [model('composer-1', 'Composer 1')] },
  { key: 'opencode', provider: 'opencode', name: 'OpenCode', models: [] },
];

function Picker({
  groups = ALL_GROUPS,
  provider = 'claude' as LLMProvider,
  currentModel = 'claude-opus-4',
  loading = false,
  onSelect = () => {},
}) {
  const [search, setSearch] = useState('');
  return (
    <Command filter={modelSearchFilter}>
      <CommandInput value={search} onValueChange={setSearch} placeholder="Search models..." />
      <CommandList>
        <ModelGroupList
          groups={groups}
          provider={provider}
          currentModel={currentModel}
          loading={loading}
          searching={search.trim().length > 0}
          onSelect={onSelect}
          loadingLabel="Loading models…"
        />
      </CommandList>
    </Command>
  );
}

const typeSearch = (query: string) => {
  fireEvent.change(screen.getByPlaceholderText('Search models...'), { target: { value: query } });
};

/** 접는 줄인지(= cmdk 항목인지) 확인한다. 헤딩은 항목이 아니다. */
const providerRow = (name: string) => screen.getByText(name).closest('[cmdk-item]');

describe('model picker branches', () => {
  it('opens only the current provider and leaves the others one click away', () => {
    render(<Picker />);

    expect(screen.getByText('Claude Opus 4')).toBeTruthy();
    expect(screen.getByText('Claude Haiku 4')).toBeTruthy();
    expect(screen.queryByText('GPT-5.1')).toBeNull();
    expect(screen.queryByText('Composer 1')).toBeNull();

    // 접혀 있어도 provider 는 저마다 한 줄을 차지한다 — 그래야 다른 AI 가 있다는
    // 사실이 보이고, 그 줄을 누를 수 있다.
    for (const name of ['Anthropic', 'OpenAI', 'Cursor', 'OpenCode']) {
      expect(providerRow(name)).not.toBeNull();
    }
  });

  it('keeps the model count on every branch, open or not', () => {
    render(<Picker />);

    expect(providerRow('Anthropic')?.textContent).toContain('2');
    expect(providerRow('OpenAI')?.textContent).toContain('1');
    expect(providerRow('OpenCode')?.textContent).toContain('0');
  });

  it('shows one branch at a time: opening another closes the previous one', () => {
    render(<Picker />);

    fireEvent.click(screen.getByText('OpenAI'));

    expect(screen.getByText('GPT-5.1')).toBeTruthy();
    expect(screen.queryByText('Claude Opus 4')).toBeNull();
  });

  it('closes the open branch when it is clicked again, and keeps it closed', () => {
    render(<Picker />);

    fireEvent.click(screen.getByText('Anthropic'));

    expect(screen.queryByText('Claude Opus 4')).toBeNull();
    expect(providerRow('Anthropic')).not.toBeNull();
  });

  it('selects a model from a branch the user just opened', () => {
    const onSelect = vi.fn();
    render(<Picker onSelect={onSelect} />);

    fireEvent.click(screen.getByText('Cursor'));
    fireEvent.click(screen.getByText('Composer 1'));

    expect(onSelect).toHaveBeenCalledWith('cursor', 'composer-1');
  });

  it('leaves a provider with no models unclickable instead of opening an empty branch', () => {
    render(<Picker />);

    expect(providerRow('OpenCode')?.getAttribute('data-disabled')).toBe('true');
  });

  it('finds models inside closed branches while searching', () => {
    render(<Picker />);

    // 검색 전에는 Anthropic 만 열려 있으므로, 이 결과는 닫힌 branch 안에 있다.
    expect(screen.queryByText('GPT-5.1')).toBeNull();

    typeSearch('gpt');

    expect(screen.getByText('GPT-5.1')).toBeTruthy();
    expect(screen.queryByText('Claude Opus 4')).toBeNull();
    // 검색 중에는 접는 줄 대신 헤딩만 남는다 — 누를 것이 없는 줄이 결과를 가리지 않는다.
    expect(providerRow('OpenAI')).toBeNull();
  });

  it('matches a provider name across every branch, not just the open one', () => {
    render(<Picker />);

    typeSearch('cursor');

    expect(screen.getByText('Composer 1')).toBeTruthy();
    expect(screen.queryByText('Claude Opus 4')).toBeNull();
  });

  it('returns to the one-open-branch view when the search is cleared', () => {
    render(<Picker />);

    typeSearch('gpt');
    typeSearch('');

    expect(screen.getByText('Claude Opus 4')).toBeTruthy();
    expect(screen.queryByText('GPT-5.1')).toBeNull();
  });

  it('skips the collapsing row when only one CLI is turned on', () => {
    render(<Picker groups={[ALL_GROUPS[0]]} />);

    expect(screen.getByText('Claude Opus 4')).toBeTruthy();
    // 하나뿐이면 접을 이유가 없다: provider 는 헤딩으로만 남고 클릭할 줄이 없다.
    expect(providerRow('Anthropic')).toBeNull();
    expect(screen.getByText('Anthropic').textContent).toContain('2');
  });

  it('reports that models are still loading in the branch it opened', () => {
    render(<Picker groups={[{ ...ALL_GROUPS[0], models: [] }]} loading />);

    expect(screen.getByText('Loading models…')).toBeTruthy();
  });
});
