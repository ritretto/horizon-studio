import { query, type Query, type SDKMessage, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import type { EngineAvailability, EngineStatus, PermissionMode, SessionItem } from '@horizon/protocol';

/** A running Engine for one Session. */
export interface EngineRun {
  send(text: string): void;
  close(): void;
}

export interface EngineOptions {
  cwd: string;
  permissionMode: PermissionMode;
  /** Engine conversation id to continue. */
  resume?: string;
  /** Recorded user input to restore only if the saved Engine conversation has no rollout. */
  initialInput?: string;
  onItem(item: SessionItem): void;
  onEngineSessionId(id: string): void;
  /** The process has ended. Future messages must start a new Engine. */
  onExit(): void;
  /** Decision on a permission request; `always` means do not ask about this again in this Session. */
  askPermission(req: { tool: string; input: unknown; reason?: string }): Promise<{ allow: boolean; always: boolean }>;
}

export interface Engine {
  (opts: EngineOptions): EngineRun;
  /** Whether the Engine is ready on this machine; without a check it counts as ready. */
  status?(): Promise<EngineStatus | EngineAvailability>;
}

/** Claude Code through the Claude Agent SDK, in streaming input mode: one process per Session. */
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
        // The Engine asks questions as plain text at the end of a turn, and the user answers in the chat.
        disallowedTools: ['AskUserQuestion'],
        canUseTool: async (tool, input, { suggestions, decisionReason }) => {
          const { allow, always } = await opts.askPermission({ tool, input, reason: decisionReason });
          return allow
            ? { behavior: 'allow', updatedInput: input, updatedPermissions: always ? suggestions : undefined }
            : { behavior: 'deny', message: 'The user denied this action' };
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

  /** Claude Code starts without a prompt and reports which account it runs under. */
  engine.status = async () => {
    let q: Query | undefined;
    try {
      q = runQuery({ prompt: new Inbox<SDKUserMessage>() }); // throws at once without the Claude Code binary
      const a = await q.accountInfo();
      // Third-party providers (Bedrock, Vertex…) authenticate outside Claude Code, so they count as ready.
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
      if (msg.parent_tool_use_id) return; // subagent events are not shown yet
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

/** Async queue: the SDK reads user messages from it. */
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
