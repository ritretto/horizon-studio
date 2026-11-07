import WebSocket from 'ws';
import type { AgentHello, AgentStatus, ConnectionInput, Response, SessionEvent, TasksEvent } from '@horizon/protocol';
import { openTunnel, type Tunnel } from './tunnel.ts';

export interface Connection extends ConnectionInput {
  id: string;
}

const RETRY_MS = 3000;
/** How often to recheck Agent status, for example Engine readiness after logging in to Claude Code. */
const REFRESH_MS = 60_000;

/** The Studio server connection to one Agent: keeps it open, reconnects and relays requests. */
export class AgentLink {
  status: AgentStatus;
  private ws?: WebSocket;
  private pending = new Map<number, (res: Response) => void>();
  private nextId = 1;
  private retry?: NodeJS.Timeout;
  private refresh?: NodeJS.Timeout;
  private closed = false;
  readonly connection: Connection;
  private onChange: () => void;
  private onEvent: (e: SessionEvent | TasksEvent) => void;
  private knownHosts: string;
  private tunnel?: Tunnel;
  /** The local port the Agent is reachable on now (its own or the tunnel). */
  private port = 0;

  constructor(connection: Connection, knownHosts: string, onChange: () => void, onEvent: (e: SessionEvent | TasksEvent) => void) {
    this.connection = connection;
    this.knownHosts = knownHosts;
    this.onChange = onChange;
    this.onEvent = onEvent;
    const { id, name, port, ssh } = connection;
    this.status = { id, name, port, ssh, state: 'connecting' };
    this.open();
  }

  request(method: string, params?: unknown): Promise<Response> {
    const id = this.nextId++;
    if (this.ws?.readyState !== WebSocket.OPEN) {
      return Promise.resolve({ type: 'response', id, error: { message: `agent is ${this.status.state}` } });
    }
    this.ws.send(JSON.stringify({ type: 'request', id, method, params }));
    return new Promise((resolve) => this.pending.set(id, resolve));
  }

  /** Agent Update: sends the build to the Agent's `PUT /update`. */
  async update(build: string): Promise<{ result: unknown } | { error: { message: string } }> {
    if (this.status.state !== 'online') return { error: { message: `agent is ${this.status.state}` } };
    const res = await fetch(`http://127.0.0.1:${this.port}/update`, {
      method: 'PUT',
      headers: { authorization: `Bearer ${this.connection.token}`, 'content-type': 'application/json' },
      body: build,
    });
    const body = await res.json();
    return res.ok ? { result: body } : { error: { message: body.error } };
  }

  close() {
    this.closed = true;
    clearTimeout(this.retry);
    clearInterval(this.refresh);
    this.ws?.close();
    this.tunnel?.close();
  }

  private async open() {
    let port = this.connection.port;
    if (this.connection.ssh) {
      // ponytail: the tunnel is reopened on every attempt while the Agent is unreachable, one ssh connection per RETRY_MS.
      try {
        this.tunnel = await openTunnel(this.connection.ssh, port, this.knownHosts, () => this.ws?.terminate());
      } catch (e) {
        if (this.closed) return;
        this.set('offline', undefined, (e as Error).message);
        this.retry = setTimeout(() => this.open(), RETRY_MS);
        return;
      }
      if (this.closed) return this.tunnel.close();
      port = this.tunnel.port;
    }
    this.port = port;
    const ws = new WebSocket(`ws://127.0.0.1:${port}`, {
      headers: { authorization: `Bearer ${this.connection.token}` },
    });
    this.ws = ws;
    let unauthorized = false;

    ws.on('unexpected-response', (_req, res) => {
      unauthorized = res.statusCode === 401;
      ws.terminate();
    });
    const hello = async () => {
      const res = await this.request('agent.info');
      if ('result' in res) this.set('online', res.result as AgentHello);
    };
    ws.on('open', () => {
      hello();
      this.refresh = setInterval(hello, REFRESH_MS);
    });
    ws.on('message', (data) => {
      const msg = JSON.parse(String(data)) as Response | SessionEvent | TasksEvent;
      if (msg.type !== 'response') return this.onEvent(msg);
      this.pending.get(msg.id)?.(msg);
      this.pending.delete(msg.id);
    });
    ws.on('error', () => {}); // close always follows
    ws.on('close', () => {
      for (const [id, resolve] of this.pending) resolve({ type: 'response', id, error: { message: 'agent disconnected' } });
      this.pending.clear();
      clearInterval(this.refresh);
      this.tunnel?.close();
      if (this.closed) return;
      this.set(unauthorized ? 'unauthorized' : 'offline');
      this.retry = setTimeout(() => this.open(), RETRY_MS);
    });
  }

  private set(state: AgentStatus['state'], hello?: AgentHello, error?: string) {
    const next = { ...this.status, state, hello, error };
    if (JSON.stringify(next) === JSON.stringify(this.status)) return;
    this.status = next;
    this.onChange();
  }
}
