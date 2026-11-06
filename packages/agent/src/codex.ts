import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import type { Engine, EngineOptions } from './engine.ts';
import type { SessionItem } from '@horizon/protocol';

type RpcId = string | number;
type Message = {
  id?: RpcId;
  method?: string;
  params?: Record<string, any>;
  result?: any;
  error?: { message: string };
};

type Launch = (cwd?: string) => ChildProcessWithoutNullStreams;

// A standalone app-server must not reuse the desktop app's launch context.
// Keep user configuration and credentials such as CODEX_HOME and CODEX_ACCESS_TOKEN.
export function codexEnvironment(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env = { ...source };
  const internal = new Set([
    'CODEX_WINDOWS_REGISTERED_CORE', 'CODEX_WINDOWS_SANDBOX_PACKAGE_FAMILY',
    'CODEX_PERMISSION_PROFILE', 'CODEX_SESSION_ID', 'CODEX_THREAD_ID', 'CODEX_TOOL_CALL_ID',
    'CODEX_TASK_WORKSPACE_VERIFYING_IDENTITY', 'CODEX_INTERNAL_ORIGINATOR_OVERRIDE',
    'CODEX_MCP_NODE_PATH', 'CODEX_TECTONIC_PATH', 'CODEX_SHELL',
  ]);
  for (const key of Object.keys(env)) {
    if (key.startsWith('CODEX_APP_') || internal.has(key)) delete env[key];
  }
  return env;
}

const launchCodex: Launch = (cwd) =>
  spawn(process.env.HORIZON_CODEX_EXECUTABLE || 'codex', ['app-server', '--listen', 'stdio://'], {
    cwd, windowsHide: true, env: codexEnvironment(),
  });

class AppServer {
  private child: ChildProcessWithoutNullStreams;
  private nextId = 0;
  private closed = false;
  private pending = new Map<RpcId, (message: Message) => void>();

  constructor(launch: Launch, cwd: string | undefined, onEvent: (message: Message) => void, onExit: (error: Error) => void) {
    this.child = launch(cwd);
    this.child.stderr.resume();
    const lines = createInterface({ input: this.child.stdout });
    const fail = (error: Error) => {
      if (this.closed) return;
      this.close(error);
      onExit(error);
    };
    this.child.once('error', fail);
    this.child.stdin.on('error', fail);
    this.child.once('close', (code, signal) => fail(new Error(`Codex app-server exited (${code ?? signal})`)));
    lines.on('line', (line) => {
      if (this.closed) return;
      try {
        const message: Message = JSON.parse(line);
        if (message.method) onEvent(message);
        else if (message.id !== undefined) this.pending.get(message.id)?.(message);
      } catch {
        fail(new Error('Invalid message from Codex app-server'));
      }
    });
  }

  async initialize() {
    await this.request('initialize', { clientInfo: { name: 'horizon_studio', title: 'Horizon Studio', version: '0.1.0' } });
    this.write({ method: 'initialized' });
  }

  request(method: string, params: object): Promise<any> {
    if (this.closed) return Promise.reject(new Error('Codex app-server is closed'));
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.pending.get(id)?.({ error: { message: `Codex ${method} timed out` } }), 15_000);
      this.pending.set(id, (message) => {
        clearTimeout(timer);
        this.pending.delete(id);
        if (message.error) reject(new Error(message.error.message));
        else resolve(message.result);
      });
      this.write({ id, method, params });
    });
  }

  write(message: object) {
    if (!this.closed) this.child.stdin.write(JSON.stringify(message) + '\n');
  }

  close(error = new Error('Codex app-server is closed')) {
    if (this.closed) return;
    this.closed = true;
    for (const reply of this.pending.values()) reply({ error });
    this.child.kill();
  }
}

const approvalTools: Record<string, string> = {
  'item/commandExecution/requestApproval': 'Command',
  'item/fileChange/requestApproval': 'File change',
};

function toolEvent(item: Record<string, any>, completed: boolean): SessionItem | undefined {
  const names: Record<string, string> = {
    commandExecution: 'Command',
    fileChange: 'File change',
    mcpToolCall: 'MCP',
    webSearch: 'Web search',
  };
  const name = names[item.type];
  if (!name) return;
  if (!completed) return { kind: 'tool', id: item.id, name, input: item };
  return {
    kind: 'tool_result',
    id: item.id,
    output: item.aggregatedOutput ?? JSON.stringify(item.result ?? item.error ?? item.changes ?? item.status ?? '', null, 2),
    isError: ['failed', 'declined'].includes(item.status) || (item.exitCode != null && item.exitCode !== 0),
  };
}

function connect(launch: Launch, opts: EngineOptions, onExit: (error: Error) => void) {
  const streamed = new Set<string>();
  const tools = new Map<string, Record<string, any>>();
  const rpc = new AppServer(launch, opts.cwd, ({ id, method, params: p = {} }) => {
    if (id !== undefined) {
      const tool = method && Object.hasOwn(approvalTools, method) ? approvalTools[method] : undefined;
      if (!tool) {
        rpc.write({ id, error: { code: -32601, message: 'Unsupported Codex client request' } });
        return;
      }
      const input = { ...tools.get(p.itemId), ...p };
      void opts.askPermission({ tool, input, reason: p.reason ?? undefined }).then(({ allow, always }) => {
        const decision = allow ? (always ? 'acceptForSession' : 'accept') : 'decline';
        const available = p.availableDecisions as unknown[] | undefined;
        const fallback = allow && available?.includes('accept') ? 'accept' : 'cancel';
        rpc.write({ id, result: { decision: !available || available.includes(decision) ? decision : fallback } });
      }, () => rpc.write({ id, result: { decision: 'cancel' } }));
      return;
    }
    switch (method) {
      case 'item/agentMessage/delta':
        streamed.add(p.itemId);
        opts.onItem({ kind: 'text_delta', id: p.itemId, text: p.delta });
        break;
      case 'item/started': {
        const event = toolEvent(p.item, false);
        if (event) {
          tools.set(p.item.id, p.item);
          opts.onItem(event);
        }
        break;
      }
      case 'item/completed': {
        const item = p.item;
        if (item.type === 'agentMessage' && !streamed.delete(item.id) && item.text)
          opts.onItem({ kind: 'text', text: item.text });
        if (tools.delete(item.id)) {
          const event = toolEvent(item, true);
          if (event) opts.onItem(event);
        }
        break;
      }
      case 'turn/completed':
        streamed.clear();
        tools.clear();
        opts.onItem(p.turn.status === 'completed'
          ? { kind: 'turn_end' }
          : { kind: 'turn_end', error: p.turn.error?.message ?? p.turn.status });
        break;
    }
  }, onExit);
  return rpc;
}

export function createCodexEngine(launch: Launch): Engine {
  const engine: Engine = (opts) => {
    let rpc: AppServer | undefined;
    let threadId = opts.resume;
    let closed = false;

    return {
      send(text) {
        if (closed) return;
        const fail = (error: Error) => {
          if (closed || rpc !== active) return;
          rpc = undefined;
          active.close();
          const message = (error as NodeJS.ErrnoException).code === 'ENOENT'
            ? 'Codex CLI not found on Agent. Install it or set HORIZON_CODEX_EXECUTABLE.'
            : error.message;
          opts.onItem({ kind: 'turn_end', error: message });
        };
        const existing = rpc;
        let active: AppServer;
        try {
          active = rpc ??= connect(launch, opts, fail);
        } catch (error) {
          opts.onItem({ kind: 'turn_end', error: error instanceof Error ? error.message : String(error) });
          return;
        }
        void (async () => {
          if (!existing) {
            await active.initialize();
            const result = await active.request(threadId ? 'thread/resume' : 'thread/start', {
              ...(threadId ? { threadId } : {}),
              cwd: opts.cwd,
              approvalPolicy: 'on-request',
              sandbox: 'workspace-write',
            });
            if (closed || rpc !== active) return;
            threadId = result.thread.id;
            opts.onEngineSessionId(result.thread.id);
          }
          await active.request('turn/start', { threadId, input: [{ type: 'text', text }] });
        })().catch(fail);
      },
      close() {
        closed = true;
        rpc?.close();
      },
    };
  };

  engine.status = async () => {
    let missing = false;
    let rpc: AppServer | undefined;
    try {
      rpc = new AppServer(launch, undefined, () => {}, (error) => {
        missing = (error as NodeJS.ErrnoException).code === 'ENOENT';
      });
      await rpc.initialize();
      const { account, requiresOpenaiAuth } = await rpc.request('account/read', { refreshToken: false });
      return account || !requiresOpenaiAuth ? 'ready' : 'no credentials';
    } catch {
      return missing ? 'not installed' : 'unavailable';
    } finally {
      rpc?.close();
    }
  };
  return engine;
}

export const codex = createCodexEngine(launchCodex);
