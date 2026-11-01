import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { startStudio } from './studio.ts';

const { values } = parseArgs({ options: { config: { type: 'string' } } });
const configFile = resolve(values.config ?? join(homedir(), '.horizon-studio', 'config.json'));
mkdirSync(dirname(configFile), { recursive: true });
const port = Number(process.env.HORIZON_STUDIO_PORT ?? 7300);

await startStudio(configFile, port);
console.log(`horizon studio on http://127.0.0.1:${port}, config ${configFile}`);
