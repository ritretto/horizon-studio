import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AccessLevel } from '@horizon/protocol';

export interface Member {
  id: string;
  name: string;
  accessLevel: AccessLevel;
  /** sha256 от Access Token; сами токены не хранятся. */
  tokens: { id: string; hash: string; createdAt: string }[];
}

const hash = (token: string) => createHash('sha256').update(token).digest('hex');

export class Members {
  private file: string;
  private list: Member[];

  constructor(home: string) {
    this.file = join(home, 'members.json');
    this.list = existsSync(this.file) ? JSON.parse(readFileSync(this.file, 'utf8')) : [];
  }

  get isEmpty() {
    return this.list.length === 0;
  }

  /** Создаёт Member и возвращает его первый Access Token (показывается один раз). */
  create(name: string, accessLevel: AccessLevel): string {
    const token = randomBytes(32).toString('base64url');
    this.list.push({
      id: randomUUID(),
      name,
      accessLevel,
      tokens: [{ id: randomUUID(), hash: hash(token), createdAt: new Date().toISOString() }],
    });
    writeFileSync(this.file, JSON.stringify(this.list, null, 2), { mode: 0o600 });
    return token;
  }

  authenticate(token: string): Member | undefined {
    const h = hash(token);
    return this.list.find((m) => m.tokens.some((t) => t.hash === h));
  }
}
