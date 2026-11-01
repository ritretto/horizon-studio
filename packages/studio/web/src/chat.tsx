import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { SessionItem, StudioSessionEvent } from '@horizon/protocol';

type ToolResult = Extract<SessionItem, { kind: 'tool_result' }>;

export function Chat({ events, onSend }: { events: StudioSessionEvent[]; onSend(text: string): void }) {
  const [text, setText] = useState('');
  const end = useRef<HTMLDivElement>(null);
  const results = new Map<string, ToolResult>();
  for (const e of events) if (e.item.kind === 'tool_result') results.set(e.item.id, e.item);
  const busy = events.length > 0 && events[events.length - 1].item.kind !== 'turn_end';

  // Без фигурных скобок нельзя: в новых браузерах scrollIntoView возвращает Promise, а React примет его за cleanup.
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
        {events.length === 0 && <p className="muted">Напишите, что нужно сделать.</p>}
        {events.map((e) => (
          <Item key={e.seq} item={e.item} results={results} />
        ))}
        {busy && <p className="muted">Claude работает…</p>}
        <div ref={end} />
      </div>
      <form className="composer" onSubmit={submit}>
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && (e.metaKey || e.ctrlKey) && submit(e)}
          placeholder="Сообщение (⌘/Ctrl+Enter — отправить)"
          rows={3}
        />
        <button>Отправить</button>
      </form>
    </section>
  );
}

function Item({ item, results }: { item: SessionItem; results: Map<string, ToolResult> }) {
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
    case 'tool_result':
      return null; // показывается внутри своего tool
    case 'turn_end':
      return item.error ? <p className="warn">Ход завершился с ошибкой: {item.error}</p> : null;
    case 'error':
      return <p className="warn">{item.message}</p>;
  }
}

function summary(input: unknown): string {
  const v = input as Record<string, unknown>;
  const s = String(v?.command ?? v?.file_path ?? v?.pattern ?? v?.url ?? '');
  return s.length > 80 ? s.slice(0, 80) + '…' : s;
}
