import neo4j, { type Driver, type ManagedTransaction, type QueryResult } from "neo4j-driver";
import type { ComponentStatus } from "@kw/schema";
import { loadGraphConfig, type GraphConfig } from "./config";

// ---------------------------------------------------------------------------------------------------------------
// Result type: no public function of this package throws into callers. Neo4j being down is an expected state
// (SQLite is the system of record), so callers get a typed failure they can render as "graph unavailable".
// ---------------------------------------------------------------------------------------------------------------

export type GraphErrorKind =
  /** Not reachable (connection refused, timeout, service unavailable, session expired) or driver closed. */
  | "graph_unavailable"
  /** NEO4J_URI / NEO4J_USER / NEO4J_PASSWORD not found in env or .env.neo4j. */
  | "not_configured"
  /** Reachable but credentials rejected. */
  | "auth_failed"
  /** Caller passed something unusable (e.g. bundle failed validation, depth out of range). */
  | "invalid_input"
  /** Reachable, but the statement failed (syntax, constraint violation, ...). */
  | "query_failed";

export interface GraphError {
  kind: GraphErrorKind;
  /** Safe to display: never contains the password. */
  message: string;
  /** Neo4j status code when the error came from the server/driver, else null. */
  code: string | null;
  retryable: boolean;
}

export type GraphResult<T> = { ok: true; value: T } | { ok: false; error: GraphError };

/** true for every kind that means "the graph cannot be used right now" (vs. a bad query or bad input). */
export function isGraphUnavailable(e: GraphError): boolean {
  return e.kind === "graph_unavailable" || e.kind === "not_configured" || e.kind === "auth_failed";
}

export const ok = <T>(value: T): GraphResult<T> => ({ ok: true, value });
export const fail = <T = never>(kind: GraphErrorKind, message: string, code: string | null = null, retryable = false): GraphResult<T> => ({
  ok: false,
  error: { kind, message, code, retryable },
});

const UNAVAILABLE_CODES = new Set(["ServiceUnavailable", "SessionExpired", "ECONNREFUSED", "ETIMEDOUT", "ENOTFOUND", "EHOSTUNREACH"]);

export function classifyError(err: unknown, secret: string | null): GraphError {
  const e = err as { code?: unknown; message?: unknown; retryable?: unknown; cause?: { code?: unknown } } | null;
  const code = typeof e?.code === "string" ? e.code : typeof e?.cause?.code === "string" ? e.cause.code : null;
  let message = typeof e?.message === "string" ? e.message : String(err);
  if (secret && secret.length > 0) message = message.split(secret).join("[redacted]");
  if (message.length > 500) message = `${message.slice(0, 500)}...`;
  const retryable = e?.retryable === true || neo4j.isRetryableError(err);
  let kind: GraphErrorKind = "query_failed";
  if (code && code.startsWith("Neo.ClientError.Security.")) kind = "auth_failed";
  else if (code && UNAVAILABLE_CODES.has(code)) kind = "graph_unavailable";
  // Message heuristics only when the server did not classify the error itself: a Neo.* statement/schema/transaction
  // error whose text happens to mention e.g. "network_connect" must stay query_failed (and not trip the cooldown).
  else if ((!code || !code.startsWith("Neo.")) && /ECONNREFUSED|ETIMEDOUT|EHOSTUNREACH|ENOTFOUND|failed to connect|connection (?:refused|reset|closed)|timed out|Pool is closed|closed driver/i.test(message)) {
    kind = "graph_unavailable";
  }
  return { kind, message, code, retryable };
}

/** What projection/query code may do inside a write transaction (statements get the Cypher version prefix). */
export interface TxRunner {
  run(cypher: string, params?: Record<string, unknown>): Promise<QueryResult>;
}

export type CypherVersion = "5" | "25";

/**
 * Cypher language version per server: Neo4j 2025.06+ understands the `CYPHER 25` prefix (and 2026.x is where all
 * new features land); 5.x and 2025.01-2025.05 servers only speak Cypher 5. Queries in this package are written in the common subset
 * and are tested against the server actually running.
 */
export function cypherVersionFor(serverVersion: string | null): CypherVersion {
  const [majS, minS] = (serverVersion ?? "").split(".");
  const major = Number(majS);
  const minor = Number(minS);
  if (!Number.isFinite(major) || !Number.isFinite(minor)) return "5";
  // Cypher 25 was introduced in 2025.06 (fact-check neo4j-17/neo4j-22); 2025.01-2025.05 only speak Cypher 5.
  return major > 2025 || (major === 2025 && minor >= 6) ? "25" : "5";
}

export interface GraphHealth {
  connected: true;
  /** e.g. "5.26.32", from CALL dbms.components(). */
  server_version: string | null;
  edition: string | null;
  /** Bolt agent string, e.g. "Neo4j/5.26.32". */
  server_agent: string | null;
  protocol_version: number | null;
  address: string | null;
  database: string;
  latency_ms: number;
  /** Number of constraints currently defined (lets Settings show whether ensureConstraints ran). */
  constraint_count: number;
  /** Cypher version this client prefixes its statements with. */
  cypher_version: CypherVersion;
}

export interface GraphClientOptions {
  /** Explicit config; otherwise loadGraphConfig() (env, KW_NEO4J_ENV_FILE, nearest .env.neo4j). */
  config?: GraphConfig;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  connectionTimeoutMs?: number;
  /** Per-transaction timeout (server-side). */
  queryTimeoutMs?: number;
  /** How long the driver keeps retrying transient failures (incl. "server down") before giving up. Default 3000. */
  maxRetryTimeMs?: number;
  /** Force a Cypher version instead of detecting it from the server. */
  cypherVersion?: CypherVersion;
  /** After a graph_unavailable error, fail fast (no network attempt) for this long. health() always probes. Default 2000. */
  unavailableCooldownMs?: number;
}

export class GraphClient {
  readonly database: string;
  readonly configuredVia: string | null;
  private readonly driver: Driver | null;
  private readonly secret: string | null;
  private readonly notConfigured: string | null;
  private readonly queryTimeoutMs: number;
  private closed = false;
  private readonly cooldownMs: number;
  private unavailableUntil = 0;
  private lastUnavailable: GraphError | null = null;
  private cypher: CypherVersion | null;

  constructor(opts: GraphClientOptions = {}) {
    this.queryTimeoutMs = opts.queryTimeoutMs ?? 30_000;
    this.cooldownMs = opts.unavailableCooldownMs ?? 2_000;
    this.cypher = opts.cypherVersion ?? null;
    let config: GraphConfig | null = opts.config ?? null;
    let notConfigured: string | null = null;
    if (!config) {
      const r = loadGraphConfig({ ...(opts.env ? { env: opts.env } : {}), ...(opts.cwd ? { cwd: opts.cwd } : {}) });
      if (r.ok) config = r.config;
      else notConfigured = `Neo4j not configured: missing ${r.missing.join(", ")} (env or .env.neo4j)`;
    }
    this.database = config?.database ?? "neo4j";
    this.configuredVia = config?.configuredVia ?? null;
    this.secret = config?.password ?? null;
    this.notConfigured = notConfigured;
    let driver: Driver | null = null;
    if (config) {
      try {
        driver = neo4j.driver(config.uri, neo4j.auth.basic(config.user, config.password), {
          disableLosslessIntegers: true,
          connectionTimeout: opts.connectionTimeoutMs ?? 3_000,
          connectionAcquisitionTimeout: (opts.connectionTimeoutMs ?? 3_000) + 2_000,
          maxConnectionPoolSize: 20,
          maxTransactionRetryTime: opts.maxRetryTimeMs ?? 3_000,
          userAgent: "underwatch-graph/0.1",
        });
      } catch (err) {
        this.notConfigured = `Neo4j driver could not be created: ${classifyError(err, this.secret).message}`;
      }
    }
    this.driver = driver;
  }

  private guard(probe = false): GraphResult<Driver> {
    if (this.closed) return fail("graph_unavailable", "Graph client is closed");
    if (!this.driver) return fail("not_configured", this.notConfigured ?? "Neo4j not configured");
    if (!probe && this.lastUnavailable && Date.now() < this.unavailableUntil) {
      return { ok: false, error: { ...this.lastUnavailable, message: `${this.lastUnavailable.message} (cached for ${this.cooldownMs} ms)` } };
    }
    return ok(this.driver);
  }

  private failure<T>(err: unknown): GraphResult<T> {
    const e = classifyError(err, this.secret);
    if (e.kind === "graph_unavailable" || e.kind === "auth_failed") {
      this.lastUnavailable = e;
      this.unavailableUntil = Date.now() + this.cooldownMs;
    }
    return { ok: false, error: e };
  }

  /** Detects (once) and caches the Cypher version; throws driver errors to the caller's catch. */
  private async prefix(driver: Driver): Promise<string> {
    if (!this.cypher) {
      const comp = await driver.executeQuery("CALL dbms.components() YIELD name, versions RETURN name, versions", {}, {
        database: this.database,
        routing: neo4j.routing.READ,
      });
      const kernel = comp.records.find((r) => r.get("name") === "Neo4j Kernel") ?? comp.records[0];
      this.cypher = cypherVersionFor((kernel?.get("versions") as string[] | undefined)?.[0] ?? null);
    }
    return this.cypher === "25" ? "CYPHER 25\n" : "";
  }

  private recovered(): void {
    this.lastUnavailable = null;
    this.unavailableUntil = 0;
  }

  /** Run an auto-routed read query and map records. Never throws. */
  async read<T>(cypher: string, params: Record<string, unknown>, map: (rec: { get(key: string): unknown }) => T): Promise<GraphResult<T[]>> {
    const g = this.guard();
    if (!g.ok) return g;
    try {
      const res = await g.value.executeQuery((await this.prefix(g.value)) + cypher, params, {
        database: this.database,
        routing: neo4j.routing.READ,
        transactionConfig: { timeout: this.queryTimeoutMs },
      });
      return ok(res.records.map((r) => map(r)));
    } catch (err) {
      return this.failure(err);
    }
  }

  /** Run a unit of work in one managed write transaction (retried by the driver on transient errors). Never throws. */
  async write<T>(work: (tx: TxRunner) => Promise<T>): Promise<GraphResult<T>> {
    const g = this.guard();
    if (!g.ok) return g;
    const session = g.value.session({ database: this.database, defaultAccessMode: neo4j.session.WRITE });
    try {
      const prefix = await this.prefix(g.value);
      const wrap = (tx: ManagedTransaction): TxRunner => ({ run: (cypher, params) => tx.run(prefix + cypher, params ?? {}) });
      return ok(await session.executeWrite((tx) => work(wrap(tx)), { timeout: this.queryTimeoutMs }));
    } catch (err) {
      return this.failure(err);
    } finally {
      await session.close().catch(() => undefined);
    }
  }

  /** Run an auto-commit statement (needed for schema DDL, which the server runs outside explicit transactions safely). */
  async autoCommit(cypher: string, params: Record<string, unknown> = {}): Promise<GraphResult<void>> {
    const g = this.guard();
    if (!g.ok) return g;
    const session = g.value.session({ database: this.database, defaultAccessMode: neo4j.session.WRITE });
    try {
      await session.run((await this.prefix(g.value)) + cypher, params);
      return ok(undefined);
    } catch (err) {
      return this.failure(err);
    } finally {
      await session.close().catch(() => undefined);
    }
  }

  /** Connectivity + server version. Never throws. */
  async health(): Promise<GraphResult<GraphHealth>> {
    const g = this.guard(true);
    if (!g.ok) return g;
    const t0 = performance.now();
    try {
      const info = await g.value.getServerInfo({ database: this.database });
      const comp = await g.value.executeQuery(
        "CALL dbms.components() YIELD name, versions, edition RETURN name, versions, edition",
        {},
        { database: this.database, routing: neo4j.routing.READ },
      );
      const kernel = comp.records.find((r) => r.get("name") === "Neo4j Kernel") ?? comp.records[0];
      const constraints = await g.value.executeQuery("SHOW CONSTRAINTS YIELD name RETURN count(*) AS n", {}, {
        database: this.database,
        routing: neo4j.routing.READ,
      });
      const versions = kernel?.get("versions") as string[] | undefined;
      this.cypher ??= cypherVersionFor(versions?.[0] ?? null);
      this.recovered();
      return ok({
        connected: true,
        server_version: versions?.[0] ?? null,
        edition: (kernel?.get("edition") as string | undefined) ?? null,
        server_agent: info.agent ?? null,
        protocol_version: typeof info.protocolVersion === "number" ? info.protocolVersion : info.protocolVersion != null ? Number(String(info.protocolVersion)) : null,
        address: info.address ?? null,
        database: this.database,
        latency_ms: Math.round(performance.now() - t0),
        constraint_count: Number(constraints.records[0]?.get("n") ?? 0),
        cypher_version: this.cypher,
      });
    } catch (err) {
      return this.failure(err);
    }
  }

  /** Map health() onto the @kw/schema ComponentStatus used by /api/settings/status. Never throws, never leaks secrets. */
  async componentStatus(): Promise<ComponentStatus> {
    const h = await this.health();
    const base = { id: "neo4j", name: "Neo4j evidence graph", configured_via: this.configuredVia };
    if (h.ok) {
      return {
        ...base,
        status: "connected",
        detail: `Neo4j ${h.value.server_version ?? "unknown version"} ${h.value.edition ?? ""} at ${h.value.address ?? "?"}, db ${h.value.database}, ${h.value.constraint_count} constraints`.replace(/\s+/g, " "),
      };
    }
    const status = h.error.kind === "not_configured" ? "not_configured" : "error";
    return { ...base, status, detail: `${h.error.kind}: ${h.error.message}` };
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.driver?.close().catch(() => undefined);
  }
}
