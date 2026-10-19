import * as http from "node:http";
import * as https from "node:https";
import * as tls from "node:tls";
import type { HttpTransport } from "./transport";

/**
 * ai& endpoint policy (security issue 2): the API key is only ever sent over verified TLS to an allowed host.
 *
 * Enforced twice: at config load / provider construction (validateAiAndEndpoint) and immediately before EVERY request
 * (guardAiAndTransport re-validates the exact request URL against the policy env as it is at that moment), so a config
 * or env change can never reach the network without passing validation.
 *
 * Rules:
 *  - must parse with WHATWG URL; scheme https: only.
 *  - http: only under a development exception: NODE_ENV in {development,test} AND KW_ALLOW_INSECURE_AIAND_HTTP=1 AND a
 *    loopback host (localhost, 127.0.0.0/8, ::1). Production (or unset NODE_ENV) never allows it.
 *  - no credentials (user:pass@), no query string (even an empty "?"), no fragment, no whitespace/control chars.
 *  - host must be api.aiand.com (default port only) unless KW_AIAND_ALLOWED_HOSTS (comma-separated exact hostnames,
 *    no wildcards) names it. The http dev exception does NOT bypass the allowlist.
 *  - refuse to send anything if TLS verification is disabled process-wide (NODE_TLS_REJECT_UNAUTHORIZED=0).
 *  - the default transport (createAiAndHttpsTransport) uses its own https.Agent with rejectUnauthorized:true, Node's
 *    default hostname check, and trust anchors PINNED to Node's bundled Mozilla CA store (tls.rootCertificates), so
 *    process-wide trust-store additions (NODE_EXTRA_CA_CERTS, tls.setDefaultCACertificates, --use-openssl-ca /
 *    SSL_CERT_FILE / SSL_CERT_DIR, --use-system-ca / NODE_USE_SYSTEM_CA) cannot make it trust an extra CA. It never
 *    follows redirects (any 3xx is an error) and its errors carry only an error code.
 *  - the loopback-only http dev exception uses its own http.Agent (not http.globalAgent), so Node's env-proxy support
 *    (NODE_USE_ENV_PROXY + HTTP_PROXY) never routes that plaintext request (Authorization header included) to a proxy.
 *
 * Policy variables are read from the process env (or an injected env in tests), never from the .env file.
 * Reasons never contain the raw URL (it may carry credentials) or the API key.
 */

export const AIAND_DEFAULT_HOST = "api.aiand.com";

export type EndpointCheck = { ok: true; url: string; host: string; insecureDevException: boolean } | { ok: false; reason: string };

export class EndpointPolicyError extends Error {
  constructor(reason: string) {
    super(`ai& endpoint rejected: ${reason}`);
    this.name = "EndpointPolicyError";
  }
}

/** A 3xx answer from the endpoint. Never followed: following could downgrade to http or forward the key elsewhere. */
export class RedirectBlockedError extends EndpointPolicyError {
  constructor(status: number) {
    super(`endpoint answered with a redirect (${status}); redirects are never followed`);
    this.name = "RedirectBlockedError";
  }
}

/** Transport failure carrying only a sanitized error code (no URL, headers, cause, or key). */
export class AiAndTransportError extends Error {
  readonly code: string;
  readonly tls: boolean;
  constructor(code: string) {
    const safe = /^[A-Z0-9_]{1,64}$/.test(code) ? code : "UNKNOWN";
    super(`ai& transport error (${safe})`);
    this.name = "AiAndTransportError";
    this.code = safe;
    this.tls = /CERT|TLS|SSL|SELF_SIGNED|UNABLE_TO_VERIFY|UNABLE_TO_GET_ISSUER|HOSTNAME|ALTNAME/.test(safe);
  }
}

function isLoopback(hostname: string): boolean {
  const h = hostname.toLowerCase();
  if (h === "localhost" || h === "[::1]") return true;
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h);
}

export function allowedAiAndHosts(env: NodeJS.ProcessEnv = process.env): Set<string> {
  const out = new Set<string>([AIAND_DEFAULT_HOST]);
  for (const raw of (env.KW_AIAND_ALLOWED_HOSTS ?? "").split(",")) {
    const h = raw.trim().toLowerCase();
    // exact hostnames / IPv4 / bracketed IPv6 only: no schemes, ports, paths, or wildcards
    if (h && /^(\[[0-9a-f:.]+\]|[a-z0-9.-]+)$/.test(h)) out.add(h);
  }
  return out;
}

/** Non-null when TLS certificate verification is disabled process-wide. */
export function tlsVerificationProblem(...envs: NodeJS.ProcessEnv[]): string | null {
  for (const env of envs) {
    // Node disables verification when this is exactly "0" (and warns); treat any falsy-looking value as disabled.
    const v = env.NODE_TLS_REJECT_UNAUTHORIZED;
    if (v !== undefined && /^(0|false|no|off)$/i.test(v.trim())) {
      return "TLS certificate verification is disabled (NODE_TLS_REJECT_UNAUTHORIZED); refusing to send the API key";
    }
  }
  return null;
}

function insecureDevExceptionEnabled(env: NodeJS.ProcessEnv): boolean {
  return (env.NODE_ENV === "development" || env.NODE_ENV === "test") && env.KW_ALLOW_INSECURE_AIAND_HTTP === "1";
}

/** Validate a configured base URL (or a full request URL). Returns the canonical form (no trailing slash). */
export function validateAiAndEndpoint(raw: unknown, env: NodeJS.ProcessEnv = process.env): EndpointCheck {
  if (typeof raw !== "string" || raw.length === 0) return { ok: false, reason: "endpoint is empty" };
  if (raw.length > 2048) return { ok: false, reason: "endpoint is too long" };
  // eslint-disable-next-line no-control-regex
  if (/[\s\u0000-\u001f\u007f\\]/.test(raw)) return { ok: false, reason: "endpoint contains whitespace, control characters, or backslashes" };
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return { ok: false, reason: "endpoint is not a valid absolute URL" };
  }
  if (u.username !== "" || u.password !== "" || /^[a-z][a-z0-9+.-]*:\/\/[^/?#]*@/i.test(raw)) return { ok: false, reason: "endpoint must not contain credentials (userinfo)" };
  if (u.search !== "" || raw.includes("?")) return { ok: false, reason: "endpoint must not contain a query string" };
  if (u.hash !== "" || raw.includes("#")) return { ok: false, reason: "endpoint must not contain a fragment" };

  let insecureDevException = false;
  if (u.protocol === "http:") {
    if (!insecureDevExceptionEnabled(env)) {
      return { ok: false, reason: "endpoint must use https (http is allowed only with NODE_ENV=development|test AND KW_ALLOW_INSECURE_AIAND_HTTP=1 for a loopback host)" };
    }
    if (!isLoopback(u.hostname)) return { ok: false, reason: "plain http is allowed only for a loopback host, even in development" };
    insecureDevException = true;
  } else if (u.protocol !== "https:") {
    return { ok: false, reason: "endpoint must use https" };
  }

  const host = u.hostname.toLowerCase();
  if (!allowedAiAndHosts(env).has(host)) {
    return { ok: false, reason: `host is not allowed (only ${AIAND_DEFAULT_HOST} unless listed in KW_AIAND_ALLOWED_HOSTS)` };
  }
  if (host === AIAND_DEFAULT_HOST && u.port !== "") return { ok: false, reason: `${AIAND_DEFAULT_HOST} must be reached on the default https port` };

  const path = u.pathname.replace(/\/+$/, "");
  return { ok: true, url: `${u.protocol}//${u.host}${path}`, host, insecureDevException };
}

/**
 * Wrap any transport so that every request is re-validated right before it is sent. Throws EndpointPolicyError (and
 * never calls `inner`) when the URL fails the policy or TLS verification is disabled.
 */
export function guardAiAndTransport(inner: HttpTransport, policyEnv: () => NodeJS.ProcessEnv = () => process.env): HttpTransport {
  return async (req, signal) => {
    const env = policyEnv();
    const tls = tlsVerificationProblem(process.env, env);
    if (tls) throw new EndpointPolicyError(tls);
    const v = validateAiAndEndpoint(req.url, env);
    if (!v.ok) throw new EndpointPolicyError(v.reason);
    return inner(req, signal);
  };
}

export interface AiAndHttpsTransportOptions {
  /**
   * Trust anchors REPLACING the pinned bundled Mozilla store for this transport only. Intended for tests with a generated
   * CA; verification and hostname checks stay on. Never read from env/config.
   */
  ca?: string | Buffer | Array<string | Buffer>;
  /** Max response body size in bytes (default 16 MiB). */
  maxBodyBytes?: number;
}

/**
 * Default ai& transport: node:https with a dedicated agent (independent of any global fetch dispatcher or global agent),
 * explicit rejectUnauthorized:true, default hostname verification, TLS >= 1.2, trust pinned to the bundled Mozilla CA
 * store (tls.rootCertificates is fixed at build time and NOT extended by NODE_EXTRA_CA_CERTS, setDefaultCACertificates,
 * or the OpenSSL/system store options), and no redirect following.
 */
export function createAiAndHttpsTransport(opts: AiAndHttpsTransportOptions = {}): HttpTransport {
  const agent = new https.Agent({ keepAlive: false, rejectUnauthorized: true, minVersion: "TLSv1.2", ca: opts.ca ?? [...tls.rootCertificates] });
  // dedicated plain-http agent for the loopback dev exception: custom agents do not pick up env proxies (only the global
  // agents do under NODE_USE_ENV_PROXY), so the request really goes to the loopback host.
  const httpAgent = new http.Agent({ keepAlive: false });
  const maxBody = opts.maxBodyBytes ?? 16 * 1024 * 1024;
  return (req, signal) =>
    new Promise((resolve, reject) => {
      let u: URL;
      try {
        u = new URL(req.url);
      } catch {
        reject(new EndpointPolicyError("endpoint is not a valid absolute URL"));
        return;
      }
      if (u.protocol !== "https:" && !(u.protocol === "http:" && isLoopback(u.hostname))) {
        // defense in depth: even if called without guardAiAndTransport, plain http only targets a loopback host (and the
        // dedicated httpAgent below bypasses env proxies). Caveat: "localhost" is resolved by the OS resolver/hosts file.
        reject(new EndpointPolicyError("endpoint must use https"));
        return;
      }
      if (signal.aborted) {
        reject(signal.reason instanceof Error ? signal.reason : new Error("aborted"));
        return;
      }
      const headers: Record<string, string | number> = { ...req.headers };
      if (req.body !== undefined) headers["Content-Length"] = Buffer.byteLength(req.body);
      const common = { method: req.method, headers, signal };
      let settled = false;
      const fail = (e: Error) => {
        if (settled) return;
        settled = true;
        reject(e);
      };
      const onResponse = (res: http.IncomingMessage) => {
        const status = res.statusCode ?? 0;
        if (status >= 300 && status < 400) {
          res.resume();
          r.destroy();
          fail(new RedirectBlockedError(status));
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        res.on("data", (c: Buffer) => {
          size += c.length;
          if (size > maxBody) {
            r.destroy();
            fail(new AiAndTransportError("RESPONSE_TOO_LARGE"));
            return;
          }
          chunks.push(c);
        });
        res.on("end", () => {
          if (settled) return;
          settled = true;
          const out: Record<string, string> = {};
          for (const [k, v] of Object.entries(res.headers)) if (v !== undefined) out[k.toLowerCase()] = Array.isArray(v) ? v.join(", ") : v;
          resolve({ status, headers: out, body: Buffer.concat(chunks).toString("utf8") });
        });
        res.on("error", (e: NodeJS.ErrnoException) => fail(signal.aborted && signal.reason instanceof Error ? signal.reason : new AiAndTransportError(String(e.code ?? "RESPONSE_ERROR"))));
      };
      const r =
        u.protocol === "https:"
          ? https.request(u, { ...common, agent, rejectUnauthorized: true }, onResponse)
          : // only reachable through the validated development exception (loopback host)
            http.request(u, { ...common, agent: httpAgent }, onResponse);
      r.on("error", (e: NodeJS.ErrnoException) => fail(signal.aborted && signal.reason instanceof Error ? signal.reason : new AiAndTransportError(String(e.code ?? "REQUEST_ERROR"))));
      r.end(req.body);
    });
}
