import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { codexEnvironment, createCodexEngine } from './codex.ts';
import type { SessionItem } from '@horizon/protocol';

test('app-server does not inherit desktop launch context or mutate caller environment', () => {
  const source = {
    PATH: 'path', CODEX_HOME: 'custom-home', CODEX_ACCESS_TOKEN: 'test-token',
    CODEX_WINDOWS_REGISTERED_CORE: 'parent-core', CODEX_APP_RUNTIME_CLI_PATH: 'parent-cli',
    CODEX_APP_TOOLS_PIPE_PATH: 'parent-pipe', CODEX_PERMISSION_PROFILE: 'parent-profile',
    CODEX_THREAD_ID: 'parent-thread', CODEX_SHELL: 'parent-shell',
  };
  assert.deepEqual(codexEnvironment(source), {
    PATH: 'path', CODEX_HOME: 'custom-home', CODEX_ACCESS_TOKEN: 'test-token',
  });
  assert.equal(source.CODEX_THREAD_ID, 'parent-thread');
});

const server = `
  const { createInterface } = require('node:readline');
  const scenario = process.argv[1];
  const write = (message) => console.log(JSON.stringify(message));
  createInterface({ input: process.stdin }).on('line', (line) => {
    const { id, method, params, error } = JSON.parse(line);
    const reply = (result) => write({ id, result });
    const notify = (method, params) => write({ method, params });
    switch (method) {
      case 'initialize': return reply({});
      case 'initialized': return;
      case 'account/read':
        return reply({ account: scenario === 'ready' ? { type: 'chatgpt' } : null,
          requiresOpenaiAuth: scenario !== 'external' });
      case 'thread/start':
      case 'thread/resume': return reply({ thread: { id: params.threadId ?? 'thread-1' } });
      case 'turn/start':
        if (scenario === 'crash') return process.exit(1);
        if (scenario === 'malformed') return console.log('invalid json');
        reply({ turn: { id: 'turn-1' } });
        if (scenario === 'unsupported') {
          return write({ id: 'unsupported', method: 'unknown/request', params: {} });
        }
        if (scenario === 'error') return notify('turn/completed', {
          turn: { status: 'failed', error: { message: 'Test failure' } },
        });
        if (scenario === 'interrupted') return notify('turn/completed', { turn: { status: 'interrupted' } });
        notify('item/completed', { item: { type: 'agentMessage', id: 'answer', text: 'fallback' } });
        return notify('turn/completed', { turn: { status: 'completed' } });
      default:
        if (id !== 'unsupported' || error?.code !== -32601) return process.exit(2);
        notify('turn/completed', { turn: { status: 'completed' } });
    }
  });
`;

function engineFor(scenario: string) {
  return createCodexEngine(() => spawn(process.execPath, ['-e', server, scenario]));
}

test('Codex status distinguishes credentials, external provider, and missing executable', async () => {
  assert.equal(await engineFor('ready').status!(), 'ready');
  assert.equal(await engineFor('noCredentials').status!(), 'no credentials');
  assert.equal(await engineFor('external').status!(), 'ready');
  const missing = createCodexEngine(() => spawn('horizon-missing-codex-executable-12345', []));
  assert.equal(await missing.status!(), 'not installed');
});

for (const [scenario, error] of [
  ['error', 'Test failure'], ['interrupted', 'interrupted'],
  ['crash', 'exited'], ['malformed', 'Invalid message'],
  ['unsupported', undefined], ['fallback', undefined],
] as const) {
  test(`Codex handles ${scenario}`, { timeout: 5_000 }, async (t) => {
    let launches = 0;
    const engine = createCodexEngine(() =>
      spawn(process.execPath, ['-e', server, launches++ === 0 ? scenario : 'fallback']));
    const items: SessionItem[] = [];
    let finish: (() => void) | undefined;
    const run = engine({
      cwd: process.cwd(), onEngineSessionId: () => {},
      askPermission: async () => { throw new Error('Unknown request must not ask for permission'); },
      onItem: (item) => {
        items.push(item);
        if (item.kind === 'turn_end') finish?.();
      },
    });
    t.after(() => run.close());
    await new Promise<void>((resolve) => { finish = resolve; run.send('first'); });
    const end = items.at(-1);
    assert.equal(end?.kind, 'turn_end');
    if (end?.kind !== 'turn_end') return;
    if (error) assert.ok(end.error?.includes(error), end.error);
    else assert.equal(end.error, undefined);
    if (scenario === 'crash' || scenario === 'malformed') {
      items.length = 0;
      await new Promise<void>((resolve) => { finish = resolve; run.send('retry'); });
      assert.deepEqual(items, [{ kind: 'text', text: 'fallback' }, { kind: 'turn_end' }]);
      assert.equal(launches, 2);
    }
  });
}

test('synchronous launch errors finish the turn and permit retry', async () => {
  const engine = createCodexEngine(() => { throw new Error('Invalid launch configuration'); });
  assert.equal(await engine.status!(), 'unavailable');
  const items: SessionItem[] = [];
  const run = engine({
    cwd: process.cwd(), onItem: (item) => items.push(item), onEngineSessionId: () => {},
    askPermission: async () => ({ allow: false, always: false }),
  });
  run.send('first');
  run.send('retry');
  assert.deepEqual(items, [
    { kind: 'turn_end', error: 'Invalid launch configuration' },
    { kind: 'turn_end', error: 'Invalid launch configuration' },
  ]);
  run.close();
});
