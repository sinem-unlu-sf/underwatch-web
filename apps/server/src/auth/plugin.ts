import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { API_ROUTES, KW_CLIENT_HEADER, KW_CLIENT_HEADER_VALUE, type ApiError } from "@kw/schema";
import { ALLOWED_ORIGINS } from "../config";
import type { ServerContext } from "../context";
import { accountForSessionToken } from "../accounts/store";
import { bearerFrom, ensureAuthToken, tokensEqual } from "./token";

const WEB_PORT = 4601;
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/** Host header values the API answers to (DNS-rebinding defence): loopback names on the API port and the web dev port. */
export function allowedHosts(env: NodeJS.ProcessEnv): Set<string> {
  const apiPort = Number(env.PORT ?? 4600);
  const ports = new Set([apiPort, WEB_PORT]);
  const hosts = new Set<string>();
  for (const p of ports) for (const name of ["127.0.0.1", "localhost"]) hosts.add(`${name}:${p}`);
  return hosts;
}

function deny(reply: FastifyReply, status: 401 | 403, code: "unauthorized" | "forbidden", message: string) {
  const body: ApiError = { error: { code, message } };
  return reply.status(status).send(body);
}

/**
 * Request guard (AC-9, AC-15). Registered before all routes by app.ts. For every /api request:
 *  1. Host must be 127.0.0.1/localhost on the API port or 4601 (else 403 forbidden) - blocks DNS rebinding.
 *  2. An Origin header, when present, must be http://127.0.0.1:4601 or http://localhost:4601 (else 403).
 *  3. Mutating requests (POST etc.) additionally need the KW_CLIENT_HEADER header (else 403) - blocks simple-form CSRF.
 *  4. Every route except /api/health, /api/accounts/signup and /api/accounts/login needs `Authorization: Bearer <token>`
 *     (else 401): the API token from data/auth-token (constant-time compare) or a valid local-account session token
 *     (looked up by sha256; unexpired and not revoked).
 * CORS preflight (OPTIONS) is left to @fastify/cors. The token is read once at startup and never returned by any route.
 */
/** Requests that presented a valid bearer token on an otherwise open route (/api/health). */
export const authenticatedRequests = new WeakSet<FastifyRequest>();

/** Requests authenticated by a local-account session token (not the API token): request -> account id. */
export const sessionAccounts = new WeakMap<FastifyRequest, string>();

/** Reachable without a Bearer credential (Host/Origin/client-header checks still apply); signup checks the API token itself. */
const OPEN_ACCOUNT_ROUTES = new Set<string>([API_ROUTES.accountSignup, API_ROUTES.accountLogin]);

export function registerAuthGuard(app: FastifyInstance, ctx: ServerContext): void {
  const token = ensureAuthToken(ctx.paths.dataDir);
  const hosts = allowedHosts(ctx.env);
  const origins = new Set(ALLOWED_ORIGINS);

  app.addHook("onRequest", async (req: FastifyRequest, reply: FastifyReply) => {
    const pathname = req.url.split("?")[0] ?? "";
    if (pathname !== "/api" && !pathname.startsWith("/api/")) return;
    if (req.method === "OPTIONS") return;

    const host = (req.headers.host ?? "").toLowerCase();
    if (!hosts.has(host)) return deny(reply, 403, "forbidden", "Host header not allowed: the API only answers to 127.0.0.1/localhost.");

    const origin = req.headers.origin;
    if (origin !== undefined && !origins.has(origin)) return deny(reply, 403, "forbidden", "Origin not allowed.");

    if (!SAFE_METHODS.has(req.method) && req.headers[KW_CLIENT_HEADER] !== KW_CLIENT_HEADER_VALUE) {
      return deny(reply, 403, "forbidden", `Mutating requests must send the ${KW_CLIENT_HEADER} header.`);
    }

    const presented = bearerFrom(req.headers.authorization);
    const isApiToken = presented !== null && tokensEqual(presented, token);
    if (pathname === API_ROUTES.health || OPEN_ACCOUNT_ROUTES.has(pathname)) {
      // Liveness stays open; details (version, DB) only for a valid token (routes.ts reads this mark).
      // Signup/login are open too; signup accepts this mark (the API token as Bearer) as its authorization.
      if (isApiToken) authenticatedRequests.add(req);
      else if (pathname === API_ROUTES.health && presented !== null && accountForSessionToken(ctx.db, presented, ctx.now()) !== null) {
        authenticatedRequests.add(req);
      }
      return;
    }

    if (isApiToken) return;
    // A valid, unexpired, unrevoked local-account session token is accepted alongside the API token.
    const accountId = presented === null ? null : accountForSessionToken(ctx.db, presented, ctx.now());
    if (accountId !== null) {
      sessionAccounts.set(req, accountId);
      return;
    }
    return deny(
      reply,
      401,
      "unauthorized",
      "Missing or invalid API token. Open the app with `pnpm open` (or the URL in the server log).",
    );
  });
}
