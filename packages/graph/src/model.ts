import { ID_PART_SEPARATOR, sha256Hex, type Confidence, type CorrelationMatch } from "@kw/schema";

/**
 * Graph vocabulary. Labels and relationship types are closed sets: Cypher cannot parameterize them, so every
 * statement that interpolates one does so only from these constants (never from input data).
 */
export const NODE_LABELS = [
  "Run",
  "Task",
  "Policy",
  "PolicyVersion",
  "Event",
  "AgentEvent",
  "ObservedEvent",
  "DerivedEvent",
  "Process",
  "Resource",
  "Finding",
  "Evidence",
  "Safeguard",
  "VerificationRun",
] as const;
export type NodeLabel = (typeof NODE_LABELS)[number];

/** The label a node is MERGEd on. Event subtypes are MERGEd on :Event and additionally carry their subtype label. */
export type PrimaryLabel = Exclude<NodeLabel, "AgentEvent" | "ObservedEvent" | "DerivedEvent">;
export type EventSubLabel = "AgentEvent" | "ObservedEvent" | "DerivedEvent";

export const REL_TYPES = [
  // PRD FR-8
  "HAS_TASK",
  "HAS_EVENT",
  "REPORTS",
  "OBSERVED_AS",
  "SPAWNED",
  "TARGETS",
  "VIOLATES",
  "SUPPORTED_BY",
  "CONTRADICTS",
  "PROPOSED_AS",
  "VERIFIED_BY",
  "RECURRED_AS",
  // additions beyond FR-8 (mapping documented in projection.ts)
  "UNDER_POLICY",
  "VERSION_OF",
  "PERFORMED_BY",
  "HAS_FINDING",
  "HAS_EVIDENCE",
  "EXECUTED_AS",
] as const;
export type RelType = (typeof REL_TYPES)[number];

/**
 * How a relationship was established (styles edges in the UI). An edge transcribed from a source record takes the
 * basis of that record, so an agent's claim is never displayed as an observation:
 * - observed: transcribed from a field of an independently observed record (collector: trace line, file watcher,
 *   proxy, git diff, ...).
 * - reported: transcribed from an agent-reported record (hook payload, transcript entry). The edge faithfully records
 *   what the agent CLAIMED, not that the claim is true.
 * - derived:  produced deterministically by Underwatch records or analysis (run config, correlation with
 *   match=matched and confidence=high, findings, safeguards, verification, recurrence, derived events).
 * - inferred: heuristic / not established (correlation that is uncertain or below high confidence, process
 *   attribution below high confidence, findings below high confidence).
 * `record_basis` additionally names the basis of the source record for transcribed edges.
 */
export type RelBasis = "observed" | "reported" | "derived" | "inferred";
export const REL_BASES: readonly RelBasis[] = ["observed", "reported", "derived", "inferred"];
/** Basis of the source record an edge was transcribed from. Null when the edge is not record-transcribed. */
export type RecordBasis = "reported" | "observed" | "derived" | null;

export interface RelProps {
  basis: RelBasis;
  /** Name of the projection rule / source field that produced the edge. Always set (also for observed edges). */
  rule: string;
  /** Confidence for derived/inferred edges; null when not applicable or not provided by the source. */
  confidence: Confidence | null;
  record_basis: RecordBasis;
  [extra: string]: string | number | boolean | null | string[];
}

/** derived when the producing record is certain (high confidence), otherwise inferred. */
export function basisFromConfidence(confidence: Confidence | null): RelBasis {
  return confidence === "high" ? "derived" : "inferred";
}

/** Basis of an edge transcribed directly from a record with the given event basis. */
export function basisFromRecord(recordBasis: "reported" | "observed" | "derived"): RelBasis {
  return recordBasis;
}

export function basisFromCorrelation(match: CorrelationMatch, confidence: Confidence): RelBasis {
  return match === "matched" && confidence === "high" ? "derived" : "inferred";
}

// ---------------------------------------------------------------------------------------------------------------
// Synthetic node ids for entities that have no row of their own in @kw/schema (Task, Policy, Process, Resource).
// Deterministic, so re-projection is idempotent. Prefixes are proposed additions to ID_PREFIX.
// ---------------------------------------------------------------------------------------------------------------

const h = (...parts: string[]) => sha256Hex(parts.join(ID_PART_SEPARATOR)).slice(0, 24);

/** Schema has no Task entity: one Task per run, derived from run.task_description. */
export const taskId = (runId: string) => `task_${h(runId)}`;
/** Logical policy shared by all versions (PolicyVersion.policy_id). */
export const policyNodeId = (policyId: string) => `plc_${h(policyId)}`;
/**
 * Process identity is (run, pid). LIMITATION: pid reuse within one run would merge two processes; the schema carries
 * no exec id / start time to disambiguate (see proposed schema additions).
 */
export const processId = (runId: string, pid: number) => `prc_${h(runId, String(pid))}`;
export const resourceId = (kind: ResourceKind, key: string) => `res_${h(kind, key)}`;

export type ResourceKind = "file" | "host" | "command" | "other";

export interface NormalizedResource {
  id: string;
  kind: ResourceKind;
  /** Canonical key, shared across runs: the same key in two runs is the same Resource node. */
  key: string;
  display: string;
}

const HOST_RE = /^(?:\[[0-9a-f:]+\]|[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+)(?::\d{1,5})?$/i;

function normalizePosixPath(p: string): string {
  const abs = p.startsWith("/");
  const out: string[] = [];
  for (const seg of p.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      if (out.length > 0 && out.at(-1) !== "..") out.pop();
      else if (!abs) out.push("..");
      continue;
    }
    out.push(seg);
  }
  const joined = out.join("/");
  return abs ? `/${joined}` : joined || ".";
}

/** Resource kind implied by an event type, when the event type is specific enough. */
export function resourceKindForEventType(eventType: string): ResourceKind | null {
  if (eventType.startsWith("file_")) return "file";
  if (eventType === "network_connect" || eventType === "dns_query") return "host";
  if (eventType === "process_exec") return "command";
  return null;
}

/**
 * Map an event's free-text target_resource to a Resource. `hint` (from resourceKindForEventType) wins when given;
 * otherwise classification is a deterministic heuristic over the string only (no filesystem access): URLs and
 * host[:port] become hosts, path-like strings become files, strings with whitespace become commands. Relative paths
 * are NOT resolved against a cwd (the schema has none), so "./.env" and "/workspace/.env" are different resources.
 */
export function normalizeResource(target: string, hint: ResourceKind | null = null): NormalizedResource {
  const raw = target.trim();
  const url = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? safeUrl(raw) : null;
  let kind: ResourceKind;
  if (hint) kind = hint;
  else if (url && url.hostname) kind = "host";
  else if (/^(\/|~\/|\.\.?\/)/.test(raw) || (!/\s/.test(raw) && raw.includes("/"))) kind = "file";
  else if (!/\s/.test(raw) && HOST_RE.test(raw)) kind = "host";
  else if (/\s/.test(raw)) kind = "command";
  else kind = "other";

  let key: string;
  switch (kind) {
    case "host":
      if (url && url.hostname) {
        const port = url.port || ({ "https:": "443", "http:": "80" } as Record<string, string>)[url.protocol] || "";
        key = `${url.hostname.toLowerCase()}${port ? `:${port}` : ""}`;
      } else key = raw.toLowerCase();
      break;
    case "file":
      key = normalizePosixPath(raw);
      break;
    case "command":
      key = raw.replace(/\s+/g, " ");
      break;
    default:
      key = raw;
  }
  return { id: resourceId(kind, key), kind, key, display: raw };
}

function safeUrl(s: string): URL | null {
  try {
    return new URL(s);
  } catch {
    return null;
  }
}
