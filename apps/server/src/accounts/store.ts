import { createHash, randomBytes, randomUUID, scrypt as scryptCb, timingSafeEqual, type ScryptOptions } from "node:crypto";
import type { AccountUser } from "@kw/schema";
import { stmt } from "../db/codec";
import type { Db } from "../db/connection";

/**
 * Local accounts storage. Passwords: scrypt (N=2^14, r=8, p=1, 64-byte key) with a random 16-byte salt per account,
 * verified in constant time. Sessions: 32 random bytes (hex) handed to the client once; only sha256(token) is stored.
 * Nothing here logs or returns a password, a password hash, or a session token (other than the new token itself).
 */

export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 } as const;

function scrypt(password: string, salt: Buffer, keylen: number, opts: ScryptOptions): Promise<Buffer> {
  return new Promise((resolve, reject) => scryptCb(password, salt, keylen, opts, (err, key) => (err ? reject(err) : resolve(key))));
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scrypt(password, salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p, maxmem: 64 * 1024 * 1024 });
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString("base64")}$${key.toString("base64")}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const [N, r, p] = [Number(parts[1]), Number(parts[2]), Number(parts[3])];
  const salt = Buffer.from(parts[4]!, "base64");
  const expected = Buffer.from(parts[5]!, "base64");
  if (!Number.isInteger(N) || !Number.isInteger(r) || !Number.isInteger(p) || expected.length === 0) return false;
  const key = await scrypt(password, salt, expected.length, { N, r, p, maxmem: 64 * 1024 * 1024 });
  return key.length === expected.length && timingSafeEqual(key, expected);
}

/** A fixed hash to verify against when the email is unknown, so login timing does not reveal which emails exist. */
let dummyHash: Promise<string> | null = null;
export function dummyPasswordHash(): Promise<string> {
  return (dummyHash ??= hashPassword(randomBytes(16).toString("hex")));
}

export const sha256Hex = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");

interface AccountRow {
  id: string;
  name: string;
  email: string;
  password_hash: string;
  created_at: string;
}

const toUser = (r: AccountRow): AccountUser => ({ id: r.id, name: r.name, email: r.email, created_at: r.created_at });

export function findAccountByEmail(db: Db, email: string): AccountRow | null {
  return (stmt(db, "SELECT id, name, email, password_hash, created_at FROM accounts WHERE email = ? COLLATE NOCASE").get(email) as
    | AccountRow
    | undefined) ?? null;
}

export function getAccountUser(db: Db, id: string): AccountUser | null {
  const row = stmt(db, "SELECT id, name, email, password_hash, created_at FROM accounts WHERE id = ?").get(id) as AccountRow | undefined;
  return row ? toUser(row) : null;
}

export function accountUser(row: AccountRow): AccountUser {
  return toUser(row);
}

/** Inserts an account; returns null when the email is already registered (case-insensitive). */
export function insertAccount(db: Db, input: { name: string; email: string; passwordHash: string; now: Date }): AccountUser | null {
  const row: AccountRow = {
    id: `acct_${randomUUID().replace(/-/g, "")}`,
    name: input.name,
    email: input.email,
    password_hash: input.passwordHash,
    created_at: input.now.toISOString(),
  };
  try {
    stmt(db, "INSERT INTO accounts (id, name, email, password_hash, created_at) VALUES (?, ?, ?, ?, ?)").run(
      row.id,
      row.name,
      row.email,
      row.password_hash,
      row.created_at,
    );
  } catch (err) {
    if (/UNIQUE constraint failed/i.test((err as Error).message)) return null;
    throw err;
  }
  return toUser(row);
}

export function createSession(db: Db, accountId: string, now: Date): { token: string; expires_at: string } {
  const token = randomBytes(32).toString("hex");
  const expires_at = new Date(now.getTime() + SESSION_TTL_MS).toISOString();
  stmt(db, "INSERT INTO sessions (id, account_id, token_sha256, created_at, expires_at, revoked_at) VALUES (?, ?, ?, ?, ?, NULL)").run(
    `sess_${randomUUID().replace(/-/g, "")}`,
    accountId,
    sha256Hex(token),
    now.toISOString(),
    expires_at,
  );
  return { token, expires_at };
}

/** The account id for a valid (known, unrevoked, unexpired) session token, else null. Lookup is by sha256 only. */
export function accountForSessionToken(db: Db, token: string, now: Date): string | null {
  const row = stmt(
    db,
    "SELECT s.account_id AS account_id, s.expires_at AS expires_at FROM sessions s JOIN accounts a ON a.id = s.account_id " +
      "WHERE s.token_sha256 = ? AND s.revoked_at IS NULL",
  ).get(sha256Hex(token)) as { account_id: string; expires_at: string } | undefined;
  if (!row) return null;
  const exp = Date.parse(row.expires_at);
  if (!Number.isFinite(exp) || exp <= now.getTime()) return null;
  return row.account_id;
}

export function revokeSession(db: Db, token: string, now: Date): void {
  stmt(db, "UPDATE sessions SET revoked_at = ? WHERE token_sha256 = ? AND revoked_at IS NULL").run(now.toISOString(), sha256Hex(token));
}

export function accountCount(db: Db): number | null {
  try {
    return Number((stmt(db, "SELECT COUNT(*) AS n FROM accounts").get() as { n: number }).n);
  } catch {
    return null;
  }
}
