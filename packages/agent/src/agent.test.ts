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
  const a1 = await startAgent(home, 0, { engine: echo });
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
  const a2 = await startAgent(home, 0, { engine: echo });
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

/** Фейковый Engine: на каждое сообщение просит разрешение на Bash и сообщает решение. */
const asker: Engine = ({ onItem, askPermission }) => ({
  send: async () => {
    const { allow, always } = await askPermission({ tool: 'Bash', input: { command: 'ls' } });
    onItem({ kind: 'text', text: allow ? `allowed${always ? ' always' : ''}` : 'denied' });
    onItem({ kind: 'turn_end' });
  },
  close: () => {},
});

test('Permission Mode: ask ждёт ответа пользователя, auto разрешает сам', async () => {
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
  assert.equal(await c.call('session.answer', { sessionId: askSession, requestId, allow: true }), undefined, 'повторный ответ отклоняется');

  const auto: Task = await c.call('task.create', { name: 'auto' });
  assert.equal(auto.permissionMode, 'auto', 'по умолчанию — из конфига Agent');
  await c.call('session.subscribe', { sessionId: auto.sessions[0].id, fromSeq: 0 });
  await c.call('session.send', { sessionId: auto.sessions[0].id, text: 'go' });
  const autoEvents = (await c.until(8)).slice(5);
  assert.deepEqual(autoEvents.map((e) => e.item.kind), ['user', 'text', 'turn_end']);
  assert.deepEqual(autoEvents[1].item, { kind: 'text', text: 'allowed' });

  c.close();
  a.server.close();
});

test('Пауза останавливает Engine посреди хода, переживает перезапуск, продолжение просит Engine доделать', async () => {
  const log: string[] = [];
  const slow: Engine = ({ resume, onItem, onEngineSessionId }) => {
    log.push(`start resume=${resume}`);
    onEngineSessionId('conv-1');
    return {
      send: (text) => {
        log.push(`send ${text.slice(0, 15)}`);
        setImmediate(() => onItem({ kind: 'text', text: 'работаю…' })); // ход не заканчивается
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
  await c1.call('session.send', { sessionId, text: 'делай' });
  await c1.until(2);

  assert.equal((await c1.call('task.pause', { taskId: task.id })).state, 'paused');
  assert.deepEqual((await c1.until(3))[2].item, { kind: 'status', status: 'paused' });
  assert.equal(await c1.call('session.send', { sessionId, text: 'ещё' }), undefined, 'на паузе сообщения не принимаются');
  c1.close();
  a1.server.close();

  // После перезапуска Agent Task остаётся на паузе и сама не продолжается.
  const a2 = await startAgent(home, 0, { engine: slow });
  const c2 = client(await connect((a2.server.address() as AddressInfo).port, a1.adminToken!));
  assert.equal((await c2.call('task.list'))[0].state, 'paused');
  assert.deepEqual(log, ['start resume=undefined', 'send делай', 'close']);

  await c2.call('session.subscribe', { sessionId, fromSeq: 3 });
  assert.equal((await c2.call('task.resume', { taskId: task.id })).state, 'active');
  const events = await c2.until(3);
  assert.deepEqual(events[0].item, { kind: 'status', status: 'resumed' });
  assert.equal(events[1].item.kind, 'user');
  assert.deepEqual(log.slice(3), ['start resume=conv-1', 'send [HorizonStudio]']);
  c2.close();
  a2.server.close();
});

test('Завершение, переоткрытие, удаление вручную и по сроку хранения', async () => {
  const home = mkdtempSync(join(tmpdir(), 'horizon-agent-'));
  const a1 = await startAgent(home, 0, { engine: echo });
  const c1 = client(await connect((a1.server.address() as AddressInfo).port, a1.adminToken!));
  const kept: Task = await c1.call('task.create', { name: 'kept' });
  const doomed: Task = await c1.call('task.create', { name: 'doomed' });
  const sessionId = kept.sessions[0].id;
  await c1.call('session.subscribe', { sessionId, fromSeq: 0 });

  assert.equal(await c1.call('task.delete', { taskId: kept.id }), undefined, 'активную Task удалить нельзя');
  const done: Task = await c1.call('task.complete', { taskId: kept.id });
  assert.equal(done.state, 'completed');
  assert.equal(Date.parse(done.deleteAt!) - Date.parse(done.completedAt!), 30 * 24 * 60 * 60 * 1000);
  assert.deepEqual((await c1.until(1))[0].item, { kind: 'status', status: 'completed' });
  assert.equal(await c1.call('session.send', { sessionId, text: 'x' }), undefined, 'завершённая не принимает сообщения');
  assert.equal(await c1.call('task.pause', { taskId: kept.id }), undefined, 'из completed — только reopen');

  const reopened: Task = await c1.call('task.reopen', { taskId: kept.id });
  assert.equal(reopened.state, 'paused');
  assert.equal(reopened.deleteAt, undefined);
  assert.equal((await c1.call('task.resume', { taskId: kept.id })).state, 'active');

  await c1.call('task.complete', { taskId: doomed.id });
  assert.equal(await c1.call('task.delete', { taskId: doomed.id }), null);
  assert.ok(!existsSync(join(home, 'tasks', doomed.id)), 'каталог Task удалён');
  assert.deepEqual((await c1.call('task.list')).map((t: Task) => t.name), ['kept']);

  await c1.call('task.complete', { taskId: kept.id });
  c1.close();
  a1.server.close();

  // Срок хранения 0 дней — Agent удаляет завершённую Task при старте.
  const a2 = await startAgent(home, 0, { engine: echo, completedRetentionDays: 0 });
  const c2 = client(await connect((a2.server.address() as AddressInfo).port, a1.adminToken!));
  assert.deepEqual(await c2.call('task.list'), []);
  assert.ok(!existsSync(join(home, 'tasks', kept.id)));
  c2.close();
  a2.server.close();
});
