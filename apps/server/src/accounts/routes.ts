import type { FastifyInstance, FastifyRequest } from "fastify";
import { API_ROUTES, AccountAuthResponse, AccountLoginBody, AccountMeResponse, AccountSignupBody } from "@kw/schema";
import { authenticatedRequests, sessionAccounts } from "../auth/plugin";
import { bearerFrom, ensureAuthToken, tokensEqual } from "../auth/token";
import type { ServerContext } from "../context";
import { ApiHttpError } from "../errors";
import { checkOutput, parseInput } from "../http/validate";
import {
  accountUser,
  createSession,
  dummyPasswordHash,
  findAccountByEmail,
  getAccountUser,
  hashPassword,
  insertAccount,
  revokeSession,
  verifyPassword,
} from "./store";

/** Fixed-window in-memory limiter (per app instance). Counts every attempt, successful or not. */
export class RateLimiter {
  private readonly hits = new Map<string, { start: number; count: number }>();
  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
  ) {}
  /** true = allowed. */
  take(key: string, nowMs: number): boolean {
    if (this.hits.size > 10_000) for (const [k, v] of this.hits) if (nowMs - v.start >= this.windowMs) this.hits.delete(k);
    const cur = this.hits.get(key);
    if (!cur || nowMs - cur.start >= this.windowMs) {
      this.hits.set(key, { start: nowMs, count: 1 });
      return true;
    }
    cur.count += 1;
    return cur.count <= this.limit;
  }
}

const WINDOW_MS = 60_000;
const PER_KEY_LIMIT = 10;
const PER_IP_LIMIT = 50;

const tooMany = () => new ApiHttpError("rate_limited", "Too many attempts. Wait a minute and try again.");
const LOGIN_FAILED = "Email or password is incorrect.";

/**
 * Local accounts. Signup requires the local API token (as Bearer, marked by the guard, or as setup_code), so only
 * someone with local access to data/auth-token can create access. Login failures are generic. Passwords, hashes and
 * tokens are never logged; the session token is returned once and only its sha256 is stored.
 */
export function registerAccountRoutes(app: FastifyInstance, ctx: ServerContext): void {
  const apiToken = ensureAuthToken(ctx.paths.dataDir);
  const perKey = new RateLimiter(PER_KEY_LIMIT, WINDOW_MS);
  const perIp = new RateLimiter(PER_IP_LIMIT, WINDOW_MS);
  const nowMs = () => Date.now();

  const limit = (req: FastifyRequest, route: string, email: string) => {
    const t = nowMs();
    const ipOk = perIp.take(`${route}|${req.ip}`, t);
    const keyOk = perKey.take(`${route}|${req.ip}|${email.trim().toLowerCase()}`, t);
    if (!ipOk || !keyOk) throw tooMany();
  };

  app.post(API_ROUTES.accountSignup, async (req, reply) => {
    const raw = (req.body ?? {}) as { email?: unknown };
    limit(req, "signup", typeof raw.email === "string" ? raw.email : "");
    const body = parseInput(AccountSignupBody, req.body, "body");
    const viaBearer = authenticatedRequests.has(req);
    const viaSetupCode = typeof body.setup_code === "string" && body.setup_code.length > 0 && tokensEqual(body.setup_code.trim(), apiToken);
    if (!viaBearer && !viaSetupCode) {
      throw new ApiHttpError(
        "forbidden",
        "Creating an account needs the local setup code (the API token in data/auth-token on this machine).",
      );
    }
    const now = ctx.now();
    const user = insertAccount(ctx.db, { name: body.name, email: body.email.trim().toLowerCase(), passwordHash: await hashPassword(body.password), now });
    if (!user) throw new ApiHttpError("conflict", "An account with this email already exists.");
    const session = createSession(ctx.db, user.id, now);
    reply.status(201);
    return checkOutput(AccountAuthResponse, { user, session }, ctx.validateResponses);
  });

  app.post(API_ROUTES.accountLogin, async (req) => {
    const raw = (req.body ?? {}) as { email?: unknown };
    limit(req, "login", typeof raw.email === "string" ? raw.email : "");
    const body = parseInput(AccountLoginBody, req.body, "body");
    const row = findAccountByEmail(ctx.db, body.email.trim());
    // Verify against a dummy hash for unknown emails so the response time does not reveal which emails exist.
    const ok = await verifyPassword(body.password, row?.password_hash ?? (await dummyPasswordHash()));
    if (!row || !ok) throw new ApiHttpError("unauthorized", LOGIN_FAILED);
    const session = createSession(ctx.db, row.id, ctx.now());
    return checkOutput(AccountAuthResponse, { user: accountUser(row), session }, ctx.validateResponses);
  });

  // Guarded: requires a Bearer credential. Revokes the presented session token; with the API token it is a no-op.
  app.post(API_ROUTES.accountLogout, async (req, reply) => {
    const presented = bearerFrom(req.headers.authorization);
    if (presented !== null && sessionAccounts.has(req)) revokeSession(ctx.db, presented, ctx.now());
    return reply.status(204).send();
  });

  app.get(API_ROUTES.accountMe, async (req) => {
    const accountId = sessionAccounts.get(req);
    const user = accountId ? getAccountUser(ctx.db, accountId) : null;
    if (!user) throw new ApiHttpError("unauthorized", "Not signed in to a local account (the API token is not an account session).");
    return checkOutput(AccountMeResponse, { user }, ctx.validateResponses);
  });
}
