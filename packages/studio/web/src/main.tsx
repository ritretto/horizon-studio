import { StrictMode, useEffect, useState, type FormEvent } from 'react';
import { createRoot } from 'react-dom/client';
import type { AgentStatus, EngineStatus, PermissionMode, Task, TaskState } from '@horizon/protocol';
import { useStudio } from './studio.ts';
import { Chat } from './chat.tsx';
import { Members } from './members.tsx';
import './style.css';

const modeLabel: Record<PermissionMode, string> = {
  ask: 'ask for permission',
  auto: 'everything allowed',
};

const statusToState = { paused: 'paused', reopened: 'paused', completed: 'completed', resumed: 'active', interrupted: 'active' } as const;

const stateLabel: Record<AgentStatus['state'], string> = {
  connecting: 'connecting…',
  online: 'online',
  offline: 'offline',
  unauthorized: 'invalid token',
};

const engineLabel: Record<EngineStatus, string> = {
  ready: 'ready',
  'not installed': 'not installed',
  'no credentials': 'no credentials. Log in to Claude Code on the Agent machine',
};

const completedLast = (a: Task, b: Task) => Number(a.state === 'completed') - Number(b.state === 'completed');

function App() {
  const { agents, connected, tasks, setTasks, events, request } = useStudio();
  const [selected, setSelected] = useState<{ agentId: string; taskId: string }>();
  const task = selected && tasks[selected.agentId]?.find((t) => t.id === selected.taskId);
  /** The Agent whose Members are open in the main panel instead of a Task. */
  const [membersOf, setMembersOf] = useState<string>();
  const membersAgent = agents.find((a) => a.id === membersOf && a.hello?.member.accessLevel === 'admin');
  const [error, setError] = useState('');
  /** Agent Update progress per Agent; `pending` is the build whose result is awaited from the Agent. */
  const [updating, setUpdating] = useState<Record<string, { text: string; pending?: string }>>({});

  async function updateAgent(agentId: string) {
    setUpdating((u) => ({ ...u, [agentId]: { text: 'Uploading the build and installing dependencies…' } }));
    const res = await request('connection.update', { id: agentId });
    const r = 'result' in res ? (res.result as { status: 'current' | 'restarting'; build: string }) : undefined;
    const next = !r
      ? { text: `Error: ${'error' in res ? res.error.message : ''}` }
      : r.status === 'current'
        ? { text: `Already running ${r.build}` }
        : { text: `Restarting on ${r.build}…`, pending: r.build };
    setUpdating((u) => ({ ...u, [agentId]: next }));
  }

  const online = agents.filter((a) => a.state === 'online').map((a) => a.id).join();
  const loadTasks = async (agentId: string) => {
    const res = await request('task.list', undefined, agentId);
    if ('result' in res) setTasks((t) => ({ ...t, [agentId]: res.result as Task[] }));
  };
  // After this the Agent sends the list itself when it changes.
  useEffect(() => {
    online.split(',').filter(Boolean).forEach(loadTasks);
  }, [online]);
  const onlineAgents = agents.filter((a) => a.state === 'online');
  const allTasks = onlineAgents
    .flatMap((agent) => (tasks[agent.id] ?? []).map((task) => ({ agent, task })))
    .sort((a, b) => completedLast(a.task, b.task) || a.task.createdAt.localeCompare(b.task.createdAt));
  const readyAgents = onlineAgents.filter((a) => a.hello?.engines.some((e) => e.status === 'ready'));

  // Subscribe to the selected Task's Session; after an Agent reconnect, subscribe again from the last seq.
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
    await loadTasks(agentId); // so the Task is listed at once, without waiting for the event
    setSelected({ agentId, taskId: (res.result as Task).id });
    setMembersOf(undefined);
  }

  // Task state comes from Session events, so all Studios see it at once.
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
        <h1>
          <img src="/favicon.png" alt="" width={24} height={24} />
          HorizonStudio
        </h1>
        {!connected && <p className="warn">No connection to the Studio server. Reconnecting…</p>}
        {agents.length === 0 && <p className="muted">Add a Connection to an Agent below.</p>}

        {/* Tasks from all online Agents; Tasks of unreachable Agents are not shown. */}
        <ul className="tasks">
          {allTasks.map(({ agent, task: t }) => (
            <li key={agent.id + t.id}>
              <button
                className={`${selected?.agentId === agent.id && selected.taskId === t.id ? 'active' : ''} ${t.state}`}
                onClick={() => (setSelected({ agentId: agent.id, taskId: t.id }), setMembersOf(undefined))}
              >
                {t.state === 'paused' && <span title="Paused">⏸ </span>}
                {t.state === 'completed' && <span title="Completed">✓ </span>}
                {t.name}
                {agents.length > 1 && <span className="task-agent">{agent.name}</span>}
              </button>
            </li>
          ))}
        </ul>
        {readyAgents.length > 0 && (
          <form className="new-task" onSubmit={createTask}>
            <div>
              <input name="name" placeholder="New Task" required />
              <button>+</button>
            </div>
            {readyAgents.length > 1 && (
              <select name="agentId" aria-label="Agent">
                {readyAgents.map((a) => (
                  <option key={a.id} value={a.id}>
                    on {a.name}
                  </option>
                ))}
              </select>
            )}
            <select name="permissionMode" aria-label="Permission Mode" defaultValue="">
              <option value="">Permissions: Agent default</option>
              <option value="ask">Ask for permission</option>
              <option value="auto">Allow everything without asking</option>
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
                <button className="link" title="Members and Access Tokens" onClick={() => setMembersOf(a.id)}>
                  Member
                </button>
              )}
              <button className="link" title="Remove Connection" onClick={() => request('connection.remove', { id: a.id })}>
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
                Build {a.hello.build}{' '}
                <button className="link" title="Upload the local Agent build" onClick={() => updateAgent(a.id)}>
                  Update
                </button>
              </p>
            )}
            {updating[a.id] && !(updating[a.id].pending && a.hello?.lastUpdate?.version === updating[a.id].pending) && (
              <p className="muted">{updating[a.id].text}</p>
            )}
            {a.hello?.lastUpdate && (
              <p className={a.hello.lastUpdate.ok ? 'muted' : 'warn'}>
                {a.hello.lastUpdate.ok
                  ? `Updated to ${a.hello.lastUpdate.version}`
                  : `Update to ${a.hello.lastUpdate.version} failed: ${a.hello.lastUpdate.error}; rolled back to the previous version`}{' '}
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
          <summary>New Connection</summary>
          <form onSubmit={addConnection}>
            <input name="name" placeholder="Name" required />
            <input name="port" type="number" defaultValue={7400} min={1} max={65535} required aria-label="Agent port" />
            <input name="token" placeholder="Access Token" required autoComplete="off" />
            <fieldset>
              <legend>Remote Agent, through SSH</legend>
              <input name="sshHost" placeholder="Host (empty if the Agent is on this machine)" />
              <input name="sshUser" placeholder="User" />
              <input name="sshPort" type="number" min={1} max={65535} placeholder="SSH port (22)" />
              <input name="sshKey" placeholder="Key path (~/.ssh/id_ed25519)" />
            </fieldset>
            <button>Add</button>
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
                  {state === 'active' && <button onClick={() => act('pause')}>Pause</button>}
                  {state === 'paused' && <button onClick={() => act('resume')}>Resume</button>}
                  {state !== 'completed' && <button onClick={() => act('complete')}>Complete</button>}
                  {state === 'completed' && <button onClick={() => act('reopen')}>Reopen</button>}
                  {state === 'completed' &&
                    (confirmDelete ? (
                      <button className="danger" onClick={() => act('delete')}>
                        Delete permanently?
                      </button>
                    ) : (
                      <button onClick={() => setConfirmDelete(true)}>Delete</button>
                    ))}
                </div>
              )}
            </header>
            {state === 'completed' && task.deleteAt && (
              <p className="muted">Task is completed and will be deleted on {new Date(task.deleteAt).toLocaleDateString()}.</p>
            )}
            {!agentOnline && <p className="warn">Agent is unreachable. The Session keeps running on it, and the history will load after reconnecting.</p>}
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
          <p className="muted">Select or create a Task.</p>
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
