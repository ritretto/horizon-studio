import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
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

test('первый старт выдаёт admin-токен, по нему работает agent.info, чужой токен отклоняется', async () => {
  const home = mkdtempSync(join(tmpdir(), 'horizon-agent-'));
  const { server, adminToken } = await startAgent(home, 0);
  const { port } = server.address() as AddressInfo;
  assert.ok(adminToken);
  assert.ok(!readFileSync(join(home, 'members.json'), 'utf8').includes(adminToken), 'токен не хранится открыто');

  const ws = await connect(port, adminToken);
  ws.send(JSON.stringify({ type: 'request', id: 1, method: 'agent.info' }));
  const data = await new Promise<WebSocket.RawData>((r) => ws.once('message', r));
  const res = JSON.parse(String(data));
  assert.equal(res.id, 1);
  assert.equal(res.result.member.accessLevel, 'admin');
  ws.close();

  await assert.rejects(connect(port, 'wrong'), /401/);

  // Повторный старт на том же Agent Home не создаёт нового admin.
  server.close();
  const again = await startAgent(home, 0);
  assert.equal(again.adminToken, undefined);
  again.server.close();
});

/** Фейковый Engine: отвечает эхом и запоминает, с каким resume его запустили. */
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

test('Task: создание, Session с историей по seq, продолжение после перезапуска Agent', async () => {
  const home = mkdtempSync(join(tmpdir(), 'horizon-agent-'));
  const a1 = await startAgent(home, 0, echo);
  const c1 = client(await connect((a1.server.address() as AddressInfo).port, a1.adminToken!));

  const task: Task = await c1.call('task.create', { name: 'OAuth' });
  const sessionId = task.sessions[0].id;
  await c1.call('session.subscribe', { sessionId, fromSeq: 0 });
  await c1.call('session.send', { sessionId, text: 'привет' });
  const events = await c1.until(3);
  assert.deepEqual(events.map((e) => [e.seq, e.item.kind]), [[1, 'user'], [2, 'text'], [3, 'turn_end']]);
  assert.deepEqual(events[1].item, { kind: 'text', text: 'echo: привет' });
  c1.close();
  a1.server.close();

  // Новый процесс Agent на том же Agent Home: Task на месте, история с seq, Engine продолжает разговор.
  const a2 = await startAgent(home, 0, echo);
  const c2 = client(await connect((a2.server.address() as AddressInfo).port, a1.adminToken!));
  assert.equal((await c2.call('task.list')).length, 1);
  await c2.call('session.subscribe', { sessionId, fromSeq: 1 });
  assert.deepEqual((await c2.until(2)).map((e) => e.seq), [2, 3]);
  await c2.call('session.send', { sessionId, text: 'ещё' });
  assert.equal((await c2.until(4))[3].seq, 5);
  assert.deepEqual(resumes, [undefined, 'engine-session-1']);
  c2.close();
  a2.server.close();
});
