import { StrictMode, useState, type FormEvent } from 'react';
import { createRoot } from 'react-dom/client';
import type { AgentStatus } from '@horizon/protocol';
import { useStudio } from './studio.ts';
import './style.css';

const stateLabel: Record<AgentStatus['state'], string> = {
  connecting: 'подключение…',
  online: 'online',
  offline: 'offline',
  unauthorized: 'неверный токен',
};

function App() {
  const { agents, connected, request } = useStudio();
  const [error, setError] = useState('');

  async function add(e: FormEvent<HTMLFormElement>) {
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
    <main>
      <h1>HorizonStudio</h1>
      {!connected && <p className="warn">Нет связи со Studio-сервером, переподключаемся…</p>}

      <h2>Agent'ы</h2>
      {agents.length === 0 && <p className="muted">Пока ни одного — добавьте Connection ниже.</p>}
      <ul className="agents">
        {agents.map((a) => (
          <li key={a.id}>
            <span className={`dot ${a.state}`} />
            <strong>{a.name}</strong>
            <span className="muted">127.0.0.1:{a.port}</span>
            <span>{stateLabel[a.state]}</span>
            {a.hello && (
              <span className="muted">
                v{a.hello.version} · {a.hello.member.name} ({a.hello.member.accessLevel})
              </span>
            )}
            <button onClick={() => request('connection.remove', { id: a.id })}>Удалить</button>
          </li>
        ))}
      </ul>

      <h2>Новая Connection</h2>
      <form onSubmit={add}>
        <input name="name" placeholder="Название" required />
        <input name="port" type="number" defaultValue={7400} min={1} max={65535} required aria-label="Порт" />
        <input name="token" placeholder="Access Token" required autoComplete="off" />
        <button>Добавить</button>
      </form>
      {error && <p className="warn">{error}</p>}
    </main>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
