import { mkdirSync, readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { makeCurrent, nextVersion, writeUpdate } from '@horizon/launcher/versions';
import type { PermissionMode } from '@horizon/protocol';
import { startAgent } from './agent.ts';

const { values } = parseArgs({ options: { home: { type: 'string' } } });
const home = resolve(values.home ?? join(homedir(), '.horizon-agent'));
mkdirSync(home, { recursive: true });

const configFile = join(home, 'config.json');
const config: { port?: number; defaultPermissionMode?: PermissionMode; completedRetentionDays?: number } = existsSync(configFile)
  ? JSON.parse(readFileSync(configFile, 'utf8'))
  : {};
const port = config.port ?? 7400;

// Под Launcher Agent запущен из <home>/versions/<id>/agent.mjs.
const launcher = process.env.HORIZON_LAUNCHER === '1';
const build = launcher ? basename(dirname(fileURLToPath(import.meta.url))) : undefined;

const { adminToken, stop } = await startAgent(home, port, {
  defaultPermissionMode: config.defaultPermissionMode,
  completedRetentionDays: config.completedRetentionDays,
  build,
  restart: launcher
    ? () => {
        stop();
        process.exit(0);
      }
    : undefined,
});
// Новая версия поднялась и слушает порт — подтверждаем её, иначе Launcher откатится.
if (build && nextVersion(home) === build) {
  makeCurrent(home, build);
  writeUpdate(home, { version: build, ok: true, at: new Date().toISOString() });
}
console.log(`horizon agent listening on 127.0.0.1:${port}, home ${home}`);
if (adminToken) {
  console.log(`\nAdmin Access Token (показывается один раз, сохраните его):\n\n  ${adminToken}\n`);
}

for (const signal of ['SIGINT', 'SIGTERM'] as const)
  process.on(signal, () => {
    stop();
    process.exit(0);
  });
