import {
  EVENT_SOURCE_BASIS,
  EVENT_SOURCE_LABELS,
  type ComponentStatus,
  type DataMode,
  type EventSource,
  type IntegrationStatus,
  type SettingsStatusResponse,
} from "@kw/schema";
import { DEFAULT_RAW_EVIDENCE_RETENTION_DAYS, type DbLocation } from "./config";
import { stmt } from "./db/codec";
import type { Db } from "./db/connection";
import { appliedMigrations } from "./db/migrate";
import { accountCount } from "./accounts/store";

const PENDING = "not implemented in this build";

export interface StatusContext {
  db: Db;
  dbLocation: DbLocation;
  env: NodeJS.ProcessEnv;
  /** Live Neo4j probe (graph runtime). Absent => the env-only fallback below. */
  neo4jStatus?: () => Promise<ComponentStatus>;
  /** Last known Neo4j status without a network call (overview). */
  neo4jCached?: () => ComponentStatus;
  /** Active ai& provider (id "null" = NullProvider). Never carries the key. */
  inference?: InferenceStatusInfo;
}

/** What status may say about the provider: names and hosts only, never the key or a full path. */
export interface InferenceStatusInfo {
  id: string;
  model: string;
  /** e.g. "AIAND_API_KEY (.env.local)" or "AIAND_API_KEY (process env)". */
  key_source?: string | null;
  base_host?: string | null;
  /** True when the provider refused its configured endpoint or TLS settings: every call will fail (reason not shown). */
  endpoint_rejected?: boolean;
}

/** Name-only description of an inference provider for status pages (reads public getters; never the key). */
export function describeInference(p: { id: string; model: string; keySource?: string | null; baseHost?: string | null; describe?: () => unknown }): InferenceStatusInfo {
  let endpointRejected = false;
  try {
    const d = typeof p.describe === "function" ? (p.describe() as { endpoint_error?: unknown } | null) : null;
    endpointRejected = d?.endpoint_error !== undefined && d?.endpoint_error !== null;
  } catch {
    endpointRejected = false;
  }
  return { id: p.id, model: p.model, key_source: p.keySource ?? null, base_host: p.baseHost ?? null, endpoint_rejected: endpointRejected };
}

function envIsSet(env: NodeJS.ProcessEnv, name: string): boolean {
  return Boolean(env[name]?.trim());
}

export function dataMode(db: Db): DataMode {
  const row = stmt(db, "SELECT COALESCE(SUM(is_fixture), 0) AS fixture_runs, COALESCE(SUM(1 - is_fixture), 0) AS live_runs FROM runs").get()!;
  const fixture_runs = Number(row.fixture_runs);
  return { fixture_runs, live_runs: Number(row.live_runs), contains_fixture_data: fixture_runs > 0 };
}

function liveRunCount(db: Db | undefined): number | null {
  if (!db) return null;
  try {
    return Number(stmt(db, "SELECT COUNT(*) AS n FROM runs WHERE is_fixture = 0").get()!.n);
  } catch {
    return null;
  }
}

export function adapterStatus(db?: Db): ComponentStatus {
  const n = liveRunCount(db);
  return {
    id: "claude-code",
    name: "Claude Code adapter",
    status: "configured",
    detail:
      "@kw/adapter-claude-code parses stream-json and hook output of Claude Code runs that Underwatch starts itself " +
      "(Agent Runs > Start supervised run, and safeguard verification runs) in the Docker harness" +
      (n === null ? "." : `; ${n} live run(s) recorded.`) +
      " Claude Code sessions you run outside Underwatch are not observed.",
    configured_via: null,
  };
}

/** Observer sources actually wired in this build, and where. Everything else stays "not implemented". */
const WIRED_COLLECTORS: Partial<Record<EventSource, string>> = {
  kernel_tracer:
    "Tetragon (eBPF) in the kw-tetragon container. Attached to supervised runs (Agent Runs > Start supervised run) and safeguard verification runs, only when kw-tetragon is healthy (otherwise the run's coverage marks kernel observation unavailable, with the reason); not attached to sessions outside Underwatch.",
  network_proxy:
    "Egress proxy (default-deny) and credential-broker logs, captured host-side in supervised and verification runs only.",
  git_observer: "Pre/post git snapshot of the disposable workspace copy, taken host-side in supervised runs only.",
};

/** One entry per independent observer source in the schema, with its real wiring state. */
export function collectorStatuses(): ComponentStatus[] {
  return (Object.keys(EVENT_SOURCE_BASIS) as EventSource[])
    .filter((s) => EVENT_SOURCE_BASIS[s] === "observed")
    .map((source) => {
      const wired = WIRED_COLLECTORS[source];
      return {
        id: source,
        name: EVENT_SOURCE_LABELS[source],
        status: wired ? ("configured" as const) : ("not_implemented" as const),
        detail: wired ?? `Collector ${PENDING}. Not active: no events are being observed from this source.`,
        configured_via: null,
      };
    });
}

const AI_OK_TURNS = new Set(["answered", "insufficient_evidence"]);

/**
 * ai& status from the provider actually wired into this process (not just the env), plus the outcome of the most
 * recent Ask Witness call recorded in the database. Never makes a network call and never shows the key.
 */
export function aiInferenceStatus(env: NodeJS.ProcessEnv, inference?: InferenceStatusInfo, db?: Db): ComponentStatus {
  const keySet = envIsSet(env, "AIAND_API_KEY");
  const active = inference !== undefined && inference.id !== "null";
  if (!active) {
    return {
      id: "ai-and",
      name: "ai& Inference",
      status: keySet ? "disabled" : "not_configured",
      detail: keySet
        ? "AIAND_API_KEY is set (value not shown), but no ai& provider is active in this process. Ask Witness records questions as 'ai unavailable'; safeguard proposals use deterministic templates."
        : "Not configured: no AIAND_API_KEY in the process env or .env.local. Ask Witness records questions as 'ai unavailable'; safeguard proposals use deterministic templates. Everything else works without ai&.",
      configured_via: keySet ? "AIAND_API_KEY" : null,
    };
  }
  if (inference.endpoint_rejected) {
    return {
      id: "ai-and",
      name: "ai& Inference",
      status: "degraded",
      detail:
        `ai& provider is wired (model ${inference.model}; key from ${inference.key_source ?? "AIAND_API_KEY"}, never shown), but its configured endpoint or TLS settings were rejected, so every ai& call fails closed. ` +
        "Ask Witness records questions as 'ai unavailable'. Check the ai& endpoint and TLS configuration.",
      configured_via: inference.key_source ?? "AIAND_API_KEY",
    };
  }
  let last: { status: string; created_at: string } | undefined;
  try {
    if (db) last = stmt(db, "SELECT status, created_at FROM investigation_turns ORDER BY seq DESC LIMIT 1").get() as typeof last;
  } catch {
    last = undefined;
  }
  const status = !last ? "configured" : AI_OK_TURNS.has(last.status) ? "connected" : "degraded";
  return {
    id: "ai-and",
    name: "ai& Inference",
    status,
    detail:
      `ai& provider implemented and active (OpenAI-compatible chat completions, model ${inference.model}` +
      `${inference.base_host ? `, host ${inference.base_host}` : ""}); key from ${inference.key_source ?? "AIAND_API_KEY"}, held server-side, never shown. ` +
      (last ? `Last Ask Witness call: ${last.status} at ${displayTime(last.created_at)}.` : "No Ask Witness call recorded yet.") +
      " Advisory only: answers are labeled by evidence basis and never change findings.",
    configured_via: inference.key_source ?? "AIAND_API_KEY",
  };
}

export function neo4jStatus(env: NodeJS.ProcessEnv): ComponentStatus {
  const uriSet = envIsSet(env, "NEO4J_URI");
  return {
    id: "neo4j",
    name: "Neo4j evidence graph",
    status: uriSet ? "disabled" : "not_configured",
    detail: uriSet
      ? "NEO4J_URI is set (value not shown), but no graph runtime is attached to this process, so nothing is projected. Graph projection and graph-backed Ask Witness retrieval are implemented; retrieval falls back to SQLite."
      : "Not configured: NEO4J_URI is not set. Graph projection is implemented but inactive; Ask Witness retrieval uses the relational (SQLite) fallback.",
    configured_via: uriSet ? "NEO4J_URI" : null,
  };
}

/** Timestamps inside status detail text, in the same zone the UI shows (JST, the demo machine's zone); ISO on failure. */
export function displayTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${d.toLocaleString("sv-SE", { timeZone: "Asia/Tokyo", hour12: false })} JST`;
}

/** Worst-first ranking used to summarize several component statuses into one. */
const STATUS_SEVERITY: Record<IntegrationStatus, number> = {
  error: 6,
  degraded: 5,
  not_implemented: 4,
  not_configured: 3,
  disabled: 2,
  configured: 1,
  connected: 0,
};

export function worstStatus(statuses: IntegrationStatus[]): IntegrationStatus {
  return statuses.reduce<IntegrationStatus>((worst, s) => (STATUS_SEVERITY[s] > STATUS_SEVERITY[worst] ? s : worst), "connected");
}

/**
 * Overall health of the components that exist in this build: collectors that are "not_implemented" are listed per
 * component but do not drag the summary to "not implemented" (that read as if nothing is observed). If every
 * component is not implemented, the summary says so.
 */
export function overallStatus(statuses: IntegrationStatus[]): IntegrationStatus {
  const built = statuses.filter((s) => s !== "not_implemented");
  return built.length === 0 ? "not_implemented" : worstStatus(built);
}

/** Components that make up "observation system health" on the overview. */
export function observationComponents(
  env: NodeJS.ProcessEnv,
  neo4j?: ComponentStatus,
  inference?: InferenceStatusInfo,
  db?: Db,
): ComponentStatus[] {
  return [adapterStatus(db), ...collectorStatuses(), neo4j ?? neo4jStatus(env), aiInferenceStatus(env, inference, db)];
}

export function settingsStatus({ db, dbLocation, env, inference }: StatusContext, neo4j?: ComponentStatus): SettingsStatusResponse {
  const policyCounts = stmt(db, "SELECT COUNT(*) AS total, COALESCE(SUM(is_fixture), 0) AS fixture FROM policy_versions").get()!;
  const totalPolicies = Number(policyCounts.total);
  const fixturePolicies = Number(policyCounts.fixture);
  // Verification-run policy versions (kw-verification, one per tested safeguard version) are not the active policy.
  const activeLive = stmt(db, "SELECT id FROM policy_versions WHERE is_fixture = 0 AND policy_id <> 'kw-verification' ORDER BY julianday(created_at) DESC, id DESC LIMIT 1").get();
  const migrations = appliedMigrations(db);
  const latest = migrations.at(-1);
  const localAccounts = accountCount(db);

  return {
    generated_at: new Date().toISOString(),
    adapter: adapterStatus(db),
    collectors: collectorStatuses(),
    policy: {
      id: "policy",
      name: "Policy",
      // A live policy version exists once a supervised run has recorded it; evaluation itself is implemented.
      status: activeLive ? "configured" : "not_configured",
      detail:
        `${totalPolicies} policy version(s) stored (${fixturePolicies} from fixtures, ${totalPolicies - fixturePolicies} live). ` +
        (activeLive
          ? ""
          : "No supervised run has recorded a policy version yet; the built-in policy below is used as soon as one runs. ") +
        "Built-in policy: \"Underwatch supervised policy\" (kw-supervised), applied to every live supervised run: Claude Code managed settings (read-only, Read denied for .env and secrets/, .claude/ writes denied) plus the matching KW rules evaluated by @kw/analysis. Policy editing in the UI is not implemented; applied safeguards are not merged into supervised runs in this build (they apply to their verification runs).",
      configured_via: null,
      active_policy_version_id: (activeLive?.id as string | undefined) ?? null,
    },
    ai_inference: aiInferenceStatus(env, inference, db),
    neo4j: neo4j ?? neo4jStatus(env),
    database: {
      id: "database",
      name: "Relational store (SQLite)",
      status: "connected",
      detail: `SQLite database ${dbLocation.path === ":memory:" ? "in memory" : "file is open"}; schema version ${latest ? `${latest.version} (${latest.name})` : "none"}.`,
      configured_via: dbLocation.configuredVia,
      driver: "node:sqlite",
    },
    retention: {
      status: "not_implemented",
      detail: `Proposed default: keep raw evidence ${DEFAULT_RAW_EVIDENCE_RETENTION_DAYS} days. Retention enforcement is not implemented; nothing is deleted automatically.`,
      raw_evidence_retention_days: DEFAULT_RAW_EVIDENCE_RETENTION_DAYS,
    },
    redaction: {
      status: "configured",
      detail:
        "@kw/redaction runs on every captured string at ingest (live runs and fixtures) and again on every bundle sent to ai& (fail closed: a redaction failure stores a placeholder). Pattern-based: unusual secret formats can still be missed.",
    },
    data_mode: dataMode(db),
    ...(localAccounts === null ? {} : { local_accounts: localAccounts }),
  };
}
