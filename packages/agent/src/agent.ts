import { createServer, type Server } from 'node:http';
import { WebSocketServer } from 'ws';
import type { AgentHello, AgentInfo, Request, Response } from '@horizon/protocol';
import pkg from '../package.json' with { type: 'json' };
import { Members, type Member } from './members.ts';

const info: AgentInfo = { version: pkg.version };

export interface StartedAgent {
  server: Server;
  /** Access Token первого admin, если Agent Home только что создан. */
  adminToken?: string;
}

export function startAgent(home: string, port: number): Promise<StartedAgent> {
  const members = new Members(home);
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
      ws.on('message', (data) => {
        let req: Request;
        try {
          req = JSON.parse(String(data));
        } catch {
          ws.close(1003, 'invalid JSON');
          return;
        }
        ws.send(JSON.stringify(handle(req, member)));
      });
    });
  });

  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve({ server, adminToken })));
}

function handle(req: Request, member: Member): Response {
  switch (req.method) {
    case 'agent.info': {
      const result: AgentHello = {
        ...info,
        member: { id: member.id, name: member.name, accessLevel: member.accessLevel },
      };
      return { type: 'response', id: req.id, result };
    }
    default:
      return { type: 'response', id: req.id, error: { message: `unknown method: ${req.method}` } };
  }
}
