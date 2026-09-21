import { describe, expect, it } from 'vitest';

import {
  createMcpPayloadFromForm,
  mergeApiKeyHeader,
  readApiKeyHeader,
} from '@/modules/mcp/utils/mcpFormatting';
import type { McpFormState } from '@/shared/types';

const createFormState = (overrides: Partial<McpFormState>): McpFormState => ({
  name: 'query_forge',
  scope: 'user',
  workspacePath: '',
  transport: 'http',
  command: '',
  args: [],
  env: {},
  cwd: '',
  url: 'http://127.0.0.1:31571/mcp',
  headers: {},
  apiKey: '',
  envVars: [],
  bearerTokenEnvVar: '',
  envHttpHeaders: {},
  importMode: 'form',
  jsonInput: '',
  ...overrides,
});

describe('readApiKeyHeader', () => {
  it('reads a lone API key header regardless of how it was cased on disk', () => {
    expect(readApiKeyHeader({ 'x-api-key': 'abc' })).toBe('abc');
    expect(readApiKeyHeader({ 'X-API-Key': 'abc' })).toBe('abc');
    expect(readApiKeyHeader({ 'X-Api-Key': 'abc' })).toBe('abc');
  });

  it('declines anything the simple field cannot round-trip', () => {
    // Bearer-authenticated servers must keep going through the advanced
    // textarea, so they must not be collapsed into the API Key field.
    expect(readApiKeyHeader({ Authorization: 'Bearer token' })).toBeUndefined();
    expect(readApiKeyHeader({ 'x-api-key': 'abc', 'X-Tenant': 'acme' })).toBeUndefined();
    expect(readApiKeyHeader({})).toBeUndefined();
    expect(readApiKeyHeader(undefined)).toBeUndefined();
  });
});

describe('mergeApiKeyHeader', () => {
  it('adds the API key when the advanced headers do not set one', () => {
    expect(mergeApiKeyHeader({ 'X-Tenant': 'acme' }, 'abc')).toEqual({
      'X-Tenant': 'acme',
      'x-api-key': 'abc',
    });
  });

  it('lets an advanced header win over the API Key field, whatever its casing', () => {
    expect(mergeApiKeyHeader({ 'X-API-Key': 'from-advanced' }, 'from-field')).toEqual({
      'X-API-Key': 'from-advanced',
    });
  });

  it('leaves the headers untouched when the API Key field is blank', () => {
    expect(mergeApiKeyHeader({ Authorization: 'Bearer token' }, '   ')).toEqual({
      Authorization: 'Bearer token',
    });
  });
});

describe('createMcpPayloadFromForm', () => {
  it('sends the API key as a header for http servers', () => {
    const payload = createMcpPayloadFromForm('claude', createFormState({ apiKey: 'abc' }));
    expect(payload.headers).toEqual({ 'x-api-key': 'abc' });
  });

  it('keeps Bearer servers working through the advanced headers', () => {
    const payload = createMcpPayloadFromForm(
      'claude',
      createFormState({ headers: { Authorization: 'Bearer token' } }),
    );
    expect(payload.headers).toEqual({ Authorization: 'Bearer token' });
  });

  it('drops env for http servers, which no provider persists', () => {
    const payload = createMcpPayloadFromForm(
      'claude',
      createFormState({ env: { API_KEY: 'abc' } }),
    );
    expect(payload.env).toBeUndefined();
  });

  it('still sends env for stdio servers', () => {
    const payload = createMcpPayloadFromForm(
      'claude',
      createFormState({ transport: 'stdio', command: 'npx', env: { API_KEY: 'abc' } }),
    );
    expect(payload.env).toEqual({ API_KEY: 'abc' });
    expect(payload.headers).toBeUndefined();
  });
});
