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
