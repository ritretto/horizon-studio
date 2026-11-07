import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { currentVersion, installVersion, lastUpdate, makeCurrent, nextVersion } from './versions.ts';

test('run: starts the current version, restarts after a crash, stops the Agent gracefully on SIGTERM', async () => {
  const home = mkdtempSync(join(tmpdir(), 'horizon-launcher-'));
  const runs = join(home, 'runs.txt');
  mkdirSync(join(home, 'versions', '1.0.0'), { recursive: true });
  writeFileSync(join(home, 'current'), '1.0.0\n');
  // Fake Agent: the first run crashes, the second works and records SIGTERM.
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
      return []; // the Agent has not started yet
    }
  };
  const until = async (n: number) => {
    while (lines().length < n) await new Promise((r) => setTimeout(r, 50));
  };
  await until(2);
  assert.deepEqual(lines(), [`start --home ${home}`, `start --home ${home}`]);
  assert.match(readFileSync(join(home, 'agent.log'), 'utf8'), /Agent 1\.0\.0 exited \(1\)/);

  const exited = new Promise((r) => launcher.once('exit', r));
  launcher.kill('SIGTERM');
  assert.equal(await exited, 0);
  assert.equal(lines().at(-1), 'term');
});

test('Agent Update: a failed version is rolled back, a good one is confirmed and becomes current', async () => {
  const home = mkdtempSync(join(tmpdir(), 'horizon-launcher-'));
  const runs = join(home, 'runs.txt');
  const versions = join(import.meta.dirname, 'versions.ts');
  // Fake Agent: records its start with the pid, confirms itself when on trial, and exits on SIGTERM.
  const agent = (version: string, crash = false) => ({
    package: { version },
    agent: `import { appendFileSync } from 'node:fs';
import { basename, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeCurrent, nextVersion } from ${JSON.stringify(versions)};
appendFileSync(${JSON.stringify(runs)}, '${version} ' + process.pid + '\\n');
${crash ? 'process.exit(1);' : ''}
const self = basename(dirname(fileURLToPath(import.meta.url)));
if (nextVersion(${JSON.stringify(home)}) === self) makeCurrent(${JSON.stringify(home)}, self);
process.on('SIGTERM', () => process.exit(0));
setInterval(() => {}, 1000);
`,
  });
  const v1 = await installVersion(home, agent('1.0.0'));
  makeCurrent(home, v1);
  const v2 = await installVersion(home, agent('2.0.0', true));
  writeFileSync(join(home, 'next'), v2);

  const launcher = spawn(process.execPath, [join(import.meta.dirname, 'main.ts'), 'run', '--home', home]);
  const lines = () => (existsSync(runs) ? readFileSync(runs, 'utf8').trim().split('\n') : []);
  const until = async (n: number) => {
    while (lines().length < n) await new Promise((r) => setTimeout(r, 50));
  };

  // 2.0.0 crashes at start → rollback to 1.0.0, the failed version is deleted.
  await until(2);
  assert.deepEqual(lines().map((l) => l.split(' ')[0]), ['2.0.0', '1.0.0']);
  assert.equal(currentVersion(home), v1);
  assert.equal(nextVersion(home), undefined);
  assert.equal(lastUpdate(home)?.ok, false);
  assert.ok(!existsSync(join(home, 'versions', v2)));

  // 3.0.0: Agent 1.0.0 exits for the update, and the new version confirms itself.
  const v3 = await installVersion(home, agent('3.0.0'));
  writeFileSync(join(home, 'next'), v3);
  process.kill(Number(lines()[1].split(' ')[1]), 'SIGTERM');
  await until(3);
  assert.equal(lines()[2].split(' ')[0], '3.0.0');
  while (nextVersion(home)) await new Promise((r) => setTimeout(r, 50));
  assert.equal(currentVersion(home), v3);
  assert.deepEqual(readdirSync(join(home, 'versions')).sort(), [v1, v3].sort(), 'the current and previous versions are kept');

  launcher.kill('SIGTERM');
  await new Promise((r) => launcher.once('exit', r));
});
