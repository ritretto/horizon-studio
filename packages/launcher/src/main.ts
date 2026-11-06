import { spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { installService, uninstallService } from './service.ts';
import { currentVersion, installVersion, makeCurrent, nextVersion, writeUpdate } from './versions.ts';

/** How long a new Agent version may take to start before the Launcher rolls back to the previous one. */
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
  case 'start': // run in the background with no console window (autostart on Windows)
    spawn(process.execPath, [fileURLToPath(import.meta.url), 'run', '--home', home], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    }).unref();
    break;
  case 'install':
    await install(resolve(values.agent ?? fileURLToPath(new URL('../../agent/dist/', import.meta.url))));
    break;
  case 'uninstall':
    uninstallService(home);
    console.log(`Service removed. Agent Home (${home}) was left in place.`);
    break;
  default:
    console.log('horizon-launcher run | start | install [--agent <Agent build>] | uninstall  [--home <Agent Home>]');
    process.exit(positionals[0] ? 1 : 0);
}

/**
 * Keeps the current Agent version running. If an update is requested (`next`), tries the new version:
 * the Agent confirms it after starting; if it does not within TRIAL_MS, or crashes, roll back to `current`.
 */
function run() {
  writeFileSync(join(home, 'launcher.pid'), String(process.pid)); // for stopping on Windows
  const logFile = join(home, 'agent.log');
  let child: ReturnType<typeof spawn>;
  let stopping = false;
  let delay = 1000;

  const start = () => {
    // ponytail: rotation to one file by size at each Agent start.
    if (existsSync(logFile) && statSync(logFile).size > 10 * 1024 * 1024) renameSync(logFile, `${logFile}.1`);
    const log = openSync(logFile, 'a');
    const say = (s: string) => writeSync(log, `[launcher] ${s}\n`);
    const trial = nextVersion(home);
    const version = trial ?? currentVersion(home)!;
    if (trial) say(`trying version ${trial}`);
    const started = Date.now();
    const proc = spawn(process.execPath, [join(home, 'versions', version, 'agent.mjs'), '--home', home], {
      stdio: ['ignore', log, log],
      env: { ...process.env, HORIZON_LAUNCHER: '1' },
      windowsHide: true, // the Launcher has no console; otherwise on Windows the Agent gets its own visible window
    });
    child = proc;

    let timedOut = false;
    const timer =
      trial &&
      setTimeout(() => {
        if (nextVersion(home) !== trial) return; // confirmed
        timedOut = true;
        proc.kill('SIGTERM');
        setTimeout(() => proc.kill('SIGKILL'), 10_000).unref(); // to this process, not the next one
      }, TRIAL_MS);

    proc.on('exit', (code, signal) => {
      clearTimeout(timer || undefined);
      if (stopping) process.exit(0);
      if (trial && nextVersion(home) === trial) {
        const error = timedOut
          ? `did not confirm it was working within ${TRIAL_MS / 1000} s`
          : `exited at startup (${code ?? signal})`;
        say(`version ${trial}: ${error}; rolling back to ${currentVersion(home)}`);
        writeUpdate(home, { version: trial, ok: false, error, at: new Date().toISOString() });
        makeCurrent(home, currentVersion(home)!); // clears next and deletes the failed version
        return start();
      }
      if (nextVersion(home)) return start(); // the Agent exited in order to update
      // If it crashes right after starting, increase the delay to avoid a tight loop.
      delay = Date.now() - started < 10_000 ? Math.min(delay * 2, 30_000) : 1000;
      say(`Agent ${version} exited (${code ?? signal}), restarting in ${delay / 1000} s`);
      setTimeout(start, delay);
    });
  };
  start();

  for (const signal of ['SIGINT', 'SIGTERM'] as const)
    process.on(signal, () => {
      stopping = true;
      child.kill('SIGTERM'); // the Agent closes Sessions gracefully and exits
    });
}

/** Installs an Agent build in the Agent Home, copies itself there and registers a user service. */
async function install(agentDir: string) {
  const self = fileURLToPath(import.meta.url);
  if (!self.endsWith('.mjs')) throw new Error('install must run from the built launcher: npm run build');

  console.log('Installing the Agent and its dependencies…');
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
  installService(home, launcher);

  // Wait for the Agent to start; on first run it prints the admin Access Token.
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 500));
    const log = existsSync(logFile) ? readFileSync(logFile).subarray(logStart).toString() : '';
    if (!log.includes('listening on')) continue;
    console.log(`\n${log.trim()}\n`);
    console.log(`Agent is running as a service. Log: ${logFile}`);
    return;
  }
  console.log(`Agent did not report starting within 30 s. See ${logFile}`);
  process.exitCode = 1;
}
