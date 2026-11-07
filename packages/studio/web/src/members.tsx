import { useEffect, useState, type FormEvent } from 'react';
import type { AccessLevel, AgentHello, MemberInfo, Response } from '@horizon/protocol';

type Request = (method: string, params?: unknown) => Promise<Response>;

/** Manages one Agent's Members (admin only): creating them, and issuing and revoking Access Tokens. */
export function Members({ request, self }: { request: Request; self: AgentHello['member'] }) {
  const [members, setMembers] = useState<MemberInfo[]>([]);
  // A new token is shown once, because the Agent stores only its hash.
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
            Access Token for <strong>{issued.name}</strong>. It is shown once, so copy it now:
          </p>
          <code>{issued.token}</code>
          <button onClick={() => setIssued(undefined)}>Copied</button>
        </div>
      )}
      {error && <p className="warn">{error}</p>}
      <table>
        <tbody>
          {members.map((m) => (
            <tr key={m.id}>
              <td>
                {m.name} {m.id === self.id && <span className="muted">(you)</span>}
              </td>
              <td className="muted">{m.accessLevel}</td>
              <td>
                {m.tokens.length === 0 && <span className="muted">no tokens, so no access</span>}
                {m.tokens.map((t) => (
                  <div key={t.id} className="token">
                    <span className="muted">
                      token from {new Date(t.createdAt).toLocaleString()}
                      {t.id === self.tokenId && ', used by this Studio'}
                    </span>
                    <button className="link" onClick={() => call('member.revokeToken', { memberId: m.id, tokenId: t.id })}>
                      revoke
                    </button>
                  </div>
                ))}
              </td>
              <td>
                <button onClick={() => issue(m)}>New token</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <form onSubmit={create}>
        <input name="name" placeholder="New Member name" required />
        <select name="accessLevel" defaultValue="user" aria-label="Access Level">
          <option value="user">user: own Tasks only</option>
          <option value="admin">admin: all Tasks and Member management</option>
        </select>
        <button>Create</button>
      </form>
    </div>
  );
}
