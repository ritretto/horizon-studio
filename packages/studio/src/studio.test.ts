import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import WebSocket from 'ws';
import type { AgentStatus, AgentsEvent, Response } from '@horizon/protocol';
import { startAgent } from '@horizon/agent';
import { startStudio } from './studio.ts';

const tmp = () => mkdtempSync(join(tmpdir(), 'horizon-studio-'));
const portOf = (s: { address(): unknown }) => (s.address() as AddressInfo).port;

test('Studio connects to the Agent through a Connection, shows status and relays requests', async () => {
  const agent = await startAgent(tmp(), 0, { engine: () => ({ send() {}, close() {} }) });
  const configFile = join(tmp(), 'config.json');
  const studio = await startStudio(configFile, 0);

  const browser = new WebSocket(`ws://127.0.0.1:${portOf(studio)}/ws`);
  const messages: (AgentsEvent | Response)[] = [];
  const waitFor = <T>(pred: (m: any) => boolean) =>
    new Promise<T>((resolve) => {
      const check = () => {
        const m = messages.find(pred);
        if (m) resolve(m as T);
        else setTimeout(check, 10);
      };
      check();
    });
  browser.on('message', (d) => messages.push(JSON.parse(String(d))));
  await new Promise((r) => browser.once('open', r));

  const send = (id: number, method: string, params?: unknown, agentId?: string) =>
    browser.send(JSON.stringify({ type: 'request', id, method, params, agentId }));
  const agentWith = (state: AgentStatus['state']) => (m: any) => m.type === 'agents' && m.agents.some((a: AgentStatus) => a.state === state);

  send(1, 'connection.add', { name: 'local', port: portOf(agent.server), token: agent.adminToken });
  const { result } = await waitFor<{ result: { id: string } }>((m) => m.id === 1);
  const online = await waitFor<AgentsEvent>(agentWith('online'));
  assert.equal(online.agents[0].hello?.member.accessLevel, 'admin');
  assert.equal(online.agents[0].hello?.version, '0.1.0');
  assert.equal(online.agents[0].hello?.engines[0].status, 'ready');
  assert.ok(readFileSync(configFile, 'utf8').includes(agent.adminToken!), 'the Connection is saved to the config');

  send(2, 'agent.info', undefined, result.id);
  const relayed = await waitFor<Response>((m) => m.id === 2);
  assert.ok('result' in relayed);

  send(3, 'connection.add', { name: 'bad', port: portOf(agent.server), token: 'wrong' });
  await waitFor(agentWith('unauthorized'));

  browser.close();
  agent.server.close();
  studio.close();
});
