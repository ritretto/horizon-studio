import { createInterface } from 'node:readline';
import assert from 'node:assert/strict';

const scenario = process.argv[2];
const write = (message) => console.log(JSON.stringify(message));
const notify = (method, params) => write({ method, params: { threadId: 'thread-1', ...params } });
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
    case 'thread/start':
      policy = params;
      return reply({ thread: { id: 'thread-1' } });
    case 'turn/start':
      assert.deepEqual(params.input[0].text_elements, []);
      if (scenario === 'crash') return process.exit(1);
      if (scenario === 'malformed') return console.log('invalid json');
      reply({ turn: { id: 'turn-1' } });
      if (scenario === 'unsupported')
        return write({ id: 'unsupported', method: 'unknown/request', params: {} });
      if (scenario.startsWith('approval-')) {
        const kind = scenario === 'approval-file' ? 'fileChange' : 'commandExecution';
        notify('item/started', { item: { id: 'tool', type: kind } });
        return write({
          id: 'approval', method: 'item/' + kind + '/requestApproval',
          params: { threadId: 'thread-1', turnId: 'turn-1', itemId: 'tool',
            command: 'echo test', reason: 'test approval' },
        });
      }
      if (scenario === 'error')
        return notify('turn/completed', { turn: { status: 'failed', error: { message: 'Test failure' } } });
      if (scenario === 'interrupted')
        return notify('turn/completed', { turn: { status: 'interrupted' } });
      notify('item/agentMessage/delta', { itemId: 'answer', delta: 'must be ignored' });
      notify('item/completed', { item: { type: 'agentMessage', id: 'answer',
        text: scenario === 'policy' ? JSON.stringify(policy) : 'completed answer' } });
      return notify('turn/completed', { turn: { status: 'completed' } });
    default:
      if (id === 'unsupported') {
        assert.equal(error?.code, -32601);
      } else {
        assert.equal(id, 'approval');
        const denied = result.decision === 'decline';
        const item = scenario === 'approval-file'
          ? { type: 'fileChange', id: 'tool', changes: [], status: denied ? 'declined' : 'completed' }
          : { type: 'commandExecution', id: 'tool', command: 'echo test', aggregatedOutput: result.decision,
              exitCode: denied ? 1 : 0, status: denied ? 'declined' : 'completed' };
        notify('item/completed', { item });
        notify('item/completed', { item: { type: 'agentMessage', id: 'answer', text: result.decision } });
      }
      return notify('turn/completed', { turn: { status: 'completed' } });
  }
});
