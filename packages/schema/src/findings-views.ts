import { z } from "zod";
import { DataMode, FixtureFilter } from "./api";
import { EventId, EvidenceId, FindingId, RunId, Timestamp } from "./entities";
import { Confidence, CoverageLevel, FindingCategory, FindingStatus, Outcome, RunStatus, Severity } from "./enums";
import { ID_PART_SEPARATOR, sha256Hex } from "./ids";

/**
 * Findings presentation modes (docs/PRD-addendum-findings-modes.md, design in docs/FINDINGS-MODES.md).
 *
 * PRESENTATION ONLY. Nothing in this module is read by event collection, finding generation, or enforcement, and the
 * server has no "mode" setting: the mode lives in the browser (URL + localStorage). Snapshots hold REFERENCES to
 * persisted findings (id + status/severity at snapshot time); they never create findings.
 *
 * This file deliberately keeps its own route map (FINDINGS_VIEWS_ROUTES / FINDINGS_VIEWS_CONTRACT) instead of
 * extending API_ROUTES in api.ts, so it can be built in parallel with other addenda without touching their contract
 * (and api.ts must never import this file - that would be an import cycle).
 */

const count = z.number().int().nonnegative();
const Sha256Hex = z.string().regex(/^[0-9a-f]{64}$/);

// ---------------------------------------------------------------------------------------------------------------
// Modes (client-side only)
// ---------------------------------------------------------------------------------------------------------------

export const FindingsViewMode = z.enum(["digest", "task", "current"]);
export type FindingsViewMode = z.infer<typeof FindingsViewMode>;

/** Segmented control order and labels. */
export const FINDINGS_VIEW_MODES: readonly FindingsViewMode[] = ["digest", "task", "current"];
export const FINDINGS_VIEW_MODE_LABELS: Record<FindingsViewMode, string> = {
  digest: "Daily Digest",
  task: "By Task",
  current: "Current State",
};
/** PRD Addendum B: task-based is the default mode. */
export const DEFAULT_FINDINGS_VIEW_MODE: FindingsViewMode = "task";
/** localStorage key for the per-browser mode preference (there is no server-side user-preference store). */
export const FINDINGS_VIEW_MODE_STORAGE_KEY = "kw.findings.mode";

// ---------------------------------------------------------------------------------------------------------------
// Ids and keys
// ---------------------------------------------------------------------------------------------------------------

/** finding_snapshots.id. */
export const FindingSnapshotId = z.string().regex(/^fsn_[A-Za-z0-9_-]+$/);
export type FindingSnapshotId = z.infer<typeof FindingSnapshotId>;

/** Task context key: "tsk_" + 24 hex of sha256(repository_id US task_description). Stable across requests. */
export const TaskContextKey = z.string().regex(/^tsk_[0-9a-f]{24}$/);
export type TaskContextKey = z.infer<typeof TaskContextKey>;

export function taskContextKey(repositoryId: string | null, taskDescription: string): string {
  return "tsk_" + sha256Hex([repositoryId ?? "", taskDescription.trim()].join(ID_PART_SEPARATOR)).slice(0, 24);
}

/** Calendar date "YYYY-MM-DD" (validated as a real date). */
export const DigestDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((d) => {
    const [y, m, day] = d.split("-").map(Number) as [number, number, number];
    const t = new Date(Date.UTC(y, m - 1, day));
    return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === day;
  }, "Not a valid calendar date");
export type DigestDate = z.infer<typeof DigestDate>;

export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** IANA time zone name, e.g. "Asia/Tokyo" or "UTC". */
export const TimeZoneName = z.string().min(1).max(64).refine(isValidTimeZone, "Unknown IANA time zone");

/** "2026-10-17@Asia/Tokyo" - finding_snapshots.scope_key for kind = digest. */
export function digestScopeKey(date: string, tz: string): string {
  return `${date}@${tz}`;
}

// ---------------------------------------------------------------------------------------------------------------
// Time-zone helpers (pure; used by server for day bounds and by the web app for "today")
// ---------------------------------------------------------------------------------------------------------------

function tzOffsetMs(instantMs: number, tz: string): number {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const p = Object.fromEntries(dtf.formatToParts(new Date(instantMs)).map((x) => [x.type, x.value]));
  const asUtc = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour), Number(p.minute), Number(p.second));
  return asUtc - Math.floor(instantMs / 1000) * 1000;
}

function localMidnightUtcMs(date: string, tz: string): number {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  const naive = Date.UTC(y, m - 1, d);
  // Two passes settle DST transitions.
  const first = naive - tzOffsetMs(naive, tz);
  return naive - tzOffsetMs(first, tz);
}

function addDays(date: string, days: number): string {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

/** [start, end) of a calendar day in tz, as UTC ISO timestamps. */
export function zonedDayBounds(date: string, tz: string): { start: string; end: string } {
  return {
    start: new Date(localMidnightUtcMs(date, tz)).toISOString(),
    end: new Date(localMidnightUtcMs(addDays(date, 1), tz)).toISOString(),
  };
}

/** Calendar date ("YYYY-MM-DD") of an instant in tz. */
export function zonedDate(instant: Date, tz: string): string {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" })
      .formatToParts(instant)
      .map((x) => [x.type, x.value]),
  );
  return `${p.year}-${p.month}-${p.day}`;
}

// ---------------------------------------------------------------------------------------------------------------
// Hashing / diffing (pure; server computes newer_available, web computes "N new, M updated")
// ---------------------------------------------------------------------------------------------------------------

/** JSON with object keys sorted recursively, so equal content always hashes equal. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
}

export function contentHash(value: unknown): string {
  return sha256Hex(canonicalJson(value));
}

export const SnapshotChanges = z.object({
  /** In next, not in prev. */
  new_finding_ids: z.array(FindingId),
  /** In both, but any recorded field differs (status, severity, updated_at, evidence links, ...). */
  updated_finding_ids: z.array(FindingId),
  /** In prev, not in next (e.g. fixtures re-seeded). */
  removed_finding_ids: z.array(FindingId),
});
export type SnapshotChanges = z.infer<typeof SnapshotChanges>;

export function diffSnapshotFindings(prev: readonly { id: string }[], next: readonly { id: string }[]): SnapshotChanges {
  const before = new Map(prev.map((f) => [f.id, canonicalJson(f)]));
  const after = new Set(next.map((f) => f.id));
  const changes: SnapshotChanges = { new_finding_ids: [], updated_finding_ids: [], removed_finding_ids: [] };
  for (const f of next) {
    const old = before.get(f.id);
    if (old === undefined) changes.new_finding_ids.push(f.id);
    else if (old !== canonicalJson(f)) changes.updated_finding_ids.push(f.id);
  }
  for (const f of prev) if (!after.has(f.id)) changes.removed_finding_ids.push(f.id);
  return changes;
}

export const hasSnapshotChanges = (c: SnapshotChanges): boolean =>
  c.new_finding_ids.length + c.updated_finding_ids.length + c.removed_finding_ids.length > 0;

// ---------------------------------------------------------------------------------------------------------------
// Shared pieces
// ---------------------------------------------------------------------------------------------------------------

/**
 * One finding as it stood when a snapshot was taken. Always links back to the persisted finding (id -> /findings/:id)
 * and its evidence (evidence_ids, related_event_ids). Outcomes are split by basis so reported vs observed and
 * denied/blocked vs succeeded stay distinct; an empty array means no linked event of that basis - NOT "nothing happened".
 */
export const SnapshotFinding = z.object({
  id: FindingId,
  run_id: RunId,
  run_label: z.string().nullable(),
  task_key: TaskContextKey,
  is_fixture: z.boolean(),
  category: FindingCategory,
  title: z.string().min(1),
  severity: Severity,
  confidence: Confidence,
  /** Status at snapshot time. The live status is on /api/findings/:id. */
  status: FindingStatus,
  created_at: Timestamp,
  updated_at: Timestamp,
  missing_information: z.array(z.string()),
  evidence_ids: z.array(EvidenceId),
  related_event_ids: z.array(EventId),
  /** Distinct outcomes of linked events with basis "reported" (sorted). */
  reported_outcomes: z.array(Outcome),
  /** Distinct outcomes of linked events with basis "observed" (sorted). */
  observed_outcomes: z.array(Outcome),
});
export type SnapshotFinding = z.infer<typeof SnapshotFinding>;

/**
 * Why a view may be incomplete. Shown alongside findings; never collapsed into "no findings".
 * coverage_partial: run coverage level partial/minimal. coverage_unknown: level unknown or no coverage report.
 * collector_errors: a coverage source recorded errors. run_in_progress: run pending/running (more findings may come).
 * run_ended_abnormally: run failed/aborted. day_in_progress: digest day has not ended yet in its time zone.
 */
export const CoverageCaveatKind = z.enum([
  "coverage_partial",
  "coverage_unknown",
  "collector_errors",
  "run_in_progress",
  "run_ended_abnormally",
  "day_in_progress",
]);
export type CoverageCaveatKind = z.infer<typeof CoverageCaveatKind>;

export const CoverageCaveat = z.object({
  kind: CoverageCaveatKind,
  /** Null for scope-level caveats (day_in_progress). */
  run_id: RunId.nullable(),
  detail: z.string(),
});
export type CoverageCaveat = z.infer<typeof CoverageCaveat>;

/** no_known_gaps is deliberately not "complete": absence of a recorded gap is not proof of full coverage. */
export const Completeness = z.object({
  status: z.enum(["no_known_gaps", "has_gaps", "no_runs"]),
  caveats: z.array(CoverageCaveat),
});
export type Completeness = z.infer<typeof Completeness>;

// ---------------------------------------------------------------------------------------------------------------
// GET /api/findings/snapshot - Current State (not persisted; snapshot_id is the content hash)
// ---------------------------------------------------------------------------------------------------------------

export const FINDINGS_SNAPSHOT_LIMIT = 500;

/**
 * All findings (fixture + live, each labeled) ordered by severity desc, created_at desc, id. Filters are applied
 * client-side so changing a filter never fetches newer data. Read-only: GET never writes.
 */
export const FindingsSnapshotResponse = z.object({
  /** contentHash({ findings, completeness }). Equal ids => nothing changed. */
  snapshot_id: Sha256Hex,
  generated_at: Timestamp,
  data_mode: DataMode,
  findings: z.array(SnapshotFinding),
  /** Total findings before the FINDINGS_SNAPSHOT_LIMIT cap. */
  total: count,
  truncated: z.boolean(),
  /** Caveats for runs that are referenced by the findings or still running. */
  completeness: Completeness,
});
export type FindingsSnapshotResponse = z.infer<typeof FindingsSnapshotResponse>;

// ---------------------------------------------------------------------------------------------------------------
// Daily digest (persisted, append-only versions in finding_snapshots kind = digest)
// ---------------------------------------------------------------------------------------------------------------

/**
 * A finding belongs to day D in tz when its run's started_at falls in [start, end) of D in tz. Runs (with or without
 * findings) are included by the same rule so coverage caveats line up with the findings shown.
 */
export const DigestScope = z.object({
  date: DigestDate,
  tz: TimeZoneName,
  start: Timestamp,
  end: Timestamp,
});
export type DigestScope = z.infer<typeof DigestScope>;

/** Buckets may overlap; each lists finding ids that are in DigestContent.findings. */
export const DigestSummary = z.object({
  total_findings: count,
  total_runs: count,
  /** status in OPEN_FINDING_STATUSES (new, under_review, unresolved). */
  needs_attention: z.array(FindingId),
  /**
   * A prevented attempt (denied/blocked) is linked and the linked evidence does not show the action succeeding anyway.
   * Observed events take precedence over agent-reported ones (a denied attempt followed by an observed success is not
   * "blocked"); without observed events the reported outcomes decide.
   */
  blocked: z.array(FindingId),
  /** category uncertain_correlation, confidence low, or a linked event with outcome unknown. */
  uncertain: z.array(FindingId),
  /** Same as completeness.caveats; repeated here so the summary line can show it. */
  coverage_gaps: z.array(CoverageCaveat),
});
export type DigestSummary = z.infer<typeof DigestSummary>;

export const DigestGroup = z.object({
  /** task: TaskContextKey; category: FindingCategory value. */
  key: z.string().min(1),
  kind: z.enum(["task", "category"]),
  label: z.string(),
  finding_ids: z.array(FindingId),
  run_ids: z.array(RunId),
  open_count: count,
  max_severity: Severity.nullable(),
});
export type DigestGroup = z.infer<typeof DigestGroup>;

export const DigestRun = z.object({
  id: RunId,
  label: z.string().nullable(),
  task_key: TaskContextKey,
  task_description: z.string(),
  is_fixture: z.boolean(),
  status: RunStatus,
  coverage_status: CoverageLevel,
  started_at: Timestamp,
  ended_at: Timestamp.nullable(),
  finding_ids: z.array(FindingId),
});
export type DigestRun = z.infer<typeof DigestRun>;

/** Everything hashed into content_hash. Contains no generation timestamp, so identical data => identical hash. */
export const DigestContent = z.object({
  scope: DigestScope,
  summary: DigestSummary,
  groups_by_task: z.array(DigestGroup),
  groups_by_category: z.array(DigestGroup),
  runs: z.array(DigestRun),
  findings: z.array(SnapshotFinding),
  completeness: Completeness,
  contains_fixture_data: z.boolean(),
});
export type DigestContent = z.infer<typeof DigestContent>;

export const DigestSnapshot = z.object({
  id: FindingSnapshotId,
  kind: z.literal("digest"),
  scope_key: z.string().min(1),
  version: z.number().int().min(1),
  created_at: Timestamp,
  content_hash: Sha256Hex,
  content: DigestContent,
});
export type DigestSnapshot = z.infer<typeof DigestSnapshot>;

export const DigestParams = z.object({ date: DigestDate });
export type DigestParams = z.infer<typeof DigestParams>;

export const DigestQuery = z.object({
  tz: TimeZoneName.default("UTC"),
  /** Open a specific stored version (404 if absent; never creates). Omit for the latest (created lazily if none). */
  version: z.coerce.number().int().min(1).optional(),
});
export type DigestQuery = z.infer<typeof DigestQuery>;
export type DigestQueryInput = z.input<typeof DigestQuery>;

export const DigestRefreshQuery = z.object({ tz: TimeZoneName.default("UTC") });
export type DigestRefreshQuery = z.infer<typeof DigestRefreshQuery>;
export type DigestRefreshQueryInput = z.input<typeof DigestRefreshQuery>;

/**
 * GET /api/digests/:date - returns the requested (default: latest) version; if the day has no version yet, creates
 * version 1 from current findings (lazy, no scheduler). newer_available/changes compare the returned snapshot with
 * what current findings would produce right now (computed at request time, nothing stored).
 */
export const DigestResponse = z.object({
  snapshot: DigestSnapshot,
  latest_version: z.number().int().min(1),
  newer_available: z.boolean(),
  /** Finding-level differences between this snapshot and current data; all-empty when newer_available is false. */
  changes: SnapshotChanges,
  checked_at: Timestamp,
  data_mode: DataMode,
});
export type DigestResponse = z.infer<typeof DigestResponse>;

/** POST /api/digests/:date/refresh - appends a new version only if content changed (created=false otherwise). */
export const DigestRefreshResponse = DigestResponse.extend({ created: z.boolean() });
export type DigestRefreshResponse = z.infer<typeof DigestRefreshResponse>;

export const DigestVersionItem = z.object({
  id: FindingSnapshotId,
  version: z.number().int().min(1),
  created_at: Timestamp,
  content_hash: Sha256Hex,
  total_findings: count,
});
export type DigestVersionItem = z.infer<typeof DigestVersionItem>;

/** Ordered by version desc. Empty when the day was never opened. */
export const DigestVersionsResponse = z.object({
  scope_key: z.string().min(1),
  items: z.array(DigestVersionItem),
});
export type DigestVersionsResponse = z.infer<typeof DigestVersionsResponse>;

// ---------------------------------------------------------------------------------------------------------------
// GET /api/tasks - task contexts (runs grouped by repository_id + task_description). Task detail reuses
// GET /api/runs/:id, /api/runs/:id/findings and /api/runs/:id/events.
// ---------------------------------------------------------------------------------------------------------------

export const TaskRunSummary = z.object({
  id: RunId,
  label: z.string().nullable(),
  is_fixture: z.boolean(),
  status: RunStatus,
  coverage_status: CoverageLevel,
  started_at: Timestamp,
  ended_at: Timestamp.nullable(),
  finding_count: count,
  open_finding_count: count,
  max_open_severity: Severity.nullable(),
});
export type TaskRunSummary = z.infer<typeof TaskRunSummary>;

export const TaskContext = z.object({
  key: TaskContextKey,
  task_description: z.string(),
  repository_id: z.string().nullable(),
  /** started_at desc. */
  runs: z.array(TaskRunSummary),
  finding_count: count,
  open_finding_count: count,
  max_open_severity: Severity.nullable(),
  /** Max over runs of (ended_at ?? started_at) and their findings' updated_at. */
  last_activity_at: Timestamp,
  contains_fixture_data: z.boolean(),
});
export type TaskContext = z.infer<typeof TaskContext>;

export const TasksQuery = z.object({
  /** Case-insensitive substring over task_description, repository_id, run id/label. */
  q: z.string().trim().min(1).optional(),
  fixture: FixtureFilter.default("include"),
});
export type TasksQuery = z.infer<typeof TasksQuery>;
export type TasksQueryInput = z.input<typeof TasksQuery>;

/** Ordered by last_activity_at desc, then key. Not paginated (one row per task). */
export const TasksResponse = z.object({
  items: z.array(TaskContext),
  total: count,
  data_mode: DataMode,
});
export type TasksResponse = z.infer<typeof TasksResponse>;

// ---------------------------------------------------------------------------------------------------------------
// Routes + contract (separate from API_ROUTES; same /api prefix, same auth guard)
// ---------------------------------------------------------------------------------------------------------------

export const FINDINGS_VIEWS_ROUTES = {
  findingsSnapshot: "/api/findings/snapshot",
  tasks: "/api/tasks",
  digest: "/api/digests/:date",
  digestRefresh: "/api/digests/:date/refresh",
  digestVersions: "/api/digests/:date/versions",
} as const;
export type FindingsViewsRouteKey = keyof typeof FINDINGS_VIEWS_ROUTES;

const enc = encodeURIComponent;
/** Path only; callers append the query string (tz, version, q, fixture). */
export const findingsViewsPaths = {
  findingsSnapshot: () => FINDINGS_VIEWS_ROUTES.findingsSnapshot,
  tasks: () => FINDINGS_VIEWS_ROUTES.tasks,
  digest: (date: string) => `/api/digests/${enc(date)}`,
  digestRefresh: (date: string) => `/api/digests/${enc(date)}/refresh`,
  digestVersions: (date: string) => `/api/digests/${enc(date)}/versions`,
} as const satisfies Record<FindingsViewsRouteKey, (...args: string[]) => string>;

interface FindingsViewsEndpoint {
  method: "GET" | "POST";
  path: string;
  params?: z.ZodType;
  query?: z.ZodType;
  response: z.ZodType;
}

export const FINDINGS_VIEWS_CONTRACT = {
  findingsSnapshot: { method: "GET", path: FINDINGS_VIEWS_ROUTES.findingsSnapshot, response: FindingsSnapshotResponse },
  tasks: { method: "GET", path: FINDINGS_VIEWS_ROUTES.tasks, query: TasksQuery, response: TasksResponse },
  digest: { method: "GET", path: FINDINGS_VIEWS_ROUTES.digest, params: DigestParams, query: DigestQuery, response: DigestResponse },
  digestRefresh: {
    method: "POST",
    path: FINDINGS_VIEWS_ROUTES.digestRefresh,
    params: DigestParams,
    query: DigestRefreshQuery,
    response: DigestRefreshResponse,
  },
  digestVersions: {
    method: "GET",
    path: FINDINGS_VIEWS_ROUTES.digestVersions,
    params: DigestParams,
    query: DigestRefreshQuery,
    response: DigestVersionsResponse,
  },
} as const satisfies Record<FindingsViewsRouteKey, FindingsViewsEndpoint>;
