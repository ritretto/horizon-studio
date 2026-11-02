import { spawn, type ChildProcess } from 'node:child_process';
import { connect, createServer } from 'node:net';
import type { SshTarget } from '@horizon/protocol';

export interface Tunnel {
  /** Локальный порт, проброшенный на порт Agent на удалённой машине. */
  port: number;
  close(): void;
}

// Туннели не должны пережить Studio-сервер.
const running = new Set<ChildProcess>();
process.on('exit', () => running.forEach((p) => p.kill()));

/**
 * Поднимает `ssh -L` до Agent системным ssh (ключи, ssh-agent и ~/.ssh/config пользователя работают как обычно).
 * Резолвится, когда туннель принимает соединения; отклоняется с последней строкой ошибки ssh.
 * `onExit` вызывается, если туннель упал после установки.
 */
export async function openTunnel(ssh: SshTarget, agentPort: number, knownHosts: string, onExit: () => void): Promise<Tunnel> {
  const port = await freePort();
  const args = [
    '-N',
    '-L', `127.0.0.1:${port}:127.0.0.1:${agentPort}`,
    '-o', 'ExitOnForwardFailure=yes',
    '-o', 'BatchMode=yes', // без интерактивных вопросов: пароль, passphrase
    '-o', 'ConnectTimeout=10',
    '-o', 'ServerAliveInterval=15',
    '-o', 'ServerAliveCountMax=3',
    // Свой known_hosts рядом с конфигом Studio; ключ нового хоста запоминается при первом подключении.
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
  proc.on('error', (e) => (stderr += e.message)); // нет ssh в PATH; за ним приходит close
  proc.on('close', () => {
    exited = true;
    running.delete(proc);
  });

  // ssh не сообщает о готовности — ждём, пока локальный порт начнёт принимать соединения.
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
