import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

/** Local API token file (data/auth-token, mode 600, gitignored via data/*). Never served by the API. */
export const AUTH_TOKEN_FILENAME = "auth-token";
const TOKEN_RE = /^[0-9a-f]{64}$/;

export function authTokenPath(dataDir: string): string {
  return path.join(dataDir, AUTH_TOKEN_FILENAME);
}

/**
 * Returns the local API token, generating a random 32-byte (hex) token on first start. An unreadable or malformed
 * file is replaced. The token never leaves this process except in the local startup log line / `pnpm open` URL.
 */
export function ensureAuthToken(dataDir: string): string {
  const file = authTokenPath(dataDir);
  if (existsSync(file)) {
    const existing = readFileSync(file, "utf8").trim();
    if (TOKEN_RE.test(existing)) {
      try {
        chmodSync(file, 0o600);
      } catch {
        // best effort
      }
      return existing;
    }
  }
  mkdirSync(dataDir, { recursive: true });
  const token = randomBytes(32).toString("hex");
  writeFileSync(file, `${token}\n`, { mode: 0o600 });
  chmodSync(file, 0o600);
  return token;
}

/** Constant-time comparison (hashing first so lengths always match). */
export function tokensEqual(presented: string, expected: string): boolean {
  const a = createHash("sha256").update(presented, "utf8").digest();
  const b = createHash("sha256").update(expected, "utf8").digest();
  return timingSafeEqual(a, b);
}

/** Extracts the bearer credential from an Authorization header, or null. */
export function bearerFrom(header: string | string[] | undefined): string | null {
  if (typeof header !== "string") return null;
  const m = /^Bearer\s+(\S+)\s*$/i.exec(header);
  return m ? m[1]! : null;
}
