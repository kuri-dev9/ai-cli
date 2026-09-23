import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { Codex } from '@openai/codex-sdk';
import type { Thread, ThreadOptions } from '@openai/codex-sdk';

import { codexRuntime } from '@/modules/providers/list/codex/codex-runtime.provider.js';
import { createNormalizedMessage } from '@/shared/index.js';
import type { ProviderRuntimeContext } from '@/shared/index.js';

for (const resumed of [false, true]) {
  for (const permissionMode of [undefined, 'default', 'unknown', 'acceptEdits', 'bypassPermissions']) {
    test(`Codex ${resumed ? 'resumes' : 'starts'} with supported permissions (${permissionMode ?? 'omitted'})`, async (t) => {
      let capturedOptions: ThreadOptions | undefined;
      let capturedPrompt: unknown;
      const messages: unknown[] = [];
      const thread = {
        id: 'native-thread',
        async runStreamed(prompt: unknown) {
          capturedPrompt = prompt;
          return { events: (async function* () {
            yield { type: 'thread.started', thread_id: 'native-thread' };
          })() };
        },
      } as unknown as Thread;

      const start = t.mock.method(Codex.prototype, 'startThread', (options?: ThreadOptions) => {
        capturedOptions = options;
        return thread;
      });
      const resume = t.mock.method(Codex.prototype, 'resumeThread', (id: string, options?: ThreadOptions) => {
        assert.equal(id, 'native-thread');
        capturedOptions = options;
        return thread;
      });
      const context: ProviderRuntimeContext = {
        resolveProviderSessionId: () => resumed ? 'native-thread' : null,
        resolveResumeModel: async () => 'test-model',
        getProviderModels: async () => ({ OPTIONS: [], DEFAULT: 'test-model' }),
        normalizeMessage: () => [],
        isProviderInstalled: async () => true,
      };

      await codexRuntime.run('hey there', {
        sessionId: resumed ? 'app-session' : undefined,
        permissionMode,
        cwd: process.cwd(),
      }, { isWebSocketWriter: true, send: (message) => messages.push(message) }, context);

      assert.equal(start.mock.callCount(), resumed ? 0 : 1);
      assert.equal(resume.mock.callCount(), resumed ? 1 : 0);
      assert.equal(capturedPrompt, 'hey there');
      assert.equal(capturedOptions?.sandboxMode, permissionMode === 'bypassPermissions' ? 'danger-full-access' : 'workspace-write');
      assert.equal(capturedOptions?.approvalPolicy, permissionMode === 'acceptEdits' || permissionMode === 'bypassPermissions' ? 'never' : 'on-request');
      assert.ok(messages.some((message: any) => message.kind === 'complete' && message.exitCode === 0));
      assert.ok(!messages.some((message: any) => message.kind === 'error'));
    });
  }
}

// image_gen leaves no item in the exec JSON stream, so the run has to notice
// the file it saved. The picture must be reported before the reply that
// follows it, and a file from an earlier turn must not be reported again.
test('Codex reports an image image_gen saved during the run, ahead of the reply', async (t) => {
  const tempHome = await mkdtemp(path.join(os.tmpdir(), 'codex-image-run-'));
  const imagesDir = path.join(tempHome, '.codex', 'generated_images', 'native-thread');
  await mkdir(imagesDir, { recursive: true });
  const stalePath = path.join(imagesDir, 'exec-old.png');
  await writeFile(stalePath, 'old');
  const staleTime = new Date(Date.now() - 60_000);
  await utimes(stalePath, staleTime, staleTime);

  const originalHomedir = os.homedir;
  (os as any).homedir = () => tempHome;

  const messages: any[] = [];
  const freshPath = path.join(imagesDir, 'exec-new.png');
  const thread = {
    id: 'native-thread',
    async runStreamed() {
      return { events: (async function* () {
        yield { type: 'thread.started', thread_id: 'native-thread' };
        await writeFile(freshPath, 'new');
        await writeFile(path.join(imagesDir, 'notes.txt'), 'not an image');
        yield { type: 'item.completed', item: { id: 'item_2', type: 'agent_message', text: 'Drew a circle.' } };
        yield { type: 'turn.completed', usage: {} };
      })() };
    },
  } as unknown as Thread;
  t.mock.method(Codex.prototype, 'startThread', () => thread);

  const context: ProviderRuntimeContext = {
    resolveProviderSessionId: () => null,
    resolveResumeModel: async () => 'test-model',
    getProviderModels: async () => ({ OPTIONS: [], DEFAULT: 'test-model' }),
    normalizeMessage: (raw: any) => raw.itemType === 'agent_message'
      ? [createNormalizedMessage({ provider: 'codex', kind: 'text', role: 'assistant', content: raw.message.content, sessionId: 'native-thread' })]
      : [],
    isProviderInstalled: async () => true,
  };

  try {
    await codexRuntime.run('draw a circle', { cwd: process.cwd() }, { isWebSocketWriter: true, send: (message) => messages.push(message) }, context);
  } finally {
    (os as any).homedir = originalHomedir;
    await rm(tempHome, { recursive: true, force: true });
  }

  const texts = messages.filter((message) => message.kind === 'text');
  assert.deepEqual(texts.map((message) => message.content), ['', 'Drew a circle.']);
  assert.deepEqual(texts[0].images, [{ path: freshPath.replace(/\\/g, '/'), name: 'exec-new.png', mimeType: 'image/png' }]);
  assert.equal(messages.filter((message) => Array.isArray(message.images)).length, 1, 'each picture is reported once');
});
