import { createServer, type Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, type WebSocket } from 'ws';
import type { AgentsEvent, ConnectionInput, Response, StudioRequest } from '@horizon/protocol';
import { AgentLink, type Connection } from './agent-link.ts';

// From both src/ and dist/, this points to dist/web.
const webRoot = fileURLToPath(new URL('../dist/web/', import.meta.url));
/** Local Agent build for Agent Update (`npm run build -w @horizon/agent`). */
const agentBuild = fileURLToPath(new URL('../../agent/dist/', import.meta.url));
const types: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

export function startStudio(configFile: string, port: number): Promise<Server> {
  const config: { connections: Connection[] } = existsSync(configFile)
    ? JSON.parse(readFileSync(configFile, 'utf8'))
    : { connections: [] };
  const save = () => writeFileSync(configFile, JSON.stringify(config, null, 2), { mode: 0o600 });

  const clients = new Set<WebSocket>();
  const links = new Map<string, AgentLink>();
  const agentsEvent = (): AgentsEvent => ({ type: 'agents', agents: [...links.values()].map((l) => l.status) });
  const send = (msg: unknown) => {
    const data = JSON.stringify(msg);
    for (const c of clients) c.send(data);
  };
  const broadcast = () => send(agentsEvent());
  // ponytail: events of all Sessions go to all browsers, and the browser filters by sessionId and seq.
  // Add targeted delivery when there are many browsers (a shared Studio).
  const knownHosts = join(dirname(configFile), 'known_hosts');
  const link = (c: Connection) =>
    links.set(c.id, new AgentLink(c, knownHosts, broadcast, (e) => send({ ...e, agentId: c.id })));
  config.connections.forEach(link);

  async function handle(req: StudioRequest): Promise<Response> {
    if (req.agentId) {
      const agent = links.get(req.agentId);
      if (!agent) return { type: 'response', id: req.id, error: { message: 'unknown agent' } };
      return { ...(await agent.request(req.method, req.params)), id: req.id };
    }
    switch (req.method) {
      case 'connection.add': {
        const { name, port, token, ssh } = req.params as ConnectionInput;
        const c: Connection = { id: randomUUID(), name, port, token, ssh };
        config.connections.push(c);
        save();
        link(c);
        broadcast();
        return { type: 'response', id: req.id, result: { id: c.id } };
      }
      case 'connection.update': {
        const agent = links.get((req.params as { id: string }).id);
        if (!agent) return { type: 'response', id: req.id, error: { message: 'unknown agent' } };
        let build: string;
        try {
          const pkg = JSON.parse(await readFile(join(agentBuild, 'package.json'), 'utf8'));
          build = JSON.stringify({ package: pkg, agent: await readFile(join(agentBuild, 'agent.mjs'), 'utf8') });
        } catch {
          return { type: 'response', id: req.id, error: { message: `no Agent build in ${agentBuild}: npm run build` } };
        }
        return { type: 'response', id: req.id, ...(await agent.update(build)) };
      }
      case 'connection.remove': {
        const { id } = req.params as { id: string };
        config.connections = config.connections.filter((c) => c.id !== id);
        save();
        links.get(id)?.close();
        links.delete(id);
        broadcast();
        return { type: 'response', id: req.id, result: null };
      }
      default:
        return { type: 'response', id: req.id, error: { message: `unknown method: ${req.method}` } };
    }
  }

  const server = createServer(async (req, res) => {
    // The URL parser collapses `..` (including %2e%2e), so a path cannot leave webRoot.
    const path = new URL(req.url ?? '/', 'http://x').pathname;
    const file = path === '/' ? 'index.html' : path.slice(1);
    try {
      const body = await readFile(webRoot + file).catch(() => readFile(webRoot + 'index.html')); // SPA
      res.writeHead(200, { 'content-type': types[extname(file)] ?? types['.html'] }).end(body);
    } catch {
      res.writeHead(404).end('frontend is not built: npm run build -w @horizon/studio');
    }
  });

  const wss = new WebSocketServer({ server, path: '/ws' });
  wss.on('connection', (ws) => {
    clients.add(ws);
    ws.on('close', () => clients.delete(ws));
    ws.send(JSON.stringify(agentsEvent()));
    ws.on('message', async (data) => {
      let req: StudioRequest;
      try {
        req = JSON.parse(String(data));
      } catch {
        ws.close(1003, 'invalid JSON');
        return;
      }
      ws.send(JSON.stringify(await handle(req)));
    });
  });
  server.on('close', () => links.forEach((l) => l.close()));

  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)));
}
