import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import type { UpdateResult } from '@horizon/protocol';

// Agent Home layout:
//   versions/<id>/{agent.mjs, package.json, node_modules → deps/<hash>/node_modules}
//   deps/<hash>/   — dependencies shared by versions with the same set (native Claude Code is ~350 MB)
//   current        — the confirmed version; previous — the one before it (for rollback)
//   next           — the version on trial: the Launcher starts it, the Agent confirms it after starting
//   update.json    — the result of the last update

export interface AgentBuild {
  package: { version: string; dependencies?: Record<string, string> };
  agent: string;
}

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const read = (home: string, name: string) => (existsSync(join(home, name)) ? readFileSync(join(home, name), 'utf8').trim() : undefined);

/** Version id: the number from package.json plus a code hash, so builds with the same number stay distinct. */
export const versionId = (build: AgentBuild) => `${build.package.version}-${sha(build.agent).slice(0, 8)}`;

export const currentVersion = (home: string) => read(home, 'current');
export const nextVersion = (home: string) => read(home, 'next');
export const lastUpdate = (home: string): UpdateResult | undefined =>
  existsSync(join(home, 'update.json')) ? JSON.parse(readFileSync(join(home, 'update.json'), 'utf8')) : undefined;
export const writeUpdate = (home: string, r: UpdateResult) => writeFileSync(join(home, 'update.json'), JSON.stringify(r, null, 2));

/** Unpacks a build into versions/<id>, installing dependencies if this set is new. Returns the id. */
export async function installVersion(home: string, build: AgentBuild): Promise<string> {
  const id = versionId(build);
  const dir = join(home, 'versions', id);
  if (existsSync(join(dir, 'node_modules'))) return id;

  const dependencies = build.package.dependencies ?? {};
  const deps = join(home, 'deps', sha(JSON.stringify(dependencies)).slice(0, 12));
  if (!existsSync(join(deps, 'node_modules'))) {
    mkdirSync(deps, { recursive: true });
    writeFileSync(join(deps, 'package.json'), JSON.stringify({ private: true, dependencies }, null, 2));
    await promisify(execFile)('npm', ['install', '--omit=dev', '--no-audit', '--no-fund'], {
      cwd: deps,
      shell: process.platform === 'win32',
    });
    mkdirSync(join(deps, 'node_modules'), { recursive: true }); // npm does not create it when there are no dependencies
  }

  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'agent.mjs'), build.agent);
  writeFileSync(join(dir, 'package.json'), JSON.stringify(build.package, null, 2));
  symlinkSync(join(deps, 'node_modules'), join(dir, 'node_modules'), 'junction'); // a junction needs no administrator rights on Windows
  return id;
}

/** Makes `id` the current version (install or confirmed update) and deletes everything except it and the previous one. */
export function makeCurrent(home: string, id: string) {
  const current = currentVersion(home);
  if (current && current !== id) writeFileSync(join(home, 'previous'), current);
  writeFileSync(join(home, 'current'), id);
  rmSync(join(home, 'next'), { force: true });

  const keep = [id, read(home, 'previous')];
  const versions = join(home, 'versions');
  for (const v of readdirSync(versions)) if (!keep.includes(v)) rmSync(join(versions, v), { recursive: true, force: true });
  const used = readdirSync(versions).map((v) => resolve(readlinkSync(join(versions, v, 'node_modules')), '..'));
  const deps = join(home, 'deps');
  for (const d of existsSync(deps) ? readdirSync(deps) : [])
    if (!used.includes(resolve(deps, d))) rmSync(join(deps, d), { recursive: true, force: true });
}
