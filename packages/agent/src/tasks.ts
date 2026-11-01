import { randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PermissionMode, SessionEvent, SessionItem, Task } from '@horizon/protocol';
import type { Engine, EngineRun } from './engine.ts';
import type { Member } from './members.ts';

interface StoredTask extends Task {
  sessions: { id: string; engineSessionId?: string }[];
}

type Listener = (e: SessionEvent) => void;

/**
 * Task и их Session в `<Agent Home>/tasks/<taskId>/`:
 * `task.json`, `workspace/` (Task Directory), `sessions/<sessionId>.jsonl` (журнал событий).
 */
export class Tasks {
  private dir: string;
  private tasks = new Map<string, StoredTask>();
  private sessions = new Map<string, Session>();
  private engine: Engine;

  constructor(home: string, engine: Engine) {
    this.dir = join(home, 'tasks');
    this.engine = engine;
    mkdirSync(this.dir, { recursive: true });
    for (const id of readdirSync(this.dir)) {
      const t: StoredTask = JSON.parse(readFileSync(join(this.dir, id, 'task.json'), 'utf8'));
      this.tasks.set(t.id, t);
    }
  }

  create(name: string, owner: Member, permissionMode: PermissionMode): Task {
    const task: StoredTask = {
      id: randomUUID(),
      name,
      ownerId: owner.id,
      engine: 'claude-code',
      permissionMode,
      createdAt: new Date().toISOString(),
      sessions: [{ id: randomUUID() }],
    };
    mkdirSync(join(this.dir, task.id, 'workspace'), { recursive: true });
    mkdirSync(join(this.dir, task.id, 'sessions'));
    this.tasks.set(task.id, task);
    this.save(task);
    return publicTask(task);
  }

  list(member: Member): Task[] {
    return [...this.tasks.values()].filter((t) => canSee(member, t)).map(publicTask);
  }

  /** Session по id, если Member её видит. */
  session(sessionId: string, member: Member): Session | undefined {
    const task = [...this.tasks.values()].find((t) => t.sessions.some((s) => s.id === sessionId));
    if (!task || !canSee(member, task)) return;
    let s = this.sessions.get(sessionId);
    if (!s) {
      const stored = task.sessions.find((x) => x.id === sessionId)!;
      s = new Session(this.dir, task, stored, this.engine, () => this.save(task));
      this.sessions.set(sessionId, s);
    }
    return s;
  }

  private save(task: StoredTask) {
    writeFileSync(join(this.dir, task.id, 'task.json'), JSON.stringify(task, null, 2));
  }
}

const canSee = (m: Member, t: Task) => m.accessLevel === 'admin' || t.ownerId === m.id;
const publicTask = (t: StoredTask): Task => ({ ...t, sessions: t.sessions.map(({ id }) => ({ id })) });

export class Session {
  private log: string;
  private cwd: string;
  private seq: number;
  private listeners = new Set<Listener>();
  private run?: EngineRun;
  private pending = new Map<string, (answer: { allow: boolean; always: boolean }) => void>();
  private permissionMode: PermissionMode;
  private stored: StoredTask['sessions'][number];
  private engine: Engine;
  private save: () => void;

  constructor(dir: string, task: Task, stored: StoredTask['sessions'][number], engine: Engine, save: () => void) {
    this.stored = stored;
    this.permissionMode = task.permissionMode;
    this.engine = engine;
    this.save = save;
    this.cwd = join(dir, task.id, 'workspace');
    this.log = join(dir, task.id, 'sessions', `${stored.id}.jsonl`);
    this.seq = this.history(0).length;
  }

  send(text: string) {
    this.append({ kind: 'user', text });
    this.run ??= this.engine({
      cwd: this.cwd,
      resume: this.stored.engineSessionId,
      onItem: (item) => this.append(item),
      onEngineSessionId: (id) => {
        this.stored.engineSessionId = id;
        this.save();
      },
      askPermission: (req) => {
        if (this.permissionMode === 'auto') return Promise.resolve({ allow: true, always: false });
        const requestId = randomUUID();
        this.append({ kind: 'permission', requestId, ...req });
        return new Promise((resolve) => this.pending.set(requestId, resolve));
      },
    });
    this.run.send(text);
  }

  /** Ответ на запрос разрешения; false, если такого ожидающего запроса нет. */
  answer(requestId: string, allow: boolean, always: boolean): boolean {
    const resolve = this.pending.get(requestId);
    if (!resolve) return false;
    this.pending.delete(requestId);
    this.append({ kind: 'permission_answer', requestId, allow, always });
    resolve({ allow, always });
    return true;
  }

  /** Отдаёт историю с seq > fromSeq, затем новые события; возвращает отписку. */
  subscribe(fromSeq: number, listener: Listener): () => void {
    for (const e of this.history(fromSeq)) listener(e);
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private history(fromSeq: number): SessionEvent[] {
    if (!existsSync(this.log)) return [];
    return readFileSync(this.log, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as SessionEvent)
      .filter((e) => e.seq > fromSeq);
  }

  private append(item: SessionItem) {
    const e: SessionEvent = { type: 'event', sessionId: this.stored.id, seq: ++this.seq, time: new Date().toISOString(), item };
    appendFileSync(this.log, JSON.stringify(e) + '\n');
    for (const l of this.listeners) l(e);
  }
}
