import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import WebSocket from 'ws';
import type { SessionEvent, Task } from '@horizon/protocol';
import { startAgent } from './agent.ts';
import type { Engine } from './engine.ts';

function connect(port: number, token: string) {
  return new Promise<WebSocket>((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`, { headers: { authorization: `Bearer ${token}` } });
    ws.once('open', () => resolve(ws));
    ws.once('unexpected-response', (_req, res) => reject(new Error(String(res.statusCode))));
  });
}

test('first start issues an admin token, agent.info works with it, an unknown token is rejected', async () => {
  const home = mkdtempSync(join(tmpdir(), 'horizon-agent-'));
  const noCredentials: Engine = Object.assign(() => ({ send() {}, close() {} }), { status: async () => 'no credentials' as const });
  const { server, adminToken } = await startAgent(home, 0, { engine: noCredentials });
  const { port } = server.address() as AddressInfo;
  assert.ok(adminToken);
  assert.ok(!readFileSync(join(home, 'members.json'), 'utf8').includes(adminToken), 'the token is not stored in plain text');

  const ws = await connect(port, adminToken);
  ws.send(JSON.stringify({ type: 'request', id: 1, method: 'agent.info' }));
  const data = await new Promise<WebSocket.RawData>((r) => ws.once('message', r));
  const res = JSON.parse(String(data));
  assert.equal(res.id, 1);
  assert.equal(res.result.member.accessLevel, 'admin');
  assert.deepEqual(res.result.engines, [{ id: 'claude-code', status: 'no credentials' }]);
  ws.close();

  await assert.rejects(connect(port, 'wrong'), /401/);

  // Starting again on the same Agent Home does not create a new admin.
  server.close();
  const again = await startAgent(home, 0, { engine: noCredentials });
  assert.equal(again.adminToken, undefined);
  again.server.close();
});

/** Fake Engine: echoes back and remembers which resume value it was started with. */
const resumes: (string | undefined)[] = [];
const echo: Engine = ({ resume, onItem, onEngineSessionId }) => {
  resumes.push(resume);
  onEngineSessionId('engine-session-1');
  return {
    send: (text) => setImmediate(() => (onItem({ kind: 'text', text: `echo: ${text}` }), onItem({ kind: 'turn_end' }))),
    close: () => {},
  };
};

function client(ws: WebSocket) {
  let id = 0;
  const events: SessionEvent[] = [];
  const pending = new Map<number, (r: any) => void>();
  ws.on('message', (d) => {
    const m = JSON.parse(String(d));
    if (m.type === 'event') events.push(m);
    else pending.get(m.id)?.(m);
  });
  const call = (method: string, params?: unknown) =>
    new Promise<any>((r) => {
      pending.set(++id, r);
      ws.send(JSON.stringify({ type: 'request', id, method, params }));
    }).then((m) => m.result);
  const until = async (n: number) => {
    while (events.length < n) await new Promise((r) => setTimeout(r, 5));
    return events;
  };
  return { call, until, close: () => ws.close() };
}

test('Task: creation, Session with history by seq, continuing after an Agent restart', async () => {
  const home = mkdtempSync(join(tmpdir(), 'horizon-agent-'));
  const a1 = await startAgent(home, 0, { engine: echo });
  const c1 = client(await connect((a1.server.address() as AddressInfo).port, a1.adminToken!));

  const task: Task = await c1.call('task.create', { name: 'OAuth' });
  const sessionId = task.sessions[0].id;
  await c1.call('session.subscribe', { sessionId, fromSeq: 0 });
  await c1.call('session.send', { sessionId, text: 'hello' });
  const events = await c1.until(3);
  assert.deepEqual(events.map((e) => [e.seq, e.item.kind]), [[1, 'user'], [2, 'text'], [3, 'turn_end']]);
  assert.deepEqual(events[1].item, { kind: 'text', text: 'echo: hello' });
  c1.close();
  a1.server.close();

  // New Agent process on the same Agent Home: the Task is there, history keeps its seq, the Engine continues the conversation.
  const a2 = await startAgent(home, 0, { engine: echo });
  const c2 = client(await connect((a2.server.address() as AddressInfo).port, a1.adminToken!));
  assert.equal((await c2.call('task.list')).length, 1);
  await c2.call('session.subscribe', { sessionId, fromSeq: 1 });
  assert.deepEqual((await c2.until(2)).map((e) => e.seq), [2, 3]);
  await c2.call('session.send', { sessionId, text: 'more' });
  assert.equal((await c2.until(4))[3].seq, 5);
  assert.deepEqual(resumes, [undefined, 'engine-session-1']);
  c2.close();
  a2.server.close();
});

/** Fake Engine: asks for permission to run Bash on every message and reports the decision. */
const asker: Engine = ({ onItem, askPermission }) => ({
  send: async () => {
    const { allow, always } = await askPermission({ tool: 'Bash', input: { command: 'ls' } });
    onItem({ kind: 'text', text: allow ? `allowed${always ? ' always' : ''}` : 'denied' });
    onItem({ kind: 'turn_end' });
  },
  close: () => {},
});

test('Permission Mode: ask waits for the user, auto allows on its own', async () => {
  const home = mkdtempSync(join(tmpdir(), 'horizon-agent-'));
  const a = await startAgent(home, 0, { engine: asker, defaultPermissionMode: 'auto' });
  const c = client(await connect((a.server.address() as AddressInfo).port, a.adminToken!));

  const ask: Task = await c.call('task.create', { name: 'ask', permissionMode: 'ask' });
  assert.equal(ask.permissionMode, 'ask');
  const askSession = ask.sessions[0].id;
  await c.call('session.subscribe', { sessionId: askSession, fromSeq: 0 });
  await c.call('session.send', { sessionId: askSession, text: 'go' });
  const [, request] = await c.until(2);
  assert.equal(request.item.kind, 'permission');
  const requestId = (request.item as { requestId: string }).requestId;
  await c.call('session.answer', { sessionId: askSession, requestId, allow: true, always: true });
  const events = await c.until(5);
  assert.deepEqual(events.slice(2).map((e) => e.item), [
    { kind: 'permission_answer', requestId, allow: true, always: true },
    { kind: 'text', text: 'allowed always' },
    { kind: 'turn_end' },
  ]);
  assert.equal(await c.call('session.answer', { sessionId: askSession, requestId, allow: true }), undefined, 'a repeated answer is rejected');

  const auto: Task = await c.call('task.create', { name: 'auto' });
  assert.equal(auto.permissionMode, 'auto', 'the default comes from the Agent config');
  await c.call('session.subscribe', { sessionId: auto.sessions[0].id, fromSeq: 0 });
  await c.call('session.send', { sessionId: auto.sessions[0].id, text: 'go' });
  const autoEvents = (await c.until(8)).slice(5);
  assert.deepEqual(autoEvents.map((e) => e.item.kind), ['user', 'text', 'turn_end']);
  assert.deepEqual(autoEvents[1].item, { kind: 'text', text: 'allowed' });

  c.close();
  a.server.close();
});

test('Pause stops the Engine mid-turn and survives a restart; resuming asks the Engine to finish', async () => {
  const log: string[] = [];
  const slow: Engine = ({ resume, onItem, onEngineSessionId }) => {
    log.push(`start resume=${resume}`);
    onEngineSessionId('conv-1');
    return {
      send: (text) => {
        log.push(`send ${text.slice(0, 15)}`);
        setImmediate(() => onItem({ kind: 'text', text: 'working…' })); // the turn never ends
      },
      close: () => log.push('close'),
    };
  };
  const home = mkdtempSync(join(tmpdir(), 'horizon-agent-'));
  const a1 = await startAgent(home, 0, { engine: slow });
  const c1 = client(await connect((a1.server.address() as AddressInfo).port, a1.adminToken!));
  const task: Task = await c1.call('task.create', { name: 'long' });
  const sessionId = task.sessions[0].id;
  await c1.call('session.subscribe', { sessionId, fromSeq: 0 });
  await c1.call('session.send', { sessionId, text: 'do it' });
  await c1.until(2);

  assert.equal((await c1.call('task.pause', { taskId: task.id })).state, 'paused');
  assert.deepEqual((await c1.until(3))[2].item, { kind: 'status', status: 'paused' });
  assert.equal(await c1.call('session.send', { sessionId, text: 'more' }), undefined, 'messages are not accepted while paused');
  c1.close();
  a1.server.close();

  // After an Agent restart the Task stays paused and does not continue on its own.
  const a2 = await startAgent(home, 0, { engine: slow });
  const c2 = client(await connect((a2.server.address() as AddressInfo).port, a1.adminToken!));
  assert.equal((await c2.call('task.list'))[0].state, 'paused');
  assert.deepEqual(log, ['start resume=undefined', 'send do it', 'close']);

  await c2.call('session.subscribe', { sessionId, fromSeq: 3 });
  assert.equal((await c2.call('task.resume', { taskId: task.id })).state, 'active');
  const events = await c2.until(3);
  assert.deepEqual(events[0].item, { kind: 'status', status: 'resumed' });
  assert.equal(events[1].item.kind, 'user');
  assert.deepEqual(log.slice(3), ['start resume=conv-1', 'send [HorizonStudio]']);
  c2.close();
  a2.server.close();
});

test('Completing, reopening, deleting manually and by retention period', async () => {
  const home = mkdtempSync(join(tmpdir(), 'horizon-agent-'));
  const a1 = await startAgent(home, 0, { engine: echo });
  const c1 = client(await connect((a1.server.address() as AddressInfo).port, a1.adminToken!));
  const kept: Task = await c1.call('task.create', { name: 'kept' });
  const doomed: Task = await c1.call('task.create', { name: 'doomed' });
  const sessionId = kept.sessions[0].id;
  await c1.call('session.subscribe', { sessionId, fromSeq: 0 });

  assert.equal(await c1.call('task.delete', { taskId: kept.id }), undefined, 'an active Task cannot be deleted');
  const done: Task = await c1.call('task.complete', { taskId: kept.id });
  assert.equal(done.state, 'completed');
  assert.equal(Date.parse(done.deleteAt!) - Date.parse(done.completedAt!), 30 * 24 * 60 * 60 * 1000);
  assert.deepEqual((await c1.until(1))[0].item, { kind: 'status', status: 'completed' });
  assert.equal(await c1.call('session.send', { sessionId, text: 'x' }), undefined, 'a completed Task does not accept messages');
  assert.equal(await c1.call('task.pause', { taskId: kept.id }), undefined, 'from completed, only reopen is allowed');

  const reopened: Task = await c1.call('task.reopen', { taskId: kept.id });
  assert.equal(reopened.state, 'paused');
  assert.equal(reopened.deleteAt, undefined);
  assert.equal((await c1.call('task.resume', { taskId: kept.id })).state, 'active');

  await c1.call('task.complete', { taskId: doomed.id });
  assert.equal(await c1.call('task.delete', { taskId: doomed.id }), null);
  assert.ok(!existsSync(join(home, 'tasks', doomed.id)), 'the Task directory is deleted');
  assert.deepEqual((await c1.call('task.list')).map((t: Task) => t.name), ['kept']);

  await c1.call('task.complete', { taskId: kept.id });
  c1.close();
  a1.server.close();

  // With a retention period of 0 days, the Agent deletes a completed Task at startup.
  const a2 = await startAgent(home, 0, { engine: echo, completedRetentionDays: 0 });
  const c2 = client(await connect((a2.server.address() as AddressInfo).port, a1.adminToken!));
  assert.deepEqual(await c2.call('task.list'), []);
  assert.ok(!existsSync(join(home, 'tasks', kept.id)));
  c2.close();
  a2.server.close();
});

test('After an Agent restart interrupted Sessions continue on their own, paused Tasks do not', async () => {
  const starts: string[] = [];
  // "ask" hangs on a permission request; otherwise the turn never ends.
  const stuck: Engine = ({ resume, onItem, onEngineSessionId, askPermission }) => {
    onEngineSessionId(`conv-${starts.length}`);
    starts.push(`resume=${resume}`);
    return {
      send: (text) => {
        if (text === 'ask') void askPermission({ tool: 'Bash', input: {} });
        else setImmediate(() => onItem({ kind: 'text', text: `got: ${text.slice(0, 15)}` }));
      },
      close: () => {},
    };
  };
  const home = mkdtempSync(join(tmpdir(), 'horizon-agent-'));
  const a1 = await startAgent(home, 0, { engine: stuck });
  const c1 = client(await connect((a1.server.address() as AddressInfo).port, a1.adminToken!));
  const working: Task = await c1.call('task.create', { name: 'working', permissionMode: 'ask' });
  const asking: Task = await c1.call('task.create', { name: 'asking', permissionMode: 'ask' });
  const paused: Task = await c1.call('task.create', { name: 'paused' });
  await c1.call('session.send', { sessionId: working.sessions[0].id, text: 'do it' });
  await c1.call('session.send', { sessionId: asking.sessions[0].id, text: 'ask' });
  await c1.call('session.send', { sessionId: paused.sessions[0].id, text: 'do it' });
  await c1.call('task.pause', { taskId: paused.id });
  await new Promise((r) => setTimeout(r, 20));
  c1.close();
  a1.server.close(); // a "crash": the Agent process disappears mid-turn

  const a2 = await startAgent(home, 0, { engine: stuck });
  const c2 = client(await connect((a2.server.address() as AddressInfo).port, a1.adminToken!));
  await c2.call('session.subscribe', { sessionId: working.sessions[0].id, fromSeq: 2 });
  const w = await c2.until(3);
  assert.deepEqual(w[0].item, { kind: 'status', status: 'interrupted' });
  assert.match((w[1].item as { text: string }).text, /^\[HorizonStudio\] Agent was restarted/);
  assert.deepEqual(w[2].item, { kind: 'text', text: 'got: [HorizonStudio]' });

  await c2.call('session.subscribe', { sessionId: asking.sessions[0].id, fromSeq: 2 });
  const q = (await c2.until(6)).slice(3);
  assert.equal(q[0].item.kind, 'permission_answer', 'the pending permission request is cleared');
  assert.deepEqual(q[1].item, { kind: 'status', status: 'interrupted' });

  assert.equal((await c2.call('task.list')).find((t: Task) => t.id === paused.id).state, 'paused');
  // 3 starts before the restart plus one for each of the two interrupted Sessions, all with resume.
  assert.deepEqual(starts.slice(3).sort(), ['resume=conv-0', 'resume=conv-1']);
  c2.close();
  a2.server.close();
});

test('Member: admin creates users and tokens, a user sees only their own Tasks, revoking a token closes the connection', async () => {
  const home = mkdtempSync(join(tmpdir(), 'horizon-agent-'));
  const a = await startAgent(home, 0, { engine: echo });
  const port = (a.server.address() as AddressInfo).port;
  const adminWs = await connect(port, a.adminToken!);
  const admin = client(adminWs);
  const { id: bobId, token: bobToken } = await admin.call('member.create', { name: 'bob', accessLevel: 'user' });
  const bobWs = await connect(port, bobToken);
  const bob = client(bobWs);
  assert.equal(await bob.call('member.list'), undefined, 'a user cannot manage Members');

  // The Agent sends each connection its own Task list when something changes.
  const lastTasks = (ws: WebSocket) => {
    let last: Task[] = [];
    ws.on('message', (d) => {
      const m = JSON.parse(String(d));
      if (m.type === 'tasks') last = m.tasks;
    });
    return () => last.map((t) => t.name).sort();
  };
  const adminSees = lastTasks(adminWs);
  const bobSees = lastTasks(bobWs);
  await admin.call('task.create', { name: 'admin task' });
  await bob.call('task.create', { name: 'bob task' });
  while (adminSees().length < 2 || bobSees().length < 1) await new Promise((r) => setTimeout(r, 5));
  assert.deepEqual(adminSees(), ['admin task', 'bob task']);
  assert.deepEqual(bobSees(), ['bob task']);
  assert.deepEqual((await bob.call('task.list')).map((t: Task) => t.name), ['bob task']);
  assert.deepEqual((await admin.call('task.list')).map((t: Task) => t.name).sort(), ['admin task', 'bob task']);

  const { token: bobToken2 } = await admin.call('member.issueToken', { memberId: bobId });
  const listed = await admin.call('member.list');
  const bobInfo = listed.find((m: any) => m.id === bobId);
  assert.equal(bobInfo.tokens.length, 2);
  assert.ok(!JSON.stringify(listed).includes('hash'), 'token hashes are not returned');

  const closed = new Promise((r) => bobWs.once('close', r));
  assert.equal(await admin.call('member.revokeToken', { memberId: bobId, tokenId: bobInfo.tokens[0].id }), null);
  await closed;
  await assert.rejects(connect(port, bobToken), /401/);
  client(await connect(port, bobToken2)).close();

  // The last admin token cannot be revoked.
  const adminInfo = listed.find((m: any) => m.accessLevel === 'admin');
  assert.equal(await admin.call('member.revokeToken', { memberId: adminInfo.id, tokenId: adminInfo.tokens[0].id }), undefined);
  admin.close();
  a.stop();
});

test('Agent Update: PUT /update installs the build and asks the Launcher to restart; admin only, and only under the Launcher', async () => {
  const home = mkdtempSync(join(tmpdir(), 'horizon-agent-'));
  let restarts = 0;
  const a = await startAgent(home, 0, { engine: echo, restart: () => restarts++ });
  const url = `http://127.0.0.1:${(a.server.address() as AddressInfo).port}/update`;
  const build = JSON.stringify({ package: { version: '9.9.9' }, agent: 'console.log("new")' });
  const put = (token: string) => fetch(url, { method: 'PUT', headers: { authorization: `Bearer ${token}` }, body: build });

  const admin = client(await connect((a.server.address() as AddressInfo).port, a.adminToken!));
  const { token: userToken } = await admin.call('member.create', { name: 'u', accessLevel: 'user' });
  admin.close();
  assert.equal((await put(userToken)).status, 403);

  const res = await put(a.adminToken!);
  const body = await res.json();
  assert.equal(body.status, 'restarting');
  assert.match(body.build, /^9\.9\.9-[0-9a-f]{8}$/);
  assert.equal(readFileSync(join(home, 'next'), 'utf8'), body.build);
  assert.equal(readFileSync(join(home, 'versions', body.build, 'agent.mjs'), 'utf8'), 'console.log("new")');
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(restarts, 1);
  a.stop();

  const plain = await startAgent(mkdtempSync(join(tmpdir(), 'horizon-agent-')), 0, { engine: echo });
  const r = await fetch(`http://127.0.0.1:${(plain.server.address() as AddressInfo).port}/update`, {
    method: 'PUT',
    headers: { authorization: `Bearer ${plain.adminToken}` },
    body: build,
  });
  assert.equal(r.status, 409, 'updating is not possible without the Launcher');
  plain.stop();
});
