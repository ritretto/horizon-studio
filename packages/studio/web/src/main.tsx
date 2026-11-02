import { StrictMode, useEffect, useState, type FormEvent } from 'react';
import { createRoot } from 'react-dom/client';
import type { AgentStatus, EngineStatus, PermissionMode, Task, TaskState } from '@horizon/protocol';
import { useStudio } from './studio.ts';
import { Chat } from './chat.tsx';
import { Members } from './members.tsx';
import './style.css';

const modeLabel: Record<PermissionMode, string> = {
  ask: 'спрашивать разрешения',
  auto: 'всё разрешено',
};

const statusToState = { paused: 'paused', reopened: 'paused', completed: 'completed', resumed: 'active', interrupted: 'active' } as const;

const stateLabel: Record<AgentStatus['state'], string> = {
  connecting: 'подключение…',
  online: 'online',
  offline: 'offline',
  unauthorized: 'неверный токен',
};

const engineLabel: Record<EngineStatus, string> = {
  ready: 'готов',
  'not installed': 'не установлен',
  'no credentials': 'нет учётных данных — войдите в Claude Code на машине Agent',
};

const completedLast = (a: Task, b: Task) => Number(a.state === 'completed') - Number(b.state === 'completed');

function App() {
  const { agents, connected, tasks, setTasks, events, request } = useStudio();
  const [selected, setSelected] = useState<{ agentId: string; taskId: string }>();
  const task = selected && tasks[selected.agentId]?.find((t) => t.id === selected.taskId);
  /** Agent, чьи Member открыты в основной панели вместо Task. */
  const [membersOf, setMembersOf] = useState<string>();
  const membersAgent = agents.find((a) => a.id === membersOf && a.hello?.member.accessLevel === 'admin');
  const [error, setError] = useState('');
  /** Ход Agent Update по Agent; `pending` — сборка, результат которой ждём от Agent. */
  const [updating, setUpdating] = useState<Record<string, { text: string; pending?: string }>>({});

  async function updateAgent(agentId: string) {
    setUpdating((u) => ({ ...u, [agentId]: { text: 'Загрузка сборки и установка зависимостей…' } }));
    const res = await request('connection.update', { id: agentId });
    const r = 'result' in res ? (res.result as { status: 'current' | 'restarting'; build: string }) : undefined;
    const next = !r
      ? { text: `Ошибка: ${'error' in res ? res.error.message : ''}` }
      : r.status === 'current'
        ? { text: `Уже работает ${r.build}` }
        : { text: `Перезапуск на ${r.build}…`, pending: r.build };
    setUpdating((u) => ({ ...u, [agentId]: next }));
  }

  const online = agents.filter((a) => a.state === 'online').map((a) => a.id).join();
  const loadTasks = async (agentId: string) => {
    const res = await request('task.list', undefined, agentId);
    if ('result' in res) setTasks((t) => ({ ...t, [agentId]: res.result as Task[] }));
  };
  // Дальше Agent сам присылает список при изменениях.
  useEffect(() => {
    online.split(',').filter(Boolean).forEach(loadTasks);
  }, [online]);
  const onlineAgents = agents.filter((a) => a.state === 'online');
  const allTasks = onlineAgents
    .flatMap((agent) => (tasks[agent.id] ?? []).map((task) => ({ agent, task })))
    .sort((a, b) => completedLast(a.task, b.task) || a.task.createdAt.localeCompare(b.task.createdAt));
  const readyAgents = onlineAgents.filter((a) => a.hello?.engines.some((e) => e.status === 'ready'));

  // Подписка на Session выбранной Task; после переподключения Agent — заново, с последнего seq.
  const sessionId = task?.sessions[0].id;
  const agentOnline = !!selected && online.split(',').includes(selected.agentId);
  useEffect(() => {
    if (!selected || !sessionId || !agentOnline) return;
    const fromSeq = events[sessionId]?.at(-1)?.seq ?? 0;
    request('session.subscribe', { sessionId, fromSeq }, selected.agentId);
    return () => void request('session.unsubscribe', { sessionId }, selected.agentId);
  }, [sessionId, agentOnline]);

  async function createTask(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const data = new FormData(form);
    const agentId = String(data.get('agentId') ?? readyAgents[0].id);
    const res = await request('task.create', { name: data.get('name'), permissionMode: data.get('permissionMode') || undefined }, agentId);
    if ('error' in res) return setError(res.error.message);
    form.reset();
    await loadTasks(agentId); // чтобы Task была в списке сразу, не дожидаясь события
    setSelected({ agentId, taskId: (res.result as Task).id });
    setMembersOf(undefined);
  }

  // Состояние Task берём из событий Session — так его сразу видят все Studio.
  const status = sessionId ? events[sessionId]?.findLast((e) => e.item.kind === 'status')?.item : undefined;
  const state: TaskState | undefined = status?.kind === 'status' ? statusToState[status.status] : task?.state;
  const [confirmDelete, setConfirmDelete] = useState(false);
  useEffect(() => setConfirmDelete(false), [selected?.taskId, state]);

  async function act(method: 'pause' | 'resume' | 'complete' | 'reopen' | 'delete') {
    if (!selected || !task) return;
    const res = await request(`task.${method}`, { taskId: task.id }, selected.agentId);
    if ('error' in res) setError(res.error.message);
    else if (method === 'delete') setSelected(undefined);
  }

  async function addConnection(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const data = new FormData(form);
    const field = (name: string) => String(data.get(name)).trim() || undefined;
    const host = field('sshHost');
    const res = await request('connection.add', {
      name: String(data.get('name')),
      port: Number(data.get('port')),
      token: String(data.get('token')).trim(),
      ssh: host && { host, user: field('sshUser'), port: Number(field('sshPort')) || undefined, key: field('sshKey') },
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

        {/* Task со всех online-Agent; Task недоступных Agent не показываются. */}
        <ul className="tasks">
          {allTasks.map(({ agent, task: t }) => (
            <li key={agent.id + t.id}>
              <button
                className={`${selected?.agentId === agent.id && selected.taskId === t.id ? 'active' : ''} ${t.state}`}
                onClick={() => (setSelected({ agentId: agent.id, taskId: t.id }), setMembersOf(undefined))}
              >
                {t.state === 'paused' && <span title="На паузе">⏸ </span>}
                {t.state === 'completed' && <span title="Завершена">✓ </span>}
                {t.name}
                {agents.length > 1 && <span className="task-agent">{agent.name}</span>}
              </button>
            </li>
          ))}
        </ul>
        {readyAgents.length > 0 && (
          <form className="new-task" onSubmit={createTask}>
            <div>
              <input name="name" placeholder="Новая Task" required />
              <button>+</button>
            </div>
            {readyAgents.length > 1 && (
              <select name="agentId" aria-label="Agent">
                {readyAgents.map((a) => (
                  <option key={a.id} value={a.id}>
                    на {a.name}
                  </option>
                ))}
              </select>
            )}
            <select name="permissionMode" aria-label="Permission Mode" defaultValue="">
              <option value="">Разрешения: по умолчанию Agent</option>
              <option value="ask">Спрашивать разрешения</option>
              <option value="auto">Разрешать всё без вопросов</option>
            </select>
          </form>
        )}

        <h3>Agent</h3>
        {agents.map((a) => (
          <div key={a.id} className="agent">
            <div className="agent-head">
              <span className={`dot ${a.state}`} />
              <strong>{a.name}</strong>
              <span className="muted" title={a.hello ? `${a.hello.build ?? a.hello.version} · ${a.hello.member.name}` : undefined}>
                {a.hello ? `v${a.hello.version} · ${a.hello.member.name}` : stateLabel[a.state]}
              </span>
              {a.hello?.member.accessLevel === 'admin' && (
                <button className="link" title="Member и Access Token" onClick={() => setMembersOf(a.id)}>
                  Member
                </button>
              )}
              <button className="link" title="Удалить Connection" onClick={() => request('connection.remove', { id: a.id })}>
                ×
              </button>
            </div>
            {a.ssh && (
              <p className="muted">
                ssh {a.ssh.user ? `${a.ssh.user}@` : ''}
                {a.ssh.host}
              </p>
            )}
            {a.error && <p className="warn">{a.error}</p>}
            {a.hello?.member.accessLevel === 'admin' && a.hello.build && (
              <p className="muted">
                Сборка {a.hello.build}{' '}
                <button className="link" title="Загрузить локальную сборку Agent" onClick={() => updateAgent(a.id)}>
                  Обновить
                </button>
              </p>
            )}
            {updating[a.id] && !(updating[a.id].pending && a.hello?.lastUpdate?.version === updating[a.id].pending) && (
              <p className="muted">{updating[a.id].text}</p>
            )}
            {a.hello?.lastUpdate && (
              <p className={a.hello.lastUpdate.ok ? 'muted' : 'warn'}>
                {a.hello.lastUpdate.ok
                  ? `Обновлено до ${a.hello.lastUpdate.version}`
                  : `Обновление до ${a.hello.lastUpdate.version} не удалось: ${a.hello.lastUpdate.error}; откат на прежнюю версию`}{' '}
                ({new Date(a.hello.lastUpdate.at).toLocaleString()})
              </p>
            )}
            {a.state === 'online' &&
              a.hello?.engines.map((e) => (
                <p key={e.id} className={e.status === 'ready' ? 'muted' : 'warn'}>
                  Claude Code: {engineLabel[e.status]}
                </p>
              ))}
          </div>
        ))}

        <details className="new-connection" open={agents.length === 0}>
          <summary>Новая Connection</summary>
          <form onSubmit={addConnection}>
            <input name="name" placeholder="Название" required />
            <input name="port" type="number" defaultValue={7400} min={1} max={65535} required aria-label="Порт Agent" />
            <input name="token" placeholder="Access Token" required autoComplete="off" />
            <fieldset>
              <legend>Удалённый Agent — через SSH</legend>
              <input name="sshHost" placeholder="Хост (пусто — Agent на этой машине)" />
              <input name="sshUser" placeholder="Пользователь" />
              <input name="sshPort" type="number" min={1} max={65535} placeholder="Порт SSH (22)" />
              <input name="sshKey" placeholder="Путь к ключу (~/.ssh/id_ed25519)" />
            </fieldset>
            <button>Добавить</button>
          </form>
        </details>
        {error && <p className="warn">{error}</p>}
      </aside>

      <main>
        {membersAgent?.hello ? (
          <Members
            key={membersAgent.id}
            self={membersAgent.hello.member}
            request={(method, params) => request(method, params, membersAgent.id)}
          />
        ) : selected && task && sessionId ? (
          <>
            <header className="task-head">
              <h2>
                {task.name} <span className={`mode ${task.permissionMode}`}>{modeLabel[task.permissionMode]}</span>
              </h2>
              {agentOnline && (
                <div className="task-actions">
                  {state === 'active' && <button onClick={() => act('pause')}>Пауза</button>}
                  {state === 'paused' && <button onClick={() => act('resume')}>Продолжить</button>}
                  {state !== 'completed' && <button onClick={() => act('complete')}>Завершить</button>}
                  {state === 'completed' && <button onClick={() => act('reopen')}>Переоткрыть</button>}
                  {state === 'completed' &&
                    (confirmDelete ? (
                      <button className="danger" onClick={() => act('delete')}>
                        Удалить безвозвратно?
                      </button>
                    ) : (
                      <button onClick={() => setConfirmDelete(true)}>Удалить</button>
                    ))}
                </div>
              )}
            </header>
            {state === 'completed' && task.deleteAt && (
              <p className="muted">Task завершена и будет удалена {new Date(task.deleteAt).toLocaleDateString()}.</p>
            )}
            {!agentOnline && <p className="warn">Agent недоступен — Session продолжает работать на нём, история подгрузится после переподключения.</p>}
            <Chat
              events={events[sessionId] ?? []}
              state={state ?? 'active'}
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
