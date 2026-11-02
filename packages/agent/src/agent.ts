import { createServer, type Server } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import type { AccessLevel, AgentHello, TasksEvent, AgentInfo, PermissionMode, Request, Response } from '@horizon/protocol';
import pkg from '../package.json' with { type: 'json' };
import { claudeCode, type Engine } from './engine.ts';
import { Members, type Member } from './members.ts';
import { Tasks } from './tasks.ts';

const info: AgentInfo = { version: pkg.version };

export interface StartedAgent {
  server: Server;
  /** Штатная остановка: закрывает процессы Engine и сервер. */
  stop(): void;
  /** Access Token первого admin, если Agent Home только что создан. */
  adminToken?: string;
}

export interface AgentOptions {
  engine?: Engine;
  /** Permission Mode для новых Task, если он не указан явно (из конфига Agent). */
  defaultPermissionMode?: PermissionMode;
  /** Через сколько дней завершённая Task удаляется безвозвратно. */
  completedRetentionDays?: number;
}

export function startAgent(home: string, port: number, opts: AgentOptions = {}): Promise<StartedAgent> {
  const members = new Members(home);
  const engine = opts.engine ?? claudeCode;
  const tasks = new Tasks(home, engine, opts.completedRetentionDays ?? 30);
  tasks.purge();
  tasks.recover();
  setInterval(() => tasks.purge(), 60 * 60 * 1000).unref();
  const defaultPermissionMode = opts.defaultPermissionMode ?? 'ask';
  const adminToken = members.isEmpty ? members.create('admin', 'admin').token : undefined;
  /** Открытые соединения: кто и по какому токену. Отзыв токена их закрывает. */
  const sockets = new Map<WebSocket, { member: Member; tokenId: string }>();
  // Каждому соединению — его список Task; несколько изменений за один тик — одно событие.
  let tasksChanged = false;
  tasks.onChange = () => {
    if (tasksChanged) return;
    tasksChanged = true;
    setImmediate(() => {
      tasksChanged = false;
      for (const [ws, { member }] of sockets) ws.send(JSON.stringify({ type: 'tasks', tasks: tasks.list(member) } satisfies TasksEvent));
    });
  };

  const server = createServer((req, res) => {
    if (req.url === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(info));
      return;
    }
    res.writeHead(404).end();
  });

  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => {
    const token = req.headers.authorization?.match(/^Bearer (.+)$/)?.[1];
    const auth = token && members.authenticate(token);
    if (!auth) {
      socket.end('HTTP/1.1 401 Unauthorized\r\n\r\n');
      return;
    }
    const { member, tokenId } = auth;
    wss.handleUpgrade(req, socket, head, (ws) => {
      sockets.set(ws, auth);
      const subscriptions = new Map<string, () => void>();
      ws.on('close', () => {
        sockets.delete(ws);
        subscriptions.forEach((unsubscribe) => unsubscribe());
      });
      ws.on('message', (data) => {
        let req: Request;
        try {
          req = JSON.parse(String(data));
        } catch {
          ws.close(1003, 'invalid JSON');
          return;
        }
        handle(req, { member, tokenId, members, sockets, engine, tasks, ws, subscriptions, defaultPermissionMode })
          .catch((e): Response => ({ type: 'response', id: req.id, error: { message: e instanceof Error ? e.message : String(e) } }))
          .then((res) => ws.send(JSON.stringify(res)));
      });
    });
  });

  const stop = () => {
    tasks.shutdown();
    server.close();
  };
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve({ server, adminToken, stop })));
}

interface Context {
  member: Member;
  tokenId: string;
  members: Members;
  sockets: Map<WebSocket, { member: Member; tokenId: string }>;
  engine: Engine;
  tasks: Tasks;
  ws: WebSocket;
  subscriptions: Map<string, () => void>;
  defaultPermissionMode: PermissionMode;
}

const permissionModes: PermissionMode[] = ['ask', 'auto'];
const accessLevels: AccessLevel[] = ['admin', 'user'];

async function handle(req: Request, { member, tokenId, members, sockets, engine, tasks, ws, subscriptions, defaultPermissionMode }: Context): Promise<Response> {
  const ok = (result: unknown): Response => ({ type: 'response', id: req.id, result });
  const fail = (message: string): Response => ({ type: 'response', id: req.id, error: { message } });
  const p = (req.params ?? {}) as Record<string, any>;

  if (req.method.startsWith('member.') && member.accessLevel !== 'admin') return fail('only admin can manage Members');
  switch (req.method) {
    case 'member.list':
      return ok(members.list());
    case 'member.create':
      if (typeof p.name !== 'string' || !p.name.trim()) return fail('name is required');
      if (!accessLevels.includes(p.accessLevel)) return fail('invalid accessLevel');
      return ok(members.create(p.name.trim(), p.accessLevel));
    case 'member.issueToken': {
      const token = members.issue(p.memberId);
      return token ? ok({ token }) : fail('unknown member');
    }
    case 'member.revokeToken': {
      const error = members.revoke(p.memberId, p.tokenId);
      if (error) return fail(error);
      // После ответа: отзыв собственного токена закрывает и это соединение.
      setImmediate(() => sockets.forEach((a, s) => a.tokenId === p.tokenId && s.close(1008, 'token revoked')));
      return ok(null);
    }
    case 'agent.info': {
      const result: AgentHello = {
        ...info,
        member: { id: member.id, name: member.name, accessLevel: member.accessLevel, tokenId },
        engines: [{ id: 'claude-code', status: (await engine.status?.()) ?? 'ready' }],
      };
      return ok(result);
    }
    case 'task.create':
      if (typeof p.name !== 'string' || !p.name.trim()) return fail('name is required');
      if (p.permissionMode !== undefined && !permissionModes.includes(p.permissionMode)) return fail('invalid permissionMode');
      return ok(tasks.create(p.name.trim(), member, p.permissionMode ?? defaultPermissionMode));
    case 'task.list':
      return ok(tasks.list(member));
    case 'task.pause':
    case 'task.resume':
    case 'task.complete':
    case 'task.reopen': {
      const action = req.method.slice('task.'.length) as 'pause' | 'resume' | 'complete' | 'reopen';
      const task = tasks[action](p.taskId, member);
      return typeof task === 'string' ? fail(task) : ok(task);
    }
    case 'task.delete':
      return tasks.delete(p.taskId, member) ? ok(null) : fail('only a completed Task you can see can be deleted');
    case 'session.send': {
      const session = tasks.session(p.sessionId, member);
      if (!session) return fail('unknown session');
      if (typeof p.text !== 'string' || !p.text.trim()) return fail('text is required');
      if (!session.send(p.text)) return fail('Task на паузе или завершена');
      return ok(null);
    }
    case 'session.answer': {
      const session = tasks.session(p.sessionId, member);
      if (!session) return fail('unknown session');
      if (!session.answer(String(p.requestId), p.allow === true, p.always === true)) return fail('no such pending request');
      return ok(null);
    }
    case 'session.subscribe': {
      const session = tasks.session(p.sessionId, member);
      if (!session) return fail('unknown session');
      subscriptions.get(p.sessionId)?.();
      // Ответ уходит после истории — это нормально: клиент различает их по type.
      subscriptions.set(p.sessionId, session.subscribe(Number(p.fromSeq) || 0, (e) => ws.send(JSON.stringify(e))));
      return ok(null);
    }
    case 'session.unsubscribe':
      subscriptions.get(p.sessionId)?.();
      subscriptions.delete(p.sessionId);
      return ok(null);
    default:
      return fail(`unknown method: ${req.method}`);
  }
}
