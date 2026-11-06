import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { SessionItem, StudioSessionEvent, TaskState } from '@horizon/protocol';

type ToolResult = Extract<SessionItem, { kind: 'tool_result' }>;
type Answer = Extract<SessionItem, { kind: 'permission_answer' }>;
export type OnAnswer = (requestId: string, allow: boolean, always: boolean) => void;

interface Props {
  events: StudioSessionEvent[];
  state: TaskState;
  onSend(text: string): void;
  onAnswer: OnAnswer;
}

export function Chat({ events, state, onSend, onAnswer }: Props) {
  const stopped = state !== 'active';
  const [text, setText] = useState('');
  const end = useRef<HTMLDivElement>(null);
  const results = new Map<string, ToolResult>();
  const answers = new Map<string, Answer>();
  for (const e of events) {
    if (e.item.kind === 'tool_result') results.set(e.item.id, e.item);
    if (e.item.kind === 'permission_answer') answers.set(e.item.requestId, e.item);
  }
  const waiting = events.some((e) => e.item.kind === 'permission' && !answers.has(e.item.requestId));
  const last = events.filter((e) => e.item.kind !== 'status').at(-1);
  const busy = !stopped && !!last && last.item.kind !== 'turn_end';

  // The braces are required: in new browsers scrollIntoView returns a Promise, which React would take for a cleanup.
  useEffect(() => {
    end.current?.scrollIntoView({ block: 'end' });
  }, [events.length]);

  function submit(e: FormEvent) {
    e.preventDefault();
    if (!text.trim()) return;
    onSend(text);
    setText('');
  }

  return (
    <section className="chat">
      <div className="items">
        {events.length === 0 && <p className="muted">Describe what needs to be done.</p>}
        {events.map((e) => (
          <Item key={e.seq} item={e.item} results={results} answers={answers} onAnswer={onAnswer} />
        ))}
        {stopped ? (
          <p className="muted">{state === 'paused' ? 'Task is paused' : 'Task is completed'}</p>
        ) : waiting ? (
          <p className="warn">Waiting for your decision</p>
        ) : (
          busy && <p className="muted">Claude is working…</p>
        )}
        <div ref={end} />
      </div>
      <form className="composer" onSubmit={submit}>
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && (e.metaKey || e.ctrlKey) && submit(e)}
          placeholder={
            state === 'paused'
              ? 'Task is paused. Click Resume to continue'
              : state === 'completed'
                ? 'Task is completed. Reopen it to continue'
                : 'Message (⌘/Ctrl+Enter to send)'
          }
          disabled={stopped}
          rows={3}
        />
        <button disabled={stopped}>Send</button>
      </form>
    </section>
  );
}

interface ItemProps {
  item: SessionItem;
  results: Map<string, ToolResult>;
  answers: Map<string, Answer>;
  onAnswer: OnAnswer;
}

function Item({ item, results, answers, onAnswer }: ItemProps) {
  switch (item.kind) {
    case 'user':
      return <div className="msg user">{item.text}</div>;
    case 'text':
      return <div className="msg">{item.text}</div>;
    case 'tool': {
      const res = results.get(item.id);
      return (
        <details className={`tool ${res?.isError ? 'failed' : ''}`}>
          <summary>
            {item.name} <span className="muted">{summary(item.input)}</span>
          </summary>
          <pre>{JSON.stringify(item.input, null, 2)}</pre>
          {res && <pre>{res.output}</pre>}
        </details>
      );
    }
    case 'permission': {
      const answer = answers.get(item.requestId);
      return (
        <div className="permission">
          <div>
            Claude wants to run <strong>{item.tool}</strong> <span className="muted">{summary(item.input)}</span>
          </div>
          {item.reason && <div className="muted">{item.reason}</div>}
          <details>
            <summary>Details</summary>
            <pre>{JSON.stringify(item.input, null, 2)}</pre>
          </details>
          {answer ? (
            <div className={answer.allow ? 'muted' : 'warn'}>
              {answer.allow ? (answer.always ? 'Always allowed for this Session' : 'Allowed') : 'Denied'}
            </div>
          ) : (
            <div className="actions">
              <button onClick={() => onAnswer(item.requestId, true, false)}>Allow</button>
              <button onClick={() => onAnswer(item.requestId, true, true)}>Always allow</button>
              <button onClick={() => onAnswer(item.requestId, false, false)}>Deny</button>
            </div>
          )}
        </div>
      );
    }
    case 'tool_result':
    case 'permission_answer':
      return null; // shown inside their tool / permission
    case 'status':
      return <div className="divider">{statusLabel[item.status]}</div>;
    case 'turn_end':
      return item.error ? <p className="warn">The turn ended with an error: {item.error}</p> : null;
    case 'error':
      return <p className="warn">{item.message}</p>;
  }
}

const statusLabel = {
  paused: 'Paused',
  resumed: 'Resumed',
  completed: 'Completed',
  reopened: 'Reopened',
  interrupted: 'Agent restarted. Continuing from where it stopped',
};

function summary(input: unknown): string {
  const v = input as Record<string, unknown>;
  const s = String(v?.command ?? v?.file_path ?? v?.pattern ?? v?.url ?? '');
  return s.length > 80 ? '…' + s.slice(-80) : s; // the end of a path matters most
}
