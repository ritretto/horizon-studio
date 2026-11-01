// Типы сообщений между Agent, Studio-сервером и фронтом.

export type AccessLevel = 'admin' | 'user';

export interface AgentInfo {
  version: string;
}

/** Отдаётся методом `agent.info`: Agent и Member, от имени которого открыто соединение. */
export interface AgentHello extends AgentInfo {
  member: { id: string; name: string; accessLevel: AccessLevel };
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

export interface Task {
  id: string;
  name: string;
  ownerId: string;
  engine: EngineId;
  createdAt: string;
  sessions: { id: string }[];
}

/** Элемент истории Session — не зависит от Engine. */
export type SessionItem =
  | { kind: 'user'; text: string }
  | { kind: 'text'; text: string }
  | { kind: 'tool'; id: string; name: string; input: unknown }
  | { kind: 'tool_result'; id: string; output: string; isError: boolean }
  | { kind: 'turn_end'; error?: string }
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

export interface ConnectionInput {
  name: string;
  port: number;
  token: string;
}

export interface AgentStatus {
  /** id Connection в Studio. */
  id: string;
  name: string;
  port: number;
  state: 'connecting' | 'online' | 'offline' | 'unauthorized';
  hello?: AgentHello;
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
