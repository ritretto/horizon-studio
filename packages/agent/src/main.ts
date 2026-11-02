import { mkdirSync, readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
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

const { adminToken, stop } = await startAgent(home, port, {
  defaultPermissionMode: config.defaultPermissionMode,
  completedRetentionDays: config.completedRetentionDays,
});
console.log(`horizon agent listening on 127.0.0.1:${port}, home ${home}`);
if (adminToken) {
  console.log(`\nAdmin Access Token (показывается один раз, сохраните его):\n\n  ${adminToken}\n`);
}

for (const signal of ['SIGINT', 'SIGTERM'] as const)
  process.on(signal, () => {
    stop();
    process.exit(0);
  });
