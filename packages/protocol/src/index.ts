// Типы сообщений между Agent, Studio-сервером и фронтом.

export type AccessLevel = 'admin' | 'user';

export interface AgentInfo {
  version: string;
}

/** Отдаётся методом `agent.info`: Agent и Member, от имени которого открыто соединение. */
export interface AgentHello extends AgentInfo {
  member: { id: string; name: string; accessLevel: AccessLevel };
  /** Engine этого Agent и их готовность на его машине. */
  engines: { id: EngineId; status: EngineStatus }[];
}

export interface Request {
  type: 'request';
  id: number;
  method: string;
  params?: unknown;
}

export type Response =
  | { type: 'response'; id: number; result: unknown }
  | { type: 'response'; id: number; error: { message: string } };

// --- Task и Session ---

export type EngineId = 'claude-code';
export type EngineStatus = 'ready' | 'not installed' | 'no credentials';

/** `ask` — каждый запрос разрешения ждёт ответа пользователя (Session в Waiting); `auto` — всё разрешается. */
export type PermissionMode = 'ask' | 'auto';

export type TaskState = 'active' | 'paused' | 'completed';

export interface Task {
  id: string;
  name: string;
  ownerId: string;
  engine: EngineId;
  permissionMode: PermissionMode;
  /**
   * `paused` — все Session остановлены с возможностью продолжить; сами не продолжаются.
   * `completed` — Session остановлены, история и Task Directory сохранены до `deleteAt`; можно переоткрыть в `paused`.
   */
  state: TaskState;
  createdAt: string;
  completedAt?: string;
  /** Когда Agent удалит завершённую Task безвозвратно. */
  deleteAt?: string;
  sessions: { id: string }[];
}

/** Элемент истории Session — не зависит от Engine. */
export type SessionItem =
  | { kind: 'user'; text: string }
  | { kind: 'text'; text: string }
  | { kind: 'tool'; id: string; name: string; input: unknown }
  | { kind: 'tool_result'; id: string; output: string; isError: boolean }
  | { kind: 'permission'; requestId: string; tool: string; input: unknown; reason?: string }
  | { kind: 'permission_answer'; requestId: string; allow: boolean; always: boolean }
  | { kind: 'turn_end'; error?: string }
  /** `interrupted` — Agent перезапустился посреди хода и сам продолжает Session. */
  | { kind: 'status'; status: 'paused' | 'resumed' | 'completed' | 'reopened' | 'interrupted' }
  | { kind: 'error'; message: string };

/**
 * Событие Session. `seq` — сквозной номер в пределах Session.
 * Подписка: `session.subscribe {sessionId, fromSeq}` — досылает события с seq > fromSeq, затем новые.
 */
export interface SessionEvent {
  type: 'event';
  sessionId: string;
  seq: number;
  time: string;
  item: SessionItem;
}

// --- Браузер ↔ Studio-сервер ---
// Запрос с `agentId` Studio-сервер пересылает этому Agent; без `agentId` — обрабатывает сам.

export interface StudioRequest extends Request {
  agentId?: string;
}

/** Удалённый Agent: Studio ходит к нему через SSH-туннель. */
export interface SshTarget {
  host: string;
  user?: string;
  /** Порт SSH, если не 22 и не задан в ~/.ssh/config. */
  port?: number;
  /** Путь к приватному ключу на машине Studio. */
  key?: string;
}

export interface ConnectionInput {
  name: string;
  /** Порт Agent на его машине. */
  port: number;
  token: string;
  ssh?: SshTarget;
}

export interface AgentStatus {
  /** id Connection в Studio. */
  id: string;
  name: string;
  port: number;
  ssh?: SshTarget;
  state: 'connecting' | 'online' | 'offline' | 'unauthorized';
  hello?: AgentHello;
  /** Почему нет связи, например ошибка ssh. */
  error?: string;
}

/** Studio-сервер присылает полный список при подключении и при каждом изменении. */
export interface AgentsEvent {
  type: 'agents';
  agents: AgentStatus[];
}

/** SessionEvent, пересланный Studio-сервером браузеру. */
export interface StudioSessionEvent extends SessionEvent {
  agentId: string;
}
