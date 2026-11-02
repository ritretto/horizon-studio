import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AccessLevel, MemberInfo } from '@horizon/protocol';

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
  private members: Member[];

  constructor(home: string) {
    this.file = join(home, 'members.json');
    this.members = existsSync(this.file) ? JSON.parse(readFileSync(this.file, 'utf8')) : [];
  }

  get isEmpty() {
    return this.members.length === 0;
  }

  list(): MemberInfo[] {
    return this.members.map(({ id, name, accessLevel, tokens }) => ({
      id,
      name,
      accessLevel,
      tokens: tokens.map(({ id, createdAt }) => ({ id, createdAt })),
    }));
  }

  /** Создаёт Member и возвращает его первый Access Token (показывается один раз). */
  create(name: string, accessLevel: AccessLevel): { id: string; token: string } {
    const member: Member = { id: randomUUID(), name, accessLevel, tokens: [] };
    this.members.push(member);
    return { id: member.id, token: this.issue(member.id)! };
  }

  /** Новый Access Token для Member (показывается один раз). */
  issue(memberId: string): string | undefined {
    const member = this.members.find((m) => m.id === memberId);
    if (!member) return;
    const token = randomBytes(32).toString('base64url');
    member.tokens.push({ id: randomUUID(), hash: hash(token), createdAt: new Date().toISOString() });
    this.save();
    return token;
  }

  /** Отзывает токен; последний токен admin отозвать нельзя — иначе к Agent больше никто не подключится как admin. */
  revoke(memberId: string, tokenId: string): string | undefined {
    const member = this.members.find((m) => m.id === memberId);
    if (!member?.tokens.some((t) => t.id === tokenId)) return 'unknown token';
    const adminTokens = this.members.filter((m) => m.accessLevel === 'admin').flatMap((m) => m.tokens);
    if (member.accessLevel === 'admin' && adminTokens.length === 1) return 'нельзя отозвать последний токен admin';
    member.tokens = member.tokens.filter((t) => t.id !== tokenId);
    this.save();
  }

  authenticate(token: string): { member: Member; tokenId: string } | undefined {
    const h = hash(token);
    for (const member of this.members) {
      const t = member.tokens.find((t) => t.hash === h);
      if (t) return { member, tokenId: t.id };
    }
  }

  private save() {
    writeFileSync(this.file, JSON.stringify(this.members, null, 2), { mode: 0o600 });
  }
}
