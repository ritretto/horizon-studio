import { query, type SDKMessage, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import type { SessionItem } from '@horizon/protocol';

/** Запущенный Engine для одной Session. */
export interface EngineRun {
  send(text: string): void;
  close(): void;
}

export interface EngineOptions {
  cwd: string;
  /** id разговора в Engine для продолжения. */
  resume?: string;
  onItem(item: SessionItem): void;
  onEngineSessionId(id: string): void;
}

export type Engine = (opts: EngineOptions) => EngineRun;

/** Claude Code через Claude Agent SDK, в режиме потокового ввода: один процесс на Session. */
export const claudeCode: Engine = (opts) => {
  const inbox = new Inbox<SDKUserMessage>();
  const q = query({
    prompt: inbox,
    options: {
      cwd: opts.cwd,
      resume: opts.resume,
      // ponytail: до #5 любой запрос разрешения отклоняется — Engine может читать и отвечать, но не менять.
      canUseTool: async () => ({ behavior: 'deny', message: 'Разрешения ещё не поддерживаются в HorizonStudio' }),
    },
  });

  (async () => {
    try {
      for await (const msg of q) toItems(msg, opts);
    } catch (e) {
      opts.onItem({ kind: 'error', message: e instanceof Error ? e.message : String(e) });
      opts.onItem({ kind: 'turn_end', error: 'engine stopped' });
    }
  })();

  return {
    send(text) {
      inbox.push({ type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null });
    },
    close() {
      inbox.end();
      q.close();
    },
  };
};

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
