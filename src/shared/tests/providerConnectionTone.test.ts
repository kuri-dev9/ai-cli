import { describe, expect, it } from 'vitest';

import { PROVIDER_CONNECTION_TONES } from '@/shared/constants';
import type { ProviderAuthStatus } from '@/shared/types';
import { readProviderConnectionTone } from '@/shared/utils';

const authStatus = (overrides: Partial<ProviderAuthStatus> = {}): ProviderAuthStatus => ({
  authenticated: false,
  email: null,
  method: null,
  error: null,
  loading: false,
  ...overrides,
});

describe('readProviderConnectionTone', () => {
  it('연결 여부를 색 하나로 줄인다', () => {
    expect(readProviderConnectionTone(authStatus({ authenticated: true }))).toBe('connected');
    expect(readProviderConnectionTone(authStatus())).toBe('disconnected');
    expect(readProviderConnectionTone(authStatus({ loading: true }))).toBe('checking');
  });

  it('이상이 있으면 연결돼 있어도 이상으로 읽는다', () => {
    const broken = authStatus({ authenticated: true, error: 'CLI not found' });

    expect(readProviderConnectionTone(broken)).toBe('error');
  });
});

describe('PROVIDER_CONNECTION_TONES', () => {
  it('상태마다 색이 하나씩 있고, 연결·끊김·이상은 서로 다르다', () => {
    const connected = PROVIDER_CONNECTION_TONES.connected;
    const disconnected = PROVIDER_CONNECTION_TONES.disconnected;
    const error = PROVIDER_CONNECTION_TONES.error;

    expect(new Set([connected.dotClass, disconnected.dotClass, error.dotClass]).size).toBe(3);
    // 확인 중은 아직 아무것도 주장하지 않으므로 끊김과 같은 중립색을 쓴다.
    expect(PROVIDER_CONNECTION_TONES.checking).toEqual(disconnected);
  });
});
