import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('run: запускает текущую версию, перезапускает после падения, по SIGTERM штатно останавливает Agent', async () => {
  const home = mkdtempSync(join(tmpdir(), 'horizon-launcher-'));
  const runs = join(home, 'runs.txt');
  mkdirSync(join(home, 'versions', '1.0.0'), { recursive: true });
  writeFileSync(join(home, 'current'), '1.0.0\n');
  // Фейковый Agent: первый запуск падает, второй работает и отмечает SIGTERM.
  writeFileSync(
    join(home, 'versions', '1.0.0', 'agent.mjs'),
    `import { appendFileSync, existsSync, readFileSync } from 'node:fs';
const runs = ${JSON.stringify(runs)};
const n = existsSync(runs) ? readFileSync(runs, 'utf8').split('\\n').filter((l) => l.startsWith('start')).length : 0;
appendFileSync(runs, 'start ' + process.argv.slice(2).join(' ') + '\\n');
if (n === 0) process.exit(1);
process.on('SIGTERM', () => { appendFileSync(runs, 'term\\n'); process.exit(0); });
setInterval(() => {}, 1000);
`,
  );
  const launcher = spawn(process.execPath, [join(import.meta.dirname, 'main.ts'), 'run', '--home', home]);
  const lines = () => {
    try {
      return readFileSync(runs, 'utf8').trim().split('\n');
    } catch {
      return []; // Agent ещё не стартовал
    }
  };
  const until = async (n: number) => {
    while (lines().length < n) await new Promise((r) => setTimeout(r, 50));
  };
  await until(2);
  assert.deepEqual(lines(), [`start --home ${home}`, `start --home ${home}`]);
  assert.match(readFileSync(join(home, 'agent.log'), 'utf8'), /Agent 1\.0\.0 завершился \(1\)/);

  const exited = new Promise((r) => launcher.once('exit', r));
  launcher.kill('SIGTERM');
  assert.equal(await exited, 0);
  assert.equal(lines().at(-1), 'term');
});
