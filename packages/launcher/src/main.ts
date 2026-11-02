import { spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, statSync, writeSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { installService, uninstallService } from './service.ts';
import { currentVersion, installVersion, makeCurrent, nextVersion, writeUpdate } from './versions.ts';

/** Сколько новая версия Agent может стартовать, прежде чем Launcher откатится на предыдущую. */
const TRIAL_MS = 30_000;

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

/**
 * Держит запущенной текущую версию Agent. Если запрошено обновление (`next`), пробует новую версию:
 * Agent подтверждает её после старта, а если не подтвердил за TRIAL_MS или упал — откат на `current`.
 */
function run() {
  const logFile = join(home, 'agent.log');
  let child: ReturnType<typeof spawn>;
  let stopping = false;
  let delay = 1000;

  const start = () => {
    // ponytail: ротация одним файлом по размеру при каждом запуске Agent.
    if (existsSync(logFile) && statSync(logFile).size > 10 * 1024 * 1024) renameSync(logFile, `${logFile}.1`);
    const log = openSync(logFile, 'a');
    const say = (s: string) => writeSync(log, `[launcher] ${s}\n`);
    const trial = nextVersion(home);
    const version = trial ?? currentVersion(home)!;
    if (trial) say(`пробую версию ${trial}`);
    const started = Date.now();
    const proc = spawn(process.execPath, [join(home, 'versions', version, 'agent.mjs'), '--home', home], {
      stdio: ['ignore', log, log],
      env: { ...process.env, HORIZON_LAUNCHER: '1' },
    });
    child = proc;

    let timedOut = false;
    const timer =
      trial &&
      setTimeout(() => {
        if (nextVersion(home) !== trial) return; // подтвердил
        timedOut = true;
        proc.kill('SIGTERM');
        setTimeout(() => proc.kill('SIGKILL'), 10_000).unref(); // своему процессу, не следующему
      }, TRIAL_MS);

    proc.on('exit', (code, signal) => {
      clearTimeout(timer || undefined);
      if (stopping) process.exit(0);
      if (trial && nextVersion(home) === trial) {
        const error = timedOut
          ? `не подтвердил работоспособность за ${TRIAL_MS / 1000} с`
          : `завершился при старте (${code ?? signal})`;
        say(`версия ${trial}: ${error} — откат на ${currentVersion(home)}`);
        writeUpdate(home, { version: trial, ok: false, error, at: new Date().toISOString() });
        makeCurrent(home, currentVersion(home)!); // снимает next и удаляет неудачную версию
        return start();
      }
      if (nextVersion(home)) return start(); // Agent вышел, чтобы обновиться
      // Падает сразу после старта — увеличиваем паузу, чтобы не крутиться в цикле.
      delay = Date.now() - started < 10_000 ? Math.min(delay * 2, 30_000) : 1000;
      say(`Agent ${version} завершился (${code ?? signal}), перезапуск через ${delay / 1000} с`);
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

  console.log('Установка Agent и его зависимостей…');
  const id = await installVersion(home, {
    package: JSON.parse(readFileSync(join(agentDir, 'package.json'), 'utf8')),
    agent: readFileSync(join(agentDir, 'agent.mjs'), 'utf8'),
  });
  makeCurrent(home, id);
  console.log(`Agent ${id}`);

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
