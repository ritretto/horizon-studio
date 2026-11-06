import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, copyFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { AgentStatus } from '@horizon/protocol';
import { startAgent } from '@horizon/agent';
import { AgentLink } from './agent-link.ts';

const sshd = '/usr/sbin/sshd';

test('Connection through an SSH tunnel: connects, survives a drop, reports an ssh error', { skip: !existsSync(sshd) && 'no sshd', timeout: 30_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'horizon-ssh-'));
  const key = (name: string) => (execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', join(dir, name)]), join(dir, name));
  const hostKey = key('host_key');
  const clientKey = key('client_key');
  const wrongKey = key('wrong_key');
  copyFileSync(`${clientKey}.pub`, join(dir, 'authorized_keys'));
  const sshPort = 20000 + Math.floor(Math.random() * 20000);
  writeFileSync(
    join(dir, 'sshd_config'),
    [`Port ${sshPort}`, 'ListenAddress 127.0.0.1', `HostKey ${hostKey}`, `AuthorizedKeysFile ${dir}/authorized_keys`, `PidFile ${dir}/sshd.pid`,
      'PasswordAuthentication no', 'KbdInteractiveAuthentication no', 'UsePAM no', 'StrictModes no', 'AllowTcpForwarding yes'].join('\n'),
  );
  const startSshd = () => spawn(sshd, ['-D', '-e', '-f', join(dir, 'sshd_config')], { stdio: 'ignore' });
  let server = startSshd();

  const agent = await startAgent(mkdtempSync(join(tmpdir(), 'horizon-agent-')), 0, { engine: () => ({ send() {}, close() {} }) });
  const port = (agent.server.address() as AddressInfo).port;
  const watch = (link: () => AgentLink) => (pred: (s: AgentStatus) => boolean) =>
    new Promise<AgentStatus>((resolve) => {
      const check = () => (pred(link().status) ? resolve(link().status) : setTimeout(check, 50));
      check();
    });

  const conn = { id: 'r', name: 'remote', port, token: agent.adminToken!, ssh: { host: '127.0.0.1', port: sshPort, key: clientKey } };
  const link: AgentLink = new AgentLink(conn, join(dir, 'known_hosts'), () => {}, () => {});
  const until = watch(() => link);
  await until((s) => s.state === 'online');
  assert.ok(existsSync(join(dir, 'known_hosts')), 'the host key is saved in the Studio known_hosts file');

  // Drop: sshd and its sessions are killed; Studio sees offline and reconnects by itself when sshd returns.
  spawnSync('pkill', ['-P', String(server.pid)]); // sshd sessions, including our tunnel
  server.kill();
  await until((s) => s.state === 'offline');
  server = startSshd();
  await until((s) => s.state === 'online');
  link.close();

  const bad: AgentLink = new AgentLink({ ...conn, ssh: { ...conn.ssh, key: wrongKey } }, join(dir, 'known_hosts'), () => {}, () => {});
  const failed = await watch(() => bad)((s) => !!s.error);
  assert.match(failed.error!, /^ssh: .*Permission denied/);
  bad.close();

  server.kill();
  agent.stop();
});
