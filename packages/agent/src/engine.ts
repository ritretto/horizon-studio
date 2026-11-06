import { query, type Query, type SDKMessage, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import type { EngineAvailability, EngineStatus, PermissionMode, SessionItem } from '@horizon/protocol';

/** Запущенный Engine для одной Session. */
export interface EngineRun {
  send(text: string): void;
  close(): void;
}

export interface EngineOptions {
  cwd: string;
  permissionMode: PermissionMode;
  /** id разговора в Engine для продолжения. */
  resume?: string;
  onItem(item: SessionItem): void;
  onEngineSessionId(id: string): void;
  /** The process has ended. Future messages must start a new Engine. */
  onExit(): void;
  /** Решение по запросу разрешения; `always` — больше не спрашивать о таком в этой Session. */
  askPermission(req: { tool: string; input: unknown; reason?: string }): Promise<{ allow: boolean; always: boolean }>;
}

export interface Engine {
  (opts: EngineOptions): EngineRun;
  /** Готов ли Engine к работе на этой машине; без проверки считается готовым. */
  status?(): Promise<EngineStatus | EngineAvailability>;
}

/** Claude Code через Claude Agent SDK, в режиме потокового ввода: один процесс на Session. */
export function createClaudeEngine(runQuery: typeof query = query): Engine {
  const engine: Engine = (opts) => {
    let closed = false;
    let awaitingTurn = false;
    const inbox = new Inbox<SDKUserMessage>();
    const q = runQuery({
      prompt: inbox,
      options: {
        cwd: opts.cwd,
        resume: opts.resume,
        // Вопросы Engine задаёт обычным текстом в конце хода, пользователь отвечает в чате.
        disallowedTools: ['AskUserQuestion'],
        canUseTool: async (tool, input, { suggestions, decisionReason }) => {
          const { allow, always } = await opts.askPermission({ tool, input, reason: decisionReason });
          return allow
            ? { behavior: 'allow', updatedInput: input, updatedPermissions: always ? suggestions : undefined }
            : { behavior: 'deny', message: 'Пользователь отклонил это действие' };
        },
      },
    });

    (async () => {
      try {
        for await (const msg of q) {
          toItems(msg, opts);
          if (msg.type === 'result') {
            awaitingTurn = false;
            if (msg.subtype !== 'success') break;
          }
        }
        if (!closed && awaitingTurn) opts.onItem({ kind: 'turn_end', error: 'Claude Code process exited' });
      } catch (e) {
        if (!closed) opts.onItem({ kind: 'turn_end', error: e instanceof Error ? e.message : String(e) });
      } finally {
        inbox.end();
        try { q.close(); } finally { if (!closed) opts.onExit(); }
      }
    })();

    return {
      send(text) {
        awaitingTurn = true;
        inbox.push({ type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null });
      },
      close() {
        closed = true;
        inbox.end();
        q.close();
      },
    };
  };

  /** Claude Code стартует без промпта и сообщает, под каким аккаунтом работает. */
  engine.status = async () => {
    let q: Query | undefined;
    try {
      q = runQuery({ prompt: new Inbox<SDKUserMessage>() }); // без бинарника Claude Code бросает сразу
      const a = await q.accountInfo();
      // Сторонние провайдеры (Bedrock, Vertex…) авторизуются вне Claude Code — их считаем готовыми.
      const firstParty = (a.apiProvider ?? 'firstParty') === 'firstParty';
      return firstParty && a.tokenSource === 'none' && !a.apiKeySource ? 'no credentials' : 'ready';
    } catch {
      return 'not installed';
    } finally {
      q?.close();
    }
  };

  return engine;
}

export const claudeCode = createClaudeEngine();

function toItems(msg: SDKMessage, opts: EngineOptions) {
  switch (msg.type) {
    case 'system':
      if (msg.subtype === 'init') opts.onEngineSessionId(msg.session_id);
      return;
    case 'assistant':
      if (msg.parent_tool_use_id) return; // события сабагентов пока не показываем
      for (const b of msg.message.content) {
        if (b.type === 'text') opts.onItem({ kind: 'text', text: b.text });
        else if (b.type === 'tool_use') opts.onItem({ kind: 'tool', id: b.id, name: b.name, input: b.input });
      }
      return;
    case 'user': {
      if (msg.parent_tool_use_id || typeof msg.message.content === 'string') return;
      for (const b of msg.message.content) {
        if (b.type !== 'tool_result') continue;
        const output =
          typeof b.content === 'string'
            ? b.content
            : (b.content ?? []).map((c) => (c.type === 'text' ? c.text : `[${c.type}]`)).join('\n');
        opts.onItem({ kind: 'tool_result', id: b.tool_use_id, output, isError: !!b.is_error });
      }
      return;
    }
    case 'result':
      opts.onItem(msg.subtype === 'success' ? { kind: 'turn_end' } : { kind: 'turn_end', error: msg.subtype });
      return;
  }
}

/** Асинхронная очередь: SDK читает из неё сообщения пользователя. */
class Inbox<T> implements AsyncIterable<T> {
  private items: T[] = [];
  private wake?: () => void;
  private done = false;

  push(item: T) {
    this.items.push(item);
    this.wake?.();
  }

  end() {
    this.done = true;
    this.wake?.();
  }

  async *[Symbol.asyncIterator]() {
    while (true) {
      while (this.items.length) yield this.items.shift()!;
      if (this.done) return;
      await new Promise<void>((r) => (this.wake = r));
    }
  }
}
