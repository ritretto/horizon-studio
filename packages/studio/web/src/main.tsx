import { StrictMode, useEffect, useState, type FormEvent } from 'react';
import { createRoot } from 'react-dom/client';
import type { AgentStatus, PermissionMode, Task } from '@horizon/protocol';
import { useStudio } from './studio.ts';
import { Chat } from './chat.tsx';
import './style.css';

const modeLabel: Record<PermissionMode, string> = {
  ask: 'спрашивать разрешения',
  auto: 'всё разрешено',
};

const stateLabel: Record<AgentStatus['state'], string> = {
  connecting: 'подключение…',
  online: 'online',
  offline: 'offline',
  unauthorized: 'неверный токен',
};

function App() {
  const { agents, connected, events, request } = useStudio();
  const [tasks, setTasks] = useState<Record<string, Task[]>>({});
  const [selected, setSelected] = useState<{ agentId: string; taskId: string }>();
  const task = selected && tasks[selected.agentId]?.find((t) => t.id === selected.taskId);
  const [error, setError] = useState('');

  const online = agents.filter((a) => a.state === 'online').map((a) => a.id).join();
  const loadTasks = async (agentId: string) => {
    const res = await request('task.list', undefined, agentId);
    if ('result' in res) setTasks((t) => ({ ...t, [agentId]: res.result as Task[] }));
  };
  useEffect(() => {
    online.split(',').filter(Boolean).forEach(loadTasks);
  }, [online]);

  // Подписка на Session выбранной Task; после переподключения Agent — заново, с последнего seq.
  const sessionId = task?.sessions[0].id;
  const agentOnline = !!selected && online.split(',').includes(selected.agentId);
  useEffect(() => {
    if (!selected || !sessionId || !agentOnline) return;
    const fromSeq = events[sessionId]?.at(-1)?.seq ?? 0;
    request('session.subscribe', { sessionId, fromSeq }, selected.agentId);
    return () => void request('session.unsubscribe', { sessionId }, selected.agentId);
  }, [sessionId, agentOnline]);

  async function createTask(agentId: string, e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const data = new FormData(form);
    const res = await request('task.create', { name: data.get('name'), permissionMode: data.get('permissionMode') || undefined }, agentId);
    if ('error' in res) return setError(res.error.message);
    form.reset();
    await loadTasks(agentId);
    setSelected({ agentId, taskId: (res.result as Task).id });
  }

  // Состояние паузы берём из событий Session — так его сразу видят все Studio.
  const status = sessionId ? events[sessionId]?.findLast((e) => e.item.kind === 'status')?.item : undefined;
  const paused = status?.kind === 'status' ? status.status === 'paused' : task?.state === 'paused';

  async function setPaused(pause: boolean) {
    if (!selected || !task) return;
    const res = await request(pause ? 'task.pause' : 'task.resume', { taskId: task.id }, selected.agentId);
    if ('error' in res) setError(res.error.message);
    await loadTasks(selected.agentId);
  }

  async function addConnection(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const data = new FormData(form);
    const res = await request('connection.add', {
      name: String(data.get('name')),
      port: Number(data.get('port')),
      token: String(data.get('token')).trim(),
    });
    if ('error' in res) setError(res.error.message);
    else {
      setError('');
      form.reset();
    }
  }

  return (
    <div className="layout">
      <aside>
        <h1>HorizonStudio</h1>
        {!connected && <p className="warn">Нет связи со Studio-сервером, переподключаемся…</p>}
        {agents.length === 0 && <p className="muted">Добавьте Connection к Agent ниже.</p>}
        {agents.map((a) => (
          <div key={a.id} className="agent">
            <div className="agent-head">
              <span className={`dot ${a.state}`} />
              <strong>{a.name}</strong>
              <span className="muted">
                {a.hello ? `v${a.hello.version} · ${a.hello.member.name}` : stateLabel[a.state]}
              </span>
              <button className="link" title="Удалить Connection" onClick={() => request('connection.remove', { id: a.id })}>
                ×
              </button>
            </div>
            {a.state === 'online' && (
              <>
                <ul className="tasks">
                  {(tasks[a.id] ?? []).map((t) => (
                    <li key={t.id}>
                      <button
                        className={selected?.taskId === t.id ? 'active' : ''}
                        onClick={() => setSelected({ agentId: a.id, taskId: t.id })}
                      >
                        {t.state === 'paused' && <span title="На паузе">⏸ </span>}
                        {t.name}
                      </button>
                    </li>
                  ))}
                </ul>
                <form onSubmit={(e) => createTask(a.id, e)}>
                  <input name="name" placeholder="Новая Task" required />
                  <button>+</button>
                  <select name="permissionMode" aria-label="Permission Mode" defaultValue="">
                    <option value="">Разрешения: по умолчанию Agent</option>
                    <option value="ask">Спрашивать разрешения</option>
                    <option value="auto">Разрешать всё без вопросов</option>
                  </select>
                </form>
              </>
            )}
          </div>
        ))}

        <details className="new-connection" open={agents.length === 0}>
          <summary>Новая Connection</summary>
          <form onSubmit={addConnection}>
            <input name="name" placeholder="Название" required />
            <input name="port" type="number" defaultValue={7400} min={1} max={65535} required aria-label="Порт" />
            <input name="token" placeholder="Access Token" required autoComplete="off" />
            <button>Добавить</button>
          </form>
        </details>
        {error && <p className="warn">{error}</p>}
      </aside>

      <main>
        {selected && task && sessionId ? (
          <>
            <header className="task-head">
              <h2>
                {task.name} <span className={`mode ${task.permissionMode}`}>{modeLabel[task.permissionMode]}</span>
              </h2>
              {agentOnline && <button onClick={() => setPaused(!paused)}>{paused ? 'Продолжить' : 'Пауза'}</button>}
            </header>
            {!agentOnline && <p className="warn">Agent недоступен — Session продолжает работать на нём, история подгрузится после переподключения.</p>}
            <Chat
              events={events[sessionId] ?? []}
              paused={paused}
              onSend={(text) => request('session.send', { sessionId, text }, selected.agentId)}
              onAnswer={(requestId, allow, always) =>
                request('session.answer', { sessionId, requestId, allow, always }, selected.agentId)
              }
            />
          </>
        ) : (
          <p className="muted">Выберите или создайте Task.</p>
        )}
      </main>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
