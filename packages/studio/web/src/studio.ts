import { useEffect, useRef, useState } from 'react';
import type { AgentStatus, AgentsEvent, Response } from '@horizon/protocol';

/** Соединение браузера со Studio-сервером: список Agent'ов и запросы. */
export function useStudio() {
  const [agents, setAgents] = useState<AgentStatus[]>([]);
  const [connected, setConnected] = useState(false);
  const ws = useRef<WebSocket>(null);
  const pending = useRef(new Map<number, (res: Response) => void>());
  const nextId = useRef(1);

  useEffect(() => {
    let retry: number;
    let socket: WebSocket;
    const open = () => {
      socket = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
      ws.current = socket;
      socket.onopen = () => setConnected(true);
      socket.onclose = () => {
        setConnected(false);
        retry = window.setTimeout(open, 2000);
      };
      socket.onmessage = (e) => {
        const msg = JSON.parse(e.data) as AgentsEvent | Response;
        if (msg.type === 'agents') setAgents(msg.agents);
        else {
          pending.current.get(msg.id)?.(msg);
          pending.current.delete(msg.id);
        }
      };
    };
    open();
    return () => {
      clearTimeout(retry);
      socket.onclose = null;
      socket.close();
    };
  }, []);

  function request(method: string, params?: unknown, agentId?: string): Promise<Response> {
    const id = nextId.current++;
    ws.current?.send(JSON.stringify({ type: 'request', id, method, params, agentId }));
    return new Promise((resolve) => pending.current.set(id, resolve));
  }

  return { agents, connected, request };
}
