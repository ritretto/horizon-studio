import { useEffect, useState, type FormEvent } from 'react';
import type { AccessLevel, AgentHello, MemberInfo, Response } from '@horizon/protocol';

type Request = (method: string, params?: unknown) => Promise<Response>;

/** Управление Member одного Agent (только admin): создание, выпуск и отзыв Access Token. */
export function Members({ request, self }: { request: Request; self: AgentHello['member'] }) {
  const [members, setMembers] = useState<MemberInfo[]>([]);
  // Новый токен показывается один раз — Agent хранит только его хэш.
  const [issued, setIssued] = useState<{ name: string; token: string }>();
  const [error, setError] = useState('');

  const load = async () => {
    const res = await request('member.list');
    if ('result' in res) setMembers(res.result as MemberInfo[]);
  };
  useEffect(() => void load(), []);

  async function call(method: string, params: unknown) {
    const res = await request(method, params);
    if ('error' in res) setError(res.error.message);
    else setError('');
    await load();
    return 'result' in res ? (res.result as { token?: string } | null) : undefined;
  }

  async function create(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const data = new FormData(form);
    const name = String(data.get('name')).trim();
    const res = await call('member.create', { name, accessLevel: data.get('accessLevel') as AccessLevel });
    if (res?.token) setIssued({ name, token: res.token });
    form.reset();
  }

  async function issue(m: MemberInfo) {
    const res = await call('member.issueToken', { memberId: m.id });
    if (res?.token) setIssued({ name: m.name, token: res.token });
  }

  return (
    <div className="members">
      <h2>Member</h2>
      {issued && (
        <div className="issued">
          <p>
            Access Token для <strong>{issued.name}</strong> — показывается один раз, скопируйте его:
          </p>
          <code>{issued.token}</code>
          <button onClick={() => setIssued(undefined)}>Скопировал</button>
        </div>
      )}
      {error && <p className="warn">{error}</p>}
      <table>
        <tbody>
          {members.map((m) => (
            <tr key={m.id}>
              <td>
                {m.name} {m.id === self.id && <span className="muted">(вы)</span>}
              </td>
              <td className="muted">{m.accessLevel}</td>
              <td>
                {m.tokens.length === 0 && <span className="muted">нет токенов — доступа нет</span>}
                {m.tokens.map((t) => (
                  <div key={t.id} className="token">
                    <span className="muted">
                      токен от {new Date(t.createdAt).toLocaleString()}
                      {t.id === self.tokenId && ' — им подключена эта Studio'}
                    </span>
                    <button className="link" onClick={() => call('member.revokeToken', { memberId: m.id, tokenId: t.id })}>
                      отозвать
                    </button>
                  </div>
                ))}
              </td>
              <td>
                <button onClick={() => issue(m)}>Новый токен</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <form onSubmit={create}>
        <input name="name" placeholder="Имя нового Member" required />
        <select name="accessLevel" defaultValue="user" aria-label="Access Level">
          <option value="user">user — только свои Task</option>
          <option value="admin">admin — все Task и управление Member</option>
        </select>
        <button>Создать</button>
      </form>
    </div>
  );
}
