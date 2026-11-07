import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const packageRoot = fileURLToPath(new URL('../', import.meta.url));
const generated = mkdtempSync(join(tmpdir(), 'horizon-codex-protocol-'));
const result = spawnSync(process.execPath, [require.resolve('@openai/codex/bin/codex.js'),
  'app-server', 'generate-ts', '--out', generated], { stdio: 'inherit', windowsHide: true });
if (result.status !== 0) throw new Error('Codex protocol generation failed');

// Commit only the declarations used by our adapter and their transitive imports.
const roots = ['RequestId', 'InitializeParams', 'InitializeResponse', 'ServerRequest',
  'v2/GetAccountParams', 'v2/GetAccountResponse', 'v2/ThreadStartParams', 'v2/ThreadStartResponse',
  'v2/ThreadResumeParams', 'v2/ThreadResumeResponse', 'v2/TurnStartParams', 'v2/TurnStartResponse',
  'v2/ItemStartedNotification', 'v2/ItemCompletedNotification', 'v2/TurnCompletedNotification',
  'v2/CommandExecutionRequestApprovalResponse', 'v2/FileChangeRequestApprovalResponse'];
const visited = new Set();
function copy(relative) {
  if (visited.has(relative)) return;
  visited.add(relative);
  const source = readFileSync(join(generated, relative + '.ts'), 'utf8');
  const content = source.replace(/from "([^"]+)"/g, (_, imported) => {
    const dependency = resolve(generated, dirname(relative), imported);
    const dependencyRelative = dependency.slice(generated.length + 1).replaceAll('\\', '/');
    copy(dependencyRelative);
    return `from "${imported}.ts"`;
  });
  const output = join(packageRoot, 'src/codex-protocol', relative + '.ts');
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, content);
}
roots.forEach(copy);
console.log(`Generated ${visited.size} protocol declarations from @openai/codex 0.166.0`);
