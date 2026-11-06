import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { query, Query, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { createClaudeEngine } from './engine.ts';
import type { SessionItem } from '@horizon/protocol';

for (const failure of ['exception', 'result'] as const) {
  test(`Claude ${failure} signals exit; a new instance receives the saved conversation ID`, { timeout: 5_000 }, async () => {
    let launches = 0;
    const resumes: (string | undefined)[] = [];
    const runQuery = (({ prompt, options }) => {
      const launch = ++launches;
      resumes.push(options?.resume);
      assert.notEqual(typeof prompt, 'string');
      const messages = (async function* () {
        if (typeof prompt === 'string') return;
        for await (const _ of prompt) {
          yield { type: 'system', subtype: 'init', session_id: 'claude-thread' } as SDKMessage;
          if (launch === 1) {
            if (failure === 'exception') throw new Error('SDK process died');
            yield { type: 'result', subtype: 'error_during_execution' } as SDKMessage;
          } else {
            yield { type: 'result', subtype: 'success' } as SDKMessage;
          }
        }
      })();
      return Object.assign(messages, { close() { void messages.return(); } }) as unknown as Query;
    }) as typeof query;
    const engine = createClaudeEngine(runQuery);
    const items: SessionItem[] = [];
    let resume: string | undefined;
    let exit!: () => void;
    let ended = new Promise<void>((resolve) => { exit = resolve; });
    const opts = () => ({
      cwd: process.cwd(), permissionMode: 'ask' as const, resume,
      onItem: (item: SessionItem) => items.push(item),
      onExit: () => exit(), onEngineSessionId: (id: string) => { resume = id; },
      askPermission: async () => ({ allow: false, always: false }),
    });
    const first = engine(opts());
    first.send('first');
    await ended;
    assert.equal(items.at(-1)?.kind, 'turn_end');
    assert.ok(items.at(-1)?.kind === 'turn_end' && 'error' in items.at(-1)!);
    first.close();
    ended = new Promise<void>((resolve) => { exit = resolve; });
    const second = engine(opts());
    second.send('retry');
    // The successful streaming process remains open for the next message.
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(resumes, [undefined, 'claude-thread']);
    assert.deepEqual(items.at(-1), { kind: 'turn_end' });
    second.close();
  });
}
