import { randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PermissionMode, SessionEvent, SessionItem, Task, TaskState } from '@horizon/protocol';
import type { Engine, EngineRun } from './engine.ts';
import type { Member } from './members.ts';

interface StoredSession {
  id: string;
  engineSessionId?: string;
  /** Пауза пришлась на середину хода — при продолжении Engine надо попросить доделать. */
  pausedMidTurn?: boolean;
}

interface StoredTask extends Task {
  sessions: StoredSession[];
}

const RECOVER_PROMPT =
  '[HorizonStudio] Agent был перезапущен (сбой, перезагрузка или обновление), и твой ход прервался. Проверь состояние (git status, незавершённые команды, lock-файлы), исправь что нужно и продолжай. Если не получается — опиши проблему и спроси пользователя.';

const CONTINUE_PROMPT =
  '[HorizonStudio] Task продолжена после паузы. Твой предыдущий ход был прерван — проверь состояние и продолжай с того места, где остановился.';

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
  private retentionMs: number;
  /** Изменился список Task или состояние одной из них. */
  onChange = () => {};

  constructor(home: string, engine: Engine, retentionDays: number) {
    this.dir = join(home, 'tasks');
    this.engine = engine;
    this.retentionMs = retentionDays * 24 * 60 * 60 * 1000;
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
      state: 'active',
      createdAt: new Date().toISOString(),
      sessions: [{ id: randomUUID() }],
    };
    mkdirSync(join(this.dir, task.id, 'workspace'), { recursive: true });
    mkdirSync(join(this.dir, task.id, 'sessions'));
    this.tasks.set(task.id, task);
    this.save(task);
    return this.public(task);
  }

  list(member: Member): Task[] {
    return [...this.tasks.values()].filter((t) => canSee(member, t)).map((t) => this.public(t));
  }

  /** Session по id, если Member её видит. */
  session(sessionId: string, member: Member): Session | undefined {
    const task = [...this.tasks.values()].find((t) => t.sessions.some((s) => s.id === sessionId));
    if (!task || !canSee(member, task)) return;
    return this.load(task, sessionId);
  }

  /** Пауза: все Session Task корректно останавливаются; id разговоров Engine сохранены. */
  pause(taskId: string, member: Member) {
    return this.transition(taskId, member, 'active', 'paused', (s) => s.stop('paused'));
  }

  resume(taskId: string, member: Member) {
    return this.transition(taskId, member, 'paused', 'active', (s) => s.resume());
  }

  complete(taskId: string, member: Member) {
    return this.transition(taskId, member, ['active', 'paused'], 'completed', (s) => s.stop('completed'));
  }

  /** Завершённая Task возвращается на паузу — дальше как обычно «Продолжить». */
  reopen(taskId: string, member: Member) {
    return this.transition(taskId, member, 'completed', 'paused', (s) => s.reopened());
  }

  /** Безвозвратно удаляет завершённую Task; false — нет такой, нет прав или она не завершена. */
  delete(taskId: string, member: Member): boolean {
    const task = this.tasks.get(taskId);
    if (!task || !canSee(member, task) || task.state !== 'completed') return false;
    this.remove(task);
    return true;
  }

  /** После перезапуска Agent продолжает Session активных Task, прерванные посреди хода. */
  recover() {
    for (const task of this.tasks.values()) {
      if ((task.state ?? 'active') !== 'active') continue;
      for (const s of task.sessions) {
        const session = this.load(task, s.id);
        if (session.interrupted) session.recover();
      }
    }
  }

  /**
   * Штатная остановка Agent: закрывает процессы Engine, не трогая состояние Task —
   * прерванные ходы продолжатся при следующем старте (recover).
   * ponytail: при жёстком сбое (kill -9) процесс Engine живёт ещё несколько секунд и доделывает текущую команду;
   * если это станет проблемой — запоминать PID через spawnClaudeCodeProcess и добивать при старте.
   */
  shutdown() {
    for (const s of this.sessions.values()) s.stop();
  }

  /** Удаляет завершённые Task, срок хранения которых истёк. */
  purge(now = Date.now()) {
    for (const t of this.tasks.values()) if (t.state === 'completed' && Date.parse(this.public(t).deleteAt!) <= now) this.remove(t);
  }

  private transition(
    taskId: string,
    member: Member,
    from: TaskState | TaskState[],
    to: TaskState,
    apply: (s: Session) => void,
  ): Task | string {
    const task = this.tasks.get(taskId);
    if (!task || !canSee(member, task)) return 'unknown task';
    if (task.state === to) return this.public(task);
    if (![from].flat().includes(task.state ?? 'active')) return `Task is ${task.state}`;
    task.state = to;
    task.completedAt = to === 'completed' ? new Date().toISOString() : undefined;
    this.save(task);
    for (const s of task.sessions) apply(this.load(task, s.id));
    this.save(task);
    return this.public(task);
  }

  private remove(task: StoredTask) {
    for (const s of task.sessions) {
      this.sessions.get(s.id)?.stop();
      this.sessions.delete(s.id);
    }
    this.tasks.delete(task.id);
    rmSync(join(this.dir, task.id), { recursive: true, force: true });
    this.onChange();
  }

  private public(t: StoredTask): Task {
    const deleteAt = t.completedAt && new Date(Date.parse(t.completedAt) + this.retentionMs).toISOString();
    return { ...t, deleteAt, sessions: t.sessions.map(({ id }) => ({ id })) };
  }

  private load(task: StoredTask, sessionId: string): Session {
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
    this.onChange();
  }
}

const canSee = (m: Member, t: Task) => m.accessLevel === 'admin' || t.ownerId === m.id;

export class Session {
  private log: string;
  private cwd: string;
  private seq: number;
  private midTurn: boolean;
  private listeners = new Set<Listener>();
  private run?: EngineRun;
  /** Номер запуска Engine: события остановленного запуска отбрасываются. */
  private generation = 0;
  private pending = new Map<string, (answer: { allow: boolean; always: boolean }) => void>();
  private task: StoredTask;
  private stored: StoredSession;
  private engine: Engine;
  private save: () => void;

  constructor(dir: string, task: StoredTask, stored: StoredSession, engine: Engine, save: () => void) {
    this.task = task;
    this.stored = stored;
    this.engine = engine;
    this.save = save;
    this.cwd = join(dir, task.id, 'workspace');
    this.log = join(dir, task.id, 'sessions', `${stored.id}.jsonl`);
    const history = this.history(0);
    this.seq = history.length;
    this.midTurn = history.filter((e) => e.item.kind !== 'status').at(-1)?.item.kind !== 'turn_end' && history.length > 0;
  }

  /** Ход шёл, когда Agent остановился (по журналу при загрузке). */
  get interrupted() {
    return this.midTurn && !this.run;
  }

  recover() {
    // Процесса Engine, ждавшего ответа на эти запросы, больше нет.
    const history = this.history(0);
    const answered = new Set(history.map((e) => (e.item.kind === 'permission_answer' ? e.item.requestId : '')));
    for (const { item } of history)
      if (item.kind === 'permission' && !answered.has(item.requestId))
        this.append({ kind: 'permission_answer', requestId: item.requestId, allow: false, always: false });
    this.append({ kind: 'status', status: 'interrupted' });
    this.send(RECOVER_PROMPT);
  }

  /** Отправляет сообщение; false, если Task на паузе или завершена. */
  send(text: string): boolean {
    if (this.task.state === 'paused' || this.task.state === 'completed') return false;
    this.append({ kind: 'user', text });
    this.start().send(text);
    return true;
  }

  /** Останавливает Engine; со статусом — отмечает это в журнале (пауза или завершение). */
  stop(status?: 'paused' | 'completed') {
    this.generation++;
    this.run?.close();
    this.run = undefined;
    // Процесса Engine больше нет — висящие запросы разрешений снимаются.
    for (const [requestId] of this.pending) this.append({ kind: 'permission_answer', requestId, allow: false, always: false });
    this.pending.clear();
    if (!status) return;
    this.stored.pausedMidTurn = this.midTurn;
    this.append({ kind: 'status', status });
  }

  reopened() {
    this.append({ kind: 'status', status: 'reopened' });
  }

  resume() {
    this.append({ kind: 'status', status: 'resumed' });
    if (this.stored.pausedMidTurn) {
      this.stored.pausedMidTurn = false;
      this.save();
      this.send(CONTINUE_PROMPT);
    }
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

  private start(): EngineRun {
    if (this.run) return this.run;
    const generation = this.generation;
    const live = () => generation === this.generation;
    this.run = this.engine({
      cwd: this.cwd,
      resume: this.stored.engineSessionId,
      onItem: (item) => live() && this.append(item),
      onEngineSessionId: (id) => {
        this.stored.engineSessionId = id;
        this.save();
      },
      askPermission: (req) => {
        if (this.task.permissionMode === 'auto') return Promise.resolve({ allow: true, always: false });
        const requestId = randomUUID();
        this.append({ kind: 'permission', requestId, ...req });
        return new Promise((resolve) => this.pending.set(requestId, resolve));
      },
    });
    return this.run;
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
    if (item.kind !== 'status') this.midTurn = item.kind !== 'turn_end';
    const e: SessionEvent = { type: 'event', sessionId: this.stored.id, seq: ++this.seq, time: new Date().toISOString(), item };
    appendFileSync(this.log, JSON.stringify(e) + '\n');
    for (const l of this.listeners) l(e);
  }
}
