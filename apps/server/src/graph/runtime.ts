/**
 * Process-wide Neo4j projection runtime. SQLite stays the system of record; Neo4j is a rebuildable projection kept in
 * sync best-effort:
 *  - syncAll() on server start (when Neo4j is reachable) and from `pnpm --filter @kw/server seed:fixtures`;
 *  - syncRun() whenever an investigation, safeguard (version/state) or verification run of that run changes.
 * Failures are recorded (log + in-memory list shown on Settings) and never block or fail the request that caused them.
 * No KwGraph (tests, or `KW_GRAPH=off`) => every call is a no-op and status says why.
 */
import type { FastifyBaseLogger } from "fastify";
import { isGraphUnavailable, type GraphError, type GraphResult, type KwGraph, type ProjectionReceipt } from "@kw/graph";
import type { ComponentStatus } from "@kw/schema";
import type { Db } from "../db/connection";
import { displayTime } from "../status";
import { ADDENDUM_CONSTRAINTS, planAddendum, projectAddendum, type AddendumReceipt } from "./addendum";
import { listRunIds, runBundleFromDb, runIdForFinding, runIdForSafeguard } from "./bundle-from-db";

export interface ProjectionFailure {
  run_id: string | null;
  reason: string;
  kind: string;
  message: string;
  at: string;
}

export interface RunSyncOutcome {
  run_id: string;
  ok: boolean;
  core: ProjectionReceipt | null;
  addendum: AddendumReceipt | null;
  error: GraphError | null;
}

export interface SyncAllOutcome {
  ok: boolean;
  runs: RunSyncOutcome[];
  /** Set when the graph could not be used at all (not configured / unreachable). */
  unavailable: GraphError | null;
}

export interface GraphRuntime {
  readonly kw: KwGraph | null;
  /** Live probe (Settings). Never throws, never includes credentials. */
  status(): Promise<ComponentStatus>;
  /** Last known status without a network call (overview). */
  cachedStatus(): ComponentStatus;
  syncRun(runId: string, reason: string): Promise<RunSyncOutcome>;
  syncAll(reason: string): Promise<SyncAllOutcome>;
  /** Fire-and-forget re-projection of the run owning a finding / safeguard. Serialized; failures recorded. */
  scheduleFinding(findingId: string, reason: string): void;
  scheduleSafeguard(safeguardId: string, reason: string): void;
  /** Resolves when every scheduled sync so far has finished (tests). */
  idle(): Promise<void>;
  failures(): ProjectionFailure[];
  close(): Promise<void>;
}

const MAX_FAILURES = 20;

function knownSecrets(env: NodeJS.ProcessEnv): string[] {
  return ["AIAND_API_KEY", "NEO4J_PASSWORD", "CLAUDE_CODE_OAUTH_TOKEN", "KW_API_TOKEN"].flatMap((k) => {
    const v = env[k]?.trim();
    return v && v.length >= 8 ? [v] : [];
  });
}

export function createGraphRuntime(deps: { db: Db; log: FastifyBaseLogger; env: NodeJS.ProcessEnv; kw: KwGraph | null; now?: () => Date }): GraphRuntime {
  const { db, log, kw } = deps;
  const now = deps.now ?? (() => new Date());
  const failures: ProjectionFailure[] = [];
  let constraintsEnsured = false;
  let chain: Promise<unknown> = Promise.resolve();
  const pending = new Set<string>();
  let lastSync: { at: string; reason: string; ok: number; failed: number; total: number } | null = null;
  let cached: ComponentStatus = kw
    ? { id: "neo4j", name: "Neo4j evidence graph", status: "configured", detail: "Neo4j client created; not probed yet.", configured_via: kw.client.configuredVia }
    : {
        id: "neo4j",
        name: "Neo4j evidence graph",
        status: "not_configured",
        detail: "No Neo4j client in this server process (set NEO4J_* or .env.neo4j and start the server normally). The evidence graph view falls back to the relational store.",
        configured_via: null,
      };

  const record = (runId: string | null, reason: string, e: GraphError) => {
    failures.unshift({ run_id: runId, reason, kind: e.kind, message: e.message, at: now().toISOString() });
    failures.length = Math.min(failures.length, MAX_FAILURES);
    log.warn({ run_id: runId, reason, kind: e.kind }, `graph projection failed: ${e.message}`);
  };

  const notConfigured: GraphError = { kind: "not_configured", message: "No Neo4j client in this process", code: null, retryable: false };

  async function ensureConstraints(): Promise<GraphResult<void>> {
    if (!kw) return { ok: false, error: notConfigured };
    if (constraintsEnsured) return { ok: true, value: undefined };
    const r = await kw.ensureConstraints();
    if (!r.ok) return r;
    for (const s of ADDENDUM_CONSTRAINTS) {
      const a = await kw.client.autoCommit(s);
      if (!a.ok) return a;
    }
    constraintsEnsured = true;
    return { ok: true, value: undefined };
  }

  async function syncRunNow(runId: string, reason: string): Promise<RunSyncOutcome> {
    const out: RunSyncOutcome = { run_id: runId, ok: false, core: null, addendum: null, error: null };
    if (!kw) return { ...out, error: notConfigured };
    const c = await ensureConstraints();
    if (!c.ok) {
      record(runId, reason, c.error);
      return { ...out, error: c.error };
    }
    const bundle = runBundleFromDb(db, runId);
    if (!bundle) {
      const d = await kw.deleteRun(runId);
      return { ...out, ok: d.ok, error: d.ok ? null : d.error };
    }
    const core = await kw.projectRunBundle(bundle, { mode: "replace" });
    if (!core.ok) {
      record(runId, reason, core.error);
      return { ...out, error: core.error };
    }
    const add = await projectAddendum(kw.client, runId, planAddendum(db, runId, knownSecrets(deps.env)));
    if (!add.ok) {
      record(runId, reason, add.error);
      return { ...out, core: core.value, error: add.error };
    }
    return { run_id: runId, ok: true, core: core.value, addendum: add.value, error: null };
  }

  /** Serialize every write so two re-projections of one run never interleave their replace transactions. */
  function enqueue<T>(work: () => Promise<T>): Promise<T> {
    const p = chain.then(work, work);
    chain = p.catch(() => undefined);
    return p;
  }

  function schedule(runId: string | null, reason: string): void {
    if (!kw || !runId || pending.has(runId)) return;
    pending.add(runId);
    void enqueue(async () => {
      pending.delete(runId);
      try {
        await syncRunNow(runId, reason);
      } catch (err) {
        record(runId, reason, { kind: "query_failed", message: err instanceof Error ? err.message : String(err), code: null, retryable: false });
      }
    });
  }

  return {
    kw,
    async status() {
      if (!kw) return cached;
      const base = await kw.componentStatus();
      const sync = lastSync
        ? ` Projection: ${lastSync.ok}/${lastSync.total} run(s) synced (${lastSync.reason}, ${displayTime(lastSync.at)})${lastSync.failed ? `, ${lastSync.failed} failed` : ""}.`
        : " Projection: not synced yet in this process.";
      const fail = failures[0] ? ` Last projection failure: ${failures[0].kind} (${failures[0].reason}, ${failures[0].at}).` : "";
      const degraded = base.status === "connected" && lastSync !== null && lastSync.failed > 0;
      cached = { ...base, status: degraded ? "degraded" : base.status, detail: `${base.detail}.${sync}${fail}`.replace(/\.\./g, ".") };
      return cached;
    },
    cachedStatus: () => cached,
    syncRun: (runId, reason) => enqueue(() => syncRunNow(runId, reason)),
    syncAll(reason) {
      return enqueue(async () => {
        if (!kw) return { ok: false, runs: [], unavailable: notConfigured };
        const h = await kw.health();
        if (!h.ok) {
          record(null, reason, h.error);
          return { ok: false, runs: [], unavailable: h.error };
        }
        const runs: RunSyncOutcome[] = [];
        for (const id of listRunIds(db)) {
          const r = await syncRunNow(id, reason);
          runs.push(r);
          if (r.error && isGraphUnavailable(r.error)) break;
        }
        const ok = runs.filter((r) => r.ok).length;
        lastSync = { at: now().toISOString(), reason, ok, failed: runs.length - ok, total: listRunIds(db).length };
        return { ok: ok === runs.length, runs, unavailable: null };
      });
    },
    scheduleFinding: (findingId, reason) => schedule(runIdForFinding(db, findingId), reason),
    scheduleSafeguard: (safeguardId, reason) => schedule(runIdForSafeguard(db, safeguardId), reason),
    idle: () => chain.then(() => undefined),
    failures: () => [...failures],
    async close() {
      await chain.catch(() => undefined);
      await kw?.close();
    },
  };
}
