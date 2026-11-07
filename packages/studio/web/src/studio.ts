import { useEffect, useRef, useState } from 'react';
import type { AgentStatus, AgentsEvent, Response, StudioSessionEvent, StudioTasksEvent, Task } from '@horizon/protocol';

/** The browser's connection to the Studio server: the Agent list, their Tasks, Session events and requests. */
export function useStudio() {
  const [agents, setAgents] = useState<AgentStatus[]>([]);
  const [tasks, setTasks] = useState<Record<string, Task[]>>({});
  const [events, setEvents] = useState<Record<string, StudioSessionEvent[]>>({});
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
        const msg = JSON.parse(e.data) as AgentsEvent | StudioTasksEvent | StudioSessionEvent | Response;
        if (msg.type === 'agents') setAgents(msg.agents);
        else if (msg.type === 'tasks') setTasks((t) => ({ ...t, [msg.agentId]: msg.tasks }));
        else if (msg.type === 'event') {
          // History may arrive again (resubscribing, another tab), so take only new seq values.
          setEvents((all) => {
            const list = all[msg.sessionId] ?? [];
            if (list.length && list[list.length - 1].seq >= msg.seq) return all;
            return { ...all, [msg.sessionId]: [...list, msg] };
          });
        } else {
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

  return { agents, connected, tasks, setTasks, events, request };
}
