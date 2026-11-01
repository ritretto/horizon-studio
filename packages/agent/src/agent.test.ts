import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import WebSocket from 'ws';
import { startAgent } from './agent.ts';

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
