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
