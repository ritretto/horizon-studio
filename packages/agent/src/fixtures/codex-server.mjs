import { createInterface } from 'node:readline';
import assert from 'node:assert/strict';

const scenario = process.argv[2];
const write = (message) => console.log(JSON.stringify(message));
let threadId = 'thread-1';
const notify = (method, params) => write({ method, params: { threadId, turnId: 'turn-1', ...params } });
// Codex 0.166.0 sends changes in item/started, not requestApproval.
// Confirmed with a real denied add-file request; rename coverage is synthetic.
const changes = [
  { path: '/task/index.html', kind: { type: 'add' }, diff: '<h1>Hello</h1>\n' },
  { path: '/task/old.css', kind: { type: 'update', move_path: '/task/site.css' }, diff: '-old\n+new\n' },
];
let policy;
createInterface({ input: process.stdin }).on('line', (line) => {
  const { id, method, params, result, error } = JSON.parse(line);
  const reply = (result) => write({ id, result });
  switch (method) {
    case 'initialize': return reply({});
    case 'initialized': return;
    case 'account/read':
      return reply({
        account: ['chatgpt', 'apiKey'].includes(scenario) ? { type: scenario } : null,
        requiresOpenaiAuth: scenario !== 'external',
      });
    case 'thread/resume':
      assert.equal(params.threadId, 'thread-1');
      if (scenario === 'missing-rollout')
        return write({ id, error: { code: -32600, message: 'no rollout found for thread id thread-1' } });
      if (scenario === 'resume-error')
        return write({ id, error: { code: -32603, message: 'Unable to read rollout: permission denied' } });
    case 'thread/start':
      policy = params;
      if (scenario === 'missing-rollout') threadId = 'thread-recovered';
      return reply({ thread: { id: threadId } });
    case 'turn/start':
      assert.equal(params.threadId, threadId);
      assert.deepEqual(params.input[0].text_elements, []);
      if (scenario === 'crash') return process.exit(1);
      if (scenario === 'malformed') return console.log('invalid json');
      reply({ turn: { id: 'turn-1' } });
      if (scenario === 'unsupported')
        return write({ id: 'unsupported', method: 'unknown/request', params: {} });
      if (scenario.startsWith('approval-')) {
        const kind = scenario.startsWith('approval-file') ? 'fileChange' : 'commandExecution';
        if (scenario !== 'approval-file-missing') notify('item/started', { startedAtMs: 0, item: kind === 'fileChange'
          ? { id: 'tool', type: kind, changes, status: 'inProgress' }
          : { id: 'tool', type: kind, command: 'echo test', status: 'inProgress' } });
        return write({
          id: 'approval', method: 'item/' + kind + '/requestApproval',
          params: { threadId, turnId: 'turn-1', itemId: 'tool', startedAtMs: 0,
            ...(kind === 'commandExecution' ? { command: 'echo test' } : { grantRoot: null }), reason: 'test approval' },
        });
      }
      if (scenario === 'error')
        return notify('turn/completed', { turn: { status: 'failed', error: { message: 'Test failure' } } });
      if (scenario === 'interrupted')
        return notify('turn/completed', { turn: { status: 'interrupted' } });
      notify('item/agentMessage/delta', { itemId: 'answer', delta: 'must be ignored' });
      notify('item/completed', { item: { type: 'agentMessage', id: 'answer',
        text: scenario === 'policy' ? JSON.stringify(policy)
          : scenario === 'missing-rollout' ? params.input[0].text : 'completed answer' } });
      notify('turn/completed', { turn: { status: 'completed' } });
      if (scenario === 'idle-exit') setTimeout(() => process.exit(1), 20);
      return;
    default:
      if (id === 'unsupported') {
        assert.equal(error?.code, -32601);
      } else {
        assert.equal(id, 'approval');
        const denied = result.decision === 'decline';
        const item = scenario === 'approval-file'
          ? { type: 'fileChange', id: 'tool', changes, status: denied ? 'declined' : 'completed' }
          : { type: 'commandExecution', id: 'tool', command: 'echo test', aggregatedOutput: result.decision,
              exitCode: denied ? 1 : 0, status: denied ? 'declined' : 'completed' };
        notify('item/completed', { item });
        notify('item/completed', { item: { type: 'agentMessage', id: 'answer', text: result.decision } });
      }
      return notify('turn/completed', { turn: { status: 'completed' } });
  }
});
