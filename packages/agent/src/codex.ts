import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createRequire as createCodexRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import type { Engine, EngineOptions } from './engine.ts';
import type { EngineAvailability, EngineStatus } from '@horizon/protocol';
import type { InitializeParams } from './codex-protocol/InitializeParams.ts';
import type { InitializeResponse } from './codex-protocol/InitializeResponse.ts';
import type { RequestId } from './codex-protocol/RequestId.ts';
import type { ServerRequest } from './codex-protocol/ServerRequest.ts';
import type { GetAccountParams } from './codex-protocol/v2/GetAccountParams.ts';
import type { GetAccountResponse } from './codex-protocol/v2/GetAccountResponse.ts';
import type { ThreadStartParams } from './codex-protocol/v2/ThreadStartParams.ts';
import type { ThreadStartResponse } from './codex-protocol/v2/ThreadStartResponse.ts';
import type { ThreadResumeParams } from './codex-protocol/v2/ThreadResumeParams.ts';
import type { ThreadResumeResponse } from './codex-protocol/v2/ThreadResumeResponse.ts';
import type { TurnStartParams } from './codex-protocol/v2/TurnStartParams.ts';
import type { TurnStartResponse } from './codex-protocol/v2/TurnStartResponse.ts';
import type { ItemCompletedNotification } from './codex-protocol/v2/ItemCompletedNotification.ts';
import type { ItemStartedNotification } from './codex-protocol/v2/ItemStartedNotification.ts';
import type { TurnCompletedNotification } from './codex-protocol/v2/TurnCompletedNotification.ts';
import type { CommandExecutionRequestApprovalResponse } from './codex-protocol/v2/CommandExecutionRequestApprovalResponse.ts';
import type { FileChangeRequestApprovalResponse } from './codex-protocol/v2/FileChangeRequestApprovalResponse.ts';

type RpcMethods = {
  initialize: [InitializeParams, InitializeResponse];
  'account/read': [GetAccountParams, GetAccountResponse];
  'thread/start': [ThreadStartParams, ThreadStartResponse];
  'thread/resume': [ThreadResumeParams, ThreadResumeResponse];
  'turn/start': [TurnStartParams, TurnStartResponse];
};
type Message = {
  id?: RequestId;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { message: string };
};
type Launch = (cwd?: string) => ChildProcessWithoutNullStreams;
type FileChange = Extract<ItemStartedNotification['item'], { type: 'fileChange' }>;
const require = createCodexRequire(import.meta.url);

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

const launchCodex = (cwd?: string, sqliteHome?: string) =>
  spawn(process.execPath, [require.resolve('@openai/codex/bin/codex.js'), 'app-server', '--listen', 'stdio://',
    ...(sqliteHome ? ['-c', `sqlite_home=${JSON.stringify(sqliteHome)}`] : [])], {
    cwd, windowsHide: true, env: codexEnvironment(),
  });

class AppServer {
  private child: ChildProcessWithoutNullStreams;
  private nextId = 0;
  private closed = false;
  private pending = new Map<RequestId, (message: Message) => void>();

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
        if (!message || typeof message !== 'object') throw new Error('Invalid envelope');
        if (message.method) onEvent(message);
        else if (message.id !== undefined) this.pending.get(message.id)?.(message);
      } catch {
        fail(new Error('Invalid message from Codex app-server'));
      }
    });
  }

  async initialize() {
    await this.request('initialize', {
      clientInfo: { name: 'horizon_studio', title: 'Horizon Studio', version: '0.1.0' },
      capabilities: null,
    });
    this.write({ method: 'initialized' });
  }

  request<K extends keyof RpcMethods>(method: K, params: RpcMethods[K][0]): Promise<RpcMethods[K][1]> {
    if (this.closed) return Promise.reject(new Error('Codex app-server is closed'));
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.pending.get(id)?.({ error: { message: `Codex ${method} timed out` } }), 15_000);
      this.pending.set(id, (message) => {
        clearTimeout(timer);
        this.pending.delete(id);
        if (message.error) reject(new Error(message.error.message));
        else resolve(message.result as RpcMethods[K][1]);
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
    // Node's Windows CLI wrapper owns the native process and its tools.
    if (this.child.exitCode !== null || this.child.signalCode !== null) return;
    if (process.platform === 'win32' && this.child.pid) {
      spawn('taskkill', ['/PID', String(this.child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
        .on('error', () => this.child.kill());
    } else {
      this.child.kill();
    }
  }
}

function completedItem(item: ItemCompletedNotification['item'], opts: EngineOptions) {
  let name: string;
  let output: string;
  let isError: boolean;
  switch (item.type) {
    case 'agentMessage':
      if (item.text) opts.onItem({ kind: 'text', text: item.text });
      return;
    case 'commandExecution':
      name = 'Command';
      output = item.aggregatedOutput ?? '';
      isError = item.status === 'failed' || item.status === 'declined' || (item.exitCode != null && item.exitCode !== 0);
      break;
    case 'fileChange':
      name = 'File change';
      output = JSON.stringify(item.changes, null, 2);
      isError = item.status === 'failed' || item.status === 'declined';
      break;
    case 'mcpToolCall':
      name = `${item.server}/${item.tool}`;
      output = JSON.stringify(item.result ?? item.error ?? '', null, 2);
      isError = item.status === 'failed' || !!item.error;
      break;
    default:
      return;
  }
  opts.onItem({ kind: 'tool', id: item.id, name, input: item });
  opts.onItem({ kind: 'tool_result', id: item.id, output, isError });
}

export function createCodexEngine(launch: Launch, platform: NodeJS.Platform = process.platform): Engine {
  const engine: Engine = (opts) => {
    let rpc: AppServer | undefined;
    let ready: Promise<string> | undefined;
    let threadId = opts.resume;
    let closed = false;
    let awaitingTurn = false;
    let restoreInput = false;
    const approvals = new Set<RequestId>();
    const fileChanges = new Map<string, { turnId: string; changes: FileChange['changes'] }>();

    const fail = (error: unknown) => {
      if (closed) return;
      closed = true;
      approvals.clear();
      fileChanges.clear();
      rpc?.close();
      const message = error instanceof Error ? error.message : String(error);
      if (awaitingTurn) opts.onItem({ kind: 'turn_end', error: message });
      awaitingTurn = false;
      opts.onExit();
    };
    const onEvent = (message: Message) => {
      if (closed) return;
      if (message.id !== undefined) {
        const request = message as ServerRequest;
        if (request.method !== 'item/commandExecution/requestApproval' && request.method !== 'item/fileChange/requestApproval') {
          rpc?.write({ id: request.id, error: { code: -32601, message: 'Unsupported Codex client request' } });
          return;
        }
        if (request.params.threadId !== threadId) {
          rpc?.write({ id: request.id, result: { decision: 'cancel' } });
          return;
        }
        let input: unknown = request.params;
        if (request.method === 'item/fileChange/requestApproval') {
          const proposed = fileChanges.get(request.params.itemId);
          if (!proposed || proposed.turnId !== request.params.turnId || proposed.changes.length === 0) {
            rpc?.write({ id: request.id, result: { decision: 'cancel' } });
            fail(new Error('Codex file change details are unavailable. Send a new message to retry.'));
            return;
          }
          const paths = proposed.changes.flatMap((change) => [change.path,
            ...(change.kind.type === 'update' && change.kind.move_path ? [change.kind.move_path] : [])]);
          input = { ...request.params, paths, changes: proposed.changes };
        }
        approvals.add(request.id);
        void opts.askPermission({
          tool: request.method === 'item/commandExecution/requestApproval' ? 'Command' : 'File change',
          input, reason: request.params.reason ?? undefined,
        }).then(({ allow, always }) => {
          if (closed || !approvals.delete(request.id)) return;
          const result: CommandExecutionRequestApprovalResponse | FileChangeRequestApprovalResponse = {
            decision: allow ? (always ? 'acceptForSession' : 'accept') : 'decline',
          };
          rpc?.write({ id: request.id, result });
        }, () => {
          if (approvals.delete(request.id)) rpc?.write({ id: request.id, result: { decision: 'cancel' } });
        });
        return;
      }
      if (message.method === 'item/started') {
        const params = message.params as ItemStartedNotification;
        if (params.threadId === threadId && params.item.type === 'fileChange')
          fileChanges.set(params.item.id, { turnId: params.turnId, changes: params.item.changes });
      } else if (message.method === 'item/completed') {
        const params = message.params as ItemCompletedNotification;
        if (params.threadId === threadId) {
          fileChanges.delete(params.item.id);
          completedItem(params.item, opts);
        }
      } else if (message.method === 'turn/completed') {
        const params = message.params as TurnCompletedNotification;
        if (params.threadId !== threadId) return;
        approvals.clear();
        fileChanges.clear();
        if (params.turn.status === 'completed') {
          awaitingTurn = false;
          opts.onItem({ kind: 'turn_end' });
        } else fail(new Error(params.turn.error?.message ?? params.turn.status));
      }
    };

    return {
      send(text) {
        if (closed) return;
        awaitingTurn = true;
        try {
          if (!rpc) rpc = new AppServer(launch, opts.cwd, onEvent, fail);
          const active = rpc;
          ready ??= (async () => {
            await active.initialize();
            const policy: ThreadStartParams = {
              cwd: opts.cwd,
              approvalPolicy: opts.permissionMode === 'auto' ? 'never' : 'untrusted',
              approvalsReviewer: 'user',
              sandbox: opts.permissionMode === 'auto' ? 'danger-full-access' : 'workspace-write',
              ...(platform === 'win32' && opts.permissionMode === 'ask' ? { config: { 'windows.sandbox': 'unelevated' } } : {}),
            };
            let result: ThreadStartResponse | ThreadResumeResponse;
            if (threadId) {
              try {
                result = await active.request('thread/resume', { ...policy, threadId });
              } catch (error) {
                // A thread id can arrive before Codex has persisted its first rollout.
                // Only this explicit missing-rollout error permits creating a replacement.
                if (!(error instanceof Error) || !/^no rollout found\b/i.test(error.message) || closed) throw error;
                result = await active.request('thread/start', policy);
                restoreInput = true;
              }
            } else {
              result = await active.request('thread/start', policy);
            }
            threadId = result.thread.id;
            if (!closed) opts.onEngineSessionId(threadId);
            return threadId;
          })();
          void ready.then(async (id) => {
            const input = restoreInput ? opts.initialInput ?? text : text;
            restoreInput = false;
            if (!closed) await active.request('turn/start', {
              threadId: id, input: [{ type: 'text', text: input, text_elements: [] }],
            });
          }).catch(fail);
        } catch (error) {
          fail(error);
        }
      },
      close() {
        closed = true;
        approvals.clear();
        fileChanges.clear();
        rpc?.close();
      },
    };
  };

  engine.status = async (): Promise<EngineStatus | EngineAvailability> => {
    let rpc: AppServer | undefined;
    let missing = false;
    try {
      rpc = new AppServer(launch, undefined, () => {}, (error) => {
        missing = (error as NodeJS.ErrnoException).code === 'ENOENT';
      });
      await rpc.initialize();
      const { account, requiresOpenaiAuth } = await rpc.request('account/read', { refreshToken: false });
      return {
        status: account || !requiresOpenaiAuth ? 'ready' : 'no credentials',
        ...(account ? { loginMethod: account.type } : {}),
      };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      return missing || code === 'ENOENT' || code === 'MODULE_NOT_FOUND' ? 'not installed' : 'unavailable';
    } finally {
      rpc?.close();
    }
  };
  return engine;
}

export function codexForAgent(home: string): Engine {
  return createCodexEngine((cwd) => {
    // Keep the pinned CLI's index separate from other Codex versions and Tasks.
    // Config, auth and resumable rollout files still use the user's CODEX_HOME.
    const sqliteHome = join(cwd ? dirname(cwd) : home, 'codex-state');
    mkdirSync(sqliteHome, { recursive: true, mode: 0o700 });
    return launchCodex(cwd, sqliteHome);
  });
}
