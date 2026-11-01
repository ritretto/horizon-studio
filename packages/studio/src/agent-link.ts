import WebSocket from 'ws';
import type { AgentHello, AgentStatus, Response, SessionEvent } from '@horizon/protocol';

export interface Connection {
  id: string;
  name: string;
  port: number;
  token: string;
}

const RETRY_MS = 3000;

/** Соединение Studio-сервера с одним Agent: держит его, переподключается и ретранслирует запросы. */
export class AgentLink {
  status: AgentStatus;
  private ws?: WebSocket;
  private pending = new Map<number, (res: Response) => void>();
  private nextId = 1;
  private retry?: NodeJS.Timeout;
  private closed = false;
  readonly connection: Connection;
  private onChange: () => void;
  private onEvent: (e: SessionEvent) => void;

  constructor(connection: Connection, onChange: () => void, onEvent: (e: SessionEvent) => void) {
    this.connection = connection;
    this.onChange = onChange;
    this.onEvent = onEvent;
    this.status = { id: connection.id, name: connection.name, port: connection.port, state: 'connecting' };
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

  close() {
    this.closed = true;
    clearTimeout(this.retry);
    this.ws?.close();
  }

  private open() {
    const ws = new WebSocket(`ws://127.0.0.1:${this.connection.port}`, {
      headers: { authorization: `Bearer ${this.connection.token}` },
    });
    this.ws = ws;
    let unauthorized = false;

    ws.on('unexpected-response', (_req, res) => {
      unauthorized = res.statusCode === 401;
      ws.terminate();
    });
    ws.on('open', async () => {
      const res = await this.request('agent.info');
      if ('result' in res) this.set('online', res.result as AgentHello);
    });
    ws.on('message', (data) => {
      const msg = JSON.parse(String(data)) as Response | SessionEvent;
      if (msg.type === 'event') return this.onEvent(msg);
      this.pending.get(msg.id)?.(msg);
      this.pending.delete(msg.id);
    });
    ws.on('error', () => {}); // за ним всегда следует close
    ws.on('close', () => {
      for (const [id, resolve] of this.pending) resolve({ type: 'response', id, error: { message: 'agent disconnected' } });
      this.pending.clear();
      if (this.closed) return;
      this.set(unauthorized ? 'unauthorized' : 'offline');
      this.retry = setTimeout(() => this.open(), RETRY_MS);
    });
  }

  private set(state: AgentStatus['state'], hello?: AgentHello) {
    if (this.status.state === state && this.status.hello === hello) return;
    this.status = { ...this.status, state, hello };
    this.onChange();
  }
}
