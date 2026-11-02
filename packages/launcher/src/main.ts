import { spawn, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { installService, uninstallService } from './service.ts';

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: { home: { type: 'string' }, agent: { type: 'string' } },
});
const home = resolve(values.home ?? join(homedir(), '.horizon-agent'));

switch (positionals[0]) {
  case 'run':
    run();
    break;
  case 'install':
    await install(resolve(values.agent ?? fileURLToPath(new URL('../../agent/dist/', import.meta.url))));
    break;
  case 'uninstall':
    uninstallService();
    console.log(`Сервис удалён. Agent Home (${home}) не тронут.`);
    break;
  default:
    console.log('horizon-launcher run | install [--agent <сборка Agent>] | uninstall  [--home <Agent Home>]');
    process.exit(positionals[0] ? 1 : 0);
}

/** Держит запущенной текущую версию Agent: `<home>/versions/<home/current>/agent.mjs`. */
function run() {
  const logFile = join(home, 'agent.log');
  let child: ReturnType<typeof spawn>;
  let stopping = false;
  let delay = 1000;

  const start = () => {
    // ponytail: ротация одним файлом по размеру при каждом запуске Agent.
    if (existsSync(logFile) && statSync(logFile).size > 10 * 1024 * 1024) renameSync(logFile, `${logFile}.1`);
    const log = openSync(logFile, 'a');
    const version = readFileSync(join(home, 'current'), 'utf8').trim();
    const started = Date.now();
    child = spawn(process.execPath, [join(home, 'versions', version, 'agent.mjs'), '--home', home], {
      stdio: ['ignore', log, log],
    });
    child.on('exit', (code, signal) => {
      if (stopping) process.exit(0);
      // Падает сразу после старта — увеличиваем паузу, чтобы не крутиться в цикле.
      delay = Date.now() - started < 10_000 ? Math.min(delay * 2, 30_000) : 1000;
      writeSync(log, `[launcher] Agent ${version} завершился (${code ?? signal}), перезапуск через ${delay / 1000} с\n`);
      setTimeout(start, delay);
    });
  };
  start();

  for (const signal of ['SIGINT', 'SIGTERM'] as const)
    process.on(signal, () => {
      stopping = true;
      child.kill('SIGTERM'); // Agent штатно закрывает Session и выходит
    });
}

/** Ставит сборку Agent в Agent Home, копирует себя туда же и регистрирует пользовательский сервис. */
async function install(agentDir: string) {
  const self = fileURLToPath(import.meta.url);
  if (!self.endsWith('.mjs')) throw new Error('install запускается из собранного launcher: npm run build');
  const { version } = JSON.parse(readFileSync(join(agentDir, 'package.json'), 'utf8'));

  const dir = join(home, 'versions', version);
  mkdirSync(dir, { recursive: true });
  for (const f of ['agent.mjs', 'package.json']) copyFileSync(join(agentDir, f), join(dir, f));
  console.log(`Agent ${version}: установка зависимостей в ${dir}…`);
  const npm = spawnSync('npm', ['install', '--omit=dev', '--no-audit', '--no-fund'], {
    cwd: dir,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  if (npm.status !== 0) throw new Error('npm install не удался');
  writeFileSync(join(home, 'current'), version);

  const launcher = join(home, 'launcher', 'launcher.mjs');
  mkdirSync(join(home, 'launcher'), { recursive: true });
  copyFileSync(self, launcher);

  const logFile = join(home, 'agent.log');
  const logStart = existsSync(logFile) ? statSync(logFile).size : 0;
  installService(home, [process.execPath, launcher, 'run', '--home', home]);

  // Ждём старта Agent; при первом запуске он печатает Access Token admin.
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 500));
    const log = existsSync(logFile) ? readFileSync(logFile).subarray(logStart).toString() : '';
    if (!log.includes('listening on')) continue;
    console.log(`\n${log.trim()}\n`);
    console.log(`Agent работает как сервис. Лог: ${logFile}`);
    return;
  }
  console.log(`Agent не сообщил о старте за 30 с — смотрите ${logFile}`);
  process.exitCode = 1;
}
