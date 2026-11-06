// Message types between the Agent, the Studio server and the frontend.

export type AccessLevel = 'admin' | 'user';

export interface AgentInfo {
  version: string;
  /** Id of the installed build (`<version>-<hash>`); absent if the Agent was not started by the Launcher. */
  build?: string;
  lastUpdate?: UpdateResult;
}

/** Result of the last Agent Update. */
export interface UpdateResult {
  version: string;
  ok: boolean;
  error?: string;
  at: string;
}

/** Returned by `agent.info`: the Agent and the Member this connection belongs to. */
export interface AgentHello extends AgentInfo {
  /** `tokenId` is the token this connection was opened with. */
  member: { id: string; name: string; accessLevel: AccessLevel; tokenId: string };
  /** This Agent's Engines and whether they are ready on its machine. */
  engines: { id: EngineId; status: EngineStatus }[];
}

/** A Member without secrets, for management from Studio (admin only). */
export interface MemberInfo {
  id: string;
  name: string;
  accessLevel: AccessLevel;
  tokens: { id: string; createdAt: string }[];
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

// --- Task and Session ---

export type EngineId = 'claude-code';
export type EngineStatus = 'ready' | 'not installed' | 'no credentials';

/** `ask`: every permission request waits for the user (Session in Waiting). `auto`: everything is allowed. */
export type PermissionMode = 'ask' | 'auto';

export type TaskState = 'active' | 'paused' | 'completed';

export interface Task {
  id: string;
  name: string;
  ownerId: string;
  engine: EngineId;
  permissionMode: PermissionMode;
  /**
   * `paused`: all Sessions are stopped and can be resumed; they do not continue on their own.
   * `completed`: Sessions are stopped, history and the Task Directory are kept until `deleteAt`; can be reopened to `paused`.
   */
  state: TaskState;
  createdAt: string;
  completedAt?: string;
  /** When the Agent will permanently delete the completed Task. */
  deleteAt?: string;
  sessions: { id: string }[];
}

/** A Session history item; independent of the Engine. */
export type SessionItem =
  | { kind: 'user'; text: string }
  | { kind: 'text'; text: string }
  | { kind: 'tool'; id: string; name: string; input: unknown }
  | { kind: 'tool_result'; id: string; output: string; isError: boolean }
  | { kind: 'permission'; requestId: string; tool: string; input: unknown; reason?: string }
  | { kind: 'permission_answer'; requestId: string; allow: boolean; always: boolean }
  | { kind: 'turn_end'; error?: string }
  /** `interrupted`: the Agent restarted mid-turn and continues the Session on its own. */
  | { kind: 'status'; status: 'paused' | 'resumed' | 'completed' | 'reopened' | 'interrupted' }
  | { kind: 'error'; message: string };

/**
 * A Session event. `seq` is a running number within the Session.
 * Subscribing: `session.subscribe {sessionId, fromSeq}` delivers events with seq > fromSeq, then new ones.
 */
export interface SessionEvent {
  type: 'event';
  sessionId: string;
  seq: number;
  time: string;
  item: SessionItem;
}

// --- Browser ↔ Studio server ---
// The Studio server forwards a request with `agentId` to that Agent, and handles one without `agentId` itself.

export interface StudioRequest extends Request {
  agentId?: string;
}

/** A remote Agent: Studio reaches it through an SSH tunnel. */
export interface SshTarget {
  host: string;
  user?: string;
  /** SSH port, if not 22 and not set in ~/.ssh/config. */
  port?: number;
  /** Path to the private key on the Studio machine. */
  key?: string;
}

export interface ConnectionInput {
  name: string;
  /** The Agent's port on its machine. */
  port: number;
  token: string;
  ssh?: SshTarget;
}

export interface AgentStatus {
  /** Connection id in Studio. */
  id: string;
  name: string;
  port: number;
  ssh?: SshTarget;
  state: 'connecting' | 'online' | 'offline' | 'unauthorized';
  hello?: AgentHello;
  /** Why there is no connection, for example an ssh error. */
  error?: string;
}

/** The Studio server sends the full list on connecting and on every change. */
export interface AgentsEvent {
  type: 'agents';
  agents: AgentStatus[];
}

/** The Agent sends each connection the Task list visible to it on any change. */
export interface TasksEvent {
  type: 'tasks';
  tasks: Task[];
}

/** A TasksEvent forwarded by the Studio server to the browser. */
export interface StudioTasksEvent extends TasksEvent {
  agentId: string;
}

/** A SessionEvent forwarded by the Studio server to the browser. */
export interface StudioSessionEvent extends SessionEvent {
  agentId: string;
}
