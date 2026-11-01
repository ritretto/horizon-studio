import { createServer, type Server } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import type { AgentHello, AgentInfo, PermissionMode, Request, Response } from '@horizon/protocol';
import pkg from '../package.json' with { type: 'json' };
import { claudeCode, type Engine } from './engine.ts';
import { Members, type Member } from './members.ts';
import { Tasks } from './tasks.ts';

const info: AgentInfo = { version: pkg.version };

export interface StartedAgent {
  server: Server;
  /** Access Token первого admin, если Agent Home только что создан. */
  adminToken?: string;
}

export interface AgentOptions {
  engine?: Engine;
  /** Permission Mode для новых Task, если он не указан явно (из конфига Agent). */
  defaultPermissionMode?: PermissionMode;
}

export function startAgent(home: string, port: number, opts: AgentOptions = {}): Promise<StartedAgent> {
  const members = new Members(home);
  const tasks = new Tasks(home, opts.engine ?? claudeCode);
  const defaultPermissionMode = opts.defaultPermissionMode ?? 'ask';
  const adminToken = members.isEmpty ? members.create('admin', 'admin') : undefined;

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
    const member = token && members.authenticate(token);
    if (!member) {
      socket.end('HTTP/1.1 401 Unauthorized\r\n\r\n');
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      const subscriptions = new Map<string, () => void>();
      ws.on('close', () => subscriptions.forEach((unsubscribe) => unsubscribe()));
      ws.on('message', (data) => {
        let req: Request;
        try {
          req = JSON.parse(String(data));
        } catch {
          ws.close(1003, 'invalid JSON');
          return;
        }
        ws.send(JSON.stringify(handle(req, { member, tasks, ws, subscriptions, defaultPermissionMode })));
      });
    });
  });

  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve({ server, adminToken })));
}

interface Context {
  member: Member;
  tasks: Tasks;
  ws: WebSocket;
  subscriptions: Map<string, () => void>;
  defaultPermissionMode: PermissionMode;
}

const permissionModes: PermissionMode[] = ['ask', 'auto'];

function handle(req: Request, { member, tasks, ws, subscriptions, defaultPermissionMode }: Context): Response {
  const ok = (result: unknown): Response => ({ type: 'response', id: req.id, result });
  const fail = (message: string): Response => ({ type: 'response', id: req.id, error: { message } });
  const p = (req.params ?? {}) as Record<string, any>;

  switch (req.method) {
    case 'agent.info': {
      const result: AgentHello = {
        ...info,
        member: { id: member.id, name: member.name, accessLevel: member.accessLevel },
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
    case 'task.resume': {
      const task = req.method === 'task.pause' ? tasks.pause(p.taskId, member) : tasks.resume(p.taskId, member);
      return task ? ok(task) : fail('unknown task');
    }
    case 'session.send': {
      const session = tasks.session(p.sessionId, member);
      if (!session) return fail('unknown session');
      if (typeof p.text !== 'string' || !p.text.trim()) return fail('text is required');
      if (!session.send(p.text)) return fail('Task на паузе');
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
