import { spawn, type ChildProcess } from 'node:child_process';
import { connect, createServer } from 'node:net';
import type { SshTarget } from '@horizon/protocol';

export interface Tunnel {
  /** Local port forwarded to the Agent's port on the remote machine. */
  port: number;
  close(): void;
}

// Tunnels must not outlive the Studio server.
const running = new Set<ChildProcess>();
process.on('exit', () => running.forEach((p) => p.kill()));

/**
 * Opens `ssh -L` to the Agent with the system ssh (the user's keys, ssh-agent and ~/.ssh/config work as usual).
 * Resolves when the tunnel accepts connections; rejects with the last ssh error line.
 * `onExit` is called if the tunnel fails after being established.
 */
export async function openTunnel(ssh: SshTarget, agentPort: number, knownHosts: string, onExit: () => void): Promise<Tunnel> {
  const port = await freePort();
  const args = [
    '-N',
    '-L', `127.0.0.1:${port}:127.0.0.1:${agentPort}`,
    '-o', 'ExitOnForwardFailure=yes',
    '-o', 'BatchMode=yes', // no interactive prompts: password, passphrase
    '-o', 'ConnectTimeout=10',
    '-o', 'ServerAliveInterval=15',
    '-o', 'ServerAliveCountMax=3',
    // A separate known_hosts next to Studio's config; a new host key is saved on first connection.
    '-o', 'StrictHostKeyChecking=accept-new',
    '-o', `UserKnownHostsFile="${knownHosts}"`,
    ...(ssh.key ? ['-i', ssh.key, '-o', 'IdentitiesOnly=yes'] : []),
    ...(ssh.port ? ['-p', String(ssh.port)] : []),
    '--',
    ssh.user ? `${ssh.user}@${ssh.host}` : ssh.host,
  ];
  const proc = spawn('ssh', args, { stdio: ['ignore', 'ignore', 'pipe'] });
  running.add(proc);
  let stderr = '';
  proc.stderr!.on('data', (d) => (stderr += d));
  let exited = false;
  proc.on('error', (e) => (stderr += e.message)); // no ssh in PATH; close follows
  proc.on('close', () => {
    exited = true;
    running.delete(proc);
  });

  // ssh does not report readiness, so wait until the local port accepts connections.
  while (!(await accepts(port))) {
    if (exited) {
      const reason = stderr.trim().split('\n').filter((l) => !l.startsWith('Warning: Permanently added')).at(-1);
      throw new Error(`ssh: ${reason || 'tunnel closed'}`);
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  if (exited) throw new Error('ssh: tunnel closed');
  proc.on('close', onExit);
  return { port, close: () => proc.kill() };
}

function freePort() {
  return new Promise<number>((resolve, reject) => {
    const s = createServer().listen(0, '127.0.0.1', () => {
      const { port } = s.address() as { port: number };
      s.close(() => resolve(port));
    });
    s.on('error', reject);
  });
}

function accepts(port: number) {
  return new Promise<boolean>((resolve) => {
    const s = connect(port, '127.0.0.1');
    s.on('connect', () => (s.destroy(), resolve(true)));
    s.on('error', () => resolve(false));
  });
}
