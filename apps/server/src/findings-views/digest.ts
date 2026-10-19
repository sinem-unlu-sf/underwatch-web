import { randomUUID } from "node:crypto";
import {
  FINDING_CATEGORY_LABELS,
  SEVERITY_ORDER,
  contentHash,
  diffSnapshotFindings,
  digestScopeKey,
  taskContextKey,
  zonedDayBounds,
  type CoverageCaveat,
  type DigestContent,
  type DigestGroup,
  type DigestRefreshResponse,
  type DigestResponse,
  type DigestRun,
  type DigestSnapshot,
  type DigestVersionsResponse,
  type FindingCategory,
  type Outcome,
  type RunListItem,
  type SnapshotChanges,
  type SnapshotFinding,
} from "@kw/schema";
import { stmt } from "../db/codec";
import { transaction, type Db } from "../db/connection";
import { notFound } from "../errors";
import { queryFindingList } from "../repo/findings";
import { queryRunList } from "../repo/runs";
import { dataMode } from "../status";
import { CURRENT_ORDER } from "./current";
import { completeness, isOpenStatus, maxSeverity, toSnapshotFindings } from "./snapshot-findings";

/**
 * Daily digest: a stored, append-only, versioned snapshot of the findings whose run started on day D in time zone tz.
 * Version 1 is created lazily the first time a day is opened (no scheduler); later versions only on explicit refresh,
 * and only when the content changed. Content is computed deterministically from persisted rows (no AI) and carries no
 * generation timestamp, so identical data hashes identically.
 */

const NO_LIMIT = 1_000_000;
const DAY_WHERE = "julianday(started_at) >= julianday(:start) AND julianday(started_at) < julianday(:end)";

const emptyChanges = (): SnapshotChanges => ({ new_finding_ids: [], updated_finding_ids: [], removed_finding_ids: [] });

function bySeverityThenLabel(a: DigestGroup, b: DigestGroup): number {
  const sa = a.max_severity === null ? -1 : SEVERITY_ORDER[a.max_severity];
  const sb = b.max_severity === null ? -1 : SEVERITY_ORDER[b.max_severity];
  if (sa !== sb) return sb - sa;
  if (a.open_count !== b.open_count) return b.open_count - a.open_count;
  return a.label < b.label ? -1 : a.label > b.label ? 1 : a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
}

function group(
  key: string,
  kind: DigestGroup["kind"],
  label: string,
  findings: readonly SnapshotFinding[],
  runIds: readonly string[],
): DigestGroup {
  return {
    key,
    kind,
    label,
    finding_ids: findings.map((f) => f.id),
    run_ids: [...new Set(runIds)],
    open_count: findings.filter((f) => isOpenStatus(f.status)).length,
    max_severity: maxSeverity(findings.map((f) => f.severity)),
  };
}

const PREVENTED = new Set<Outcome>(["denied", "blocked"]);

/**
 * "Blocked" summary bucket: a prevented attempt (denied/blocked) is linked AND the linked evidence does not show the
 * action succeeding anyway. Independent observation takes precedence over the agent's report: a finding whose observed
 * events include "succeeded" (e.g. a denied Read followed by a successful `cat .env`) is NOT counted as blocked, even
 * though one attempt was denied. Without observed events, the agent-reported outcomes decide.
 */
export function wasBlocked(f: Pick<SnapshotFinding, "reported_outcomes" | "observed_outcomes">): boolean {
  const basis = f.observed_outcomes.length > 0 ? f.observed_outcomes : f.reported_outcomes;
  return basis.some((o) => PREVENTED.has(o)) && !basis.includes("succeeded");
}

export function buildDigestContent(db: Db, date: string, tz: string, now: Date): DigestContent {
  const { start, end } = zonedDayBounds(date, tz);
  const params = { start, end };

  const runs: RunListItem[] = queryRunList(db, {
    where: `WHERE ${DAY_WHERE.replaceAll("started_at", "rl.started_at")}`,
    params,
    orderBy: "ORDER BY julianday(rl.started_at), rl.id",
    limit: NO_LIMIT,
  }).items;
  const findings = toSnapshotFindings(
    db,
    queryFindingList(db, {
      where: `WHERE f.run_id IN (SELECT id FROM runs WHERE ${DAY_WHERE})`,
      params,
      orderBy: CURRENT_ORDER,
      limit: NO_LIMIT,
    }).items,
  );

  const findingsByRun = new Map<string, SnapshotFinding[]>();
  for (const f of findings) findingsByRun.set(f.run_id, [...(findingsByRun.get(f.run_id) ?? []), f]);

  const digestRuns: DigestRun[] = runs.map((r) => ({
    id: r.id,
    label: r.label,
    task_key: taskContextKey(r.repository_id, r.task_description),
    task_description: r.task_description,
    is_fixture: r.is_fixture,
    status: r.status,
    coverage_status: r.coverage_status,
    started_at: r.started_at,
    ended_at: r.ended_at,
    finding_ids: (findingsByRun.get(r.id) ?? []).map((f) => f.id),
  }));

  // By task: every task that ran that day, including tasks with no findings (their runs still count).
  const taskKeys = [...new Set(digestRuns.map((r) => r.task_key))];
  const groupsByTask = taskKeys
    .map((key) => {
      const taskRuns = digestRuns.filter((r) => r.task_key === key);
      return group(
        key,
        "task",
        taskRuns[0]!.task_description,
        findings.filter((f) => f.task_key === key),
        taskRuns.map((r) => r.id),
      );
    })
    .sort(bySeverityThenLabel);

  const categories = [...new Set(findings.map((f) => f.category))] as FindingCategory[];
  const groupsByCategory = categories
    .map((c) => {
      const inCategory = findings.filter((f) => f.category === c);
      return group(c, "category", FINDING_CATEGORY_LABELS[c], inCategory, inCategory.map((f) => f.run_id));
    })
    .sort(bySeverityThenLabel);

  const scopeCaveats: CoverageCaveat[] =
    now.getTime() < Date.parse(end)
      ? [{ kind: "day_in_progress", run_id: null, detail: `${date} has not ended yet in ${tz}; more runs may start today.` }]
      : [];
  const comp = completeness(db, runs, scopeCaveats);

  return {
    scope: { date, tz, start, end },
    summary: {
      total_findings: findings.length,
      total_runs: runs.length,
      needs_attention: findings.filter((f) => isOpenStatus(f.status)).map((f) => f.id),
      blocked: findings.filter(wasBlocked).map((f) => f.id),
      uncertain: findings
        .filter(
          (f) =>
            f.category === "uncertain_correlation" ||
            f.confidence === "low" ||
            [...f.reported_outcomes, ...f.observed_outcomes].includes("unknown"),
        )
        .map((f) => f.id),
      coverage_gaps: comp.caveats,
    },
    groups_by_task: groupsByTask,
    groups_by_category: groupsByCategory,
    runs: digestRuns,
    findings,
    completeness: comp,
    contains_fixture_data: runs.some((r) => r.is_fixture) || findings.some((f) => f.is_fixture),
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Store (finding_snapshots, kind = digest; append-only - the table rejects UPDATE/DELETE)
// ---------------------------------------------------------------------------------------------------------------

function rowToSnapshot(row: Record<string, unknown>): DigestSnapshot {
  return {
    id: row.id as string,
    kind: "digest",
    scope_key: row.scope_key as string,
    version: Number(row.version),
    created_at: row.created_at as string,
    content_hash: row.content_hash as string,
    content: JSON.parse(row.content_json as string) as DigestContent,
  };
}

const SNAPSHOT_COLUMNS = "id, scope_key, version, created_at, content_hash, content_json";

function latestSnapshot(db: Db, scopeKey: string): DigestSnapshot | null {
  const row = stmt(db, `SELECT ${SNAPSHOT_COLUMNS} FROM finding_snapshots WHERE kind = 'digest' AND scope_key = ? ORDER BY version DESC LIMIT 1`).get(scopeKey);
  return row ? rowToSnapshot(row) : null;
}

function snapshotVersion(db: Db, scopeKey: string, version: number): DigestSnapshot | null {
  const row = stmt(db, `SELECT ${SNAPSHOT_COLUMNS} FROM finding_snapshots WHERE kind = 'digest' AND scope_key = ? AND version = ?`).get(scopeKey, version);
  return row ? rowToSnapshot(row) : null;
}

function insertSnapshot(db: Db, scopeKey: string, version: number, content: DigestContent, now: Date): DigestSnapshot {
  const snapshot: DigestSnapshot = {
    id: `fsn_${randomUUID()}`,
    kind: "digest",
    scope_key: scopeKey,
    version,
    created_at: now.toISOString(),
    content_hash: contentHash(content),
    content,
  };
  stmt(
    db,
    `INSERT INTO finding_snapshots (id, kind, scope_key, version, created_at, content_hash, content_json, contains_fixture_data)
     VALUES (?, 'digest', ?, ?, ?, ?, ?, ?)`,
  ).run(snapshot.id, scopeKey, version, snapshot.created_at, snapshot.content_hash, JSON.stringify(content), content.contains_fixture_data ? 1 : 0);
  return snapshot;
}

/** newer_available / changes: compare a stored snapshot with what current rows produce right now (nothing stored). */
function respond(db: Db, snapshot: DigestSnapshot, latestVersion: number, current: DigestContent, now: Date): DigestResponse {
  const newer = contentHash(current) !== snapshot.content_hash;
  return {
    snapshot,
    latest_version: latestVersion,
    newer_available: newer,
    changes: newer ? diffSnapshotFindings(snapshot.content.findings, current.findings) : emptyChanges(),
    checked_at: now.toISOString(),
    data_mode: dataMode(db),
  };
}

/**
 * GET: returns the requested version (404 if absent; never creates) or the latest, creating version 1 when the day
 * has never been opened.
 */
export function getDigest(db: Db, date: string, tz: string, now: Date, version?: number): DigestResponse {
  const scopeKey = digestScopeKey(date, tz);
  return transaction(db, () => {
    const current = buildDigestContent(db, date, tz, now);
    const latest = latestSnapshot(db, scopeKey);
    if (version !== undefined) {
      const snap = snapshotVersion(db, scopeKey, version);
      if (!snap || !latest) throw notFound("Digest version", `${scopeKey} v${version}`);
      return respond(db, snap, latest.version, current, now);
    }
    const snap = latest ?? insertSnapshot(db, scopeKey, 1, current, now);
    return respond(db, snap, snap.version, current, now);
  });
}

/** POST refresh: appends version N+1 only when the content changed; otherwise returns the latest with created=false. */
export function refreshDigest(db: Db, date: string, tz: string, now: Date): DigestRefreshResponse {
  const scopeKey = digestScopeKey(date, tz);
  return transaction(db, () => {
    const current = buildDigestContent(db, date, tz, now);
    const latest = latestSnapshot(db, scopeKey);
    if (latest && latest.content_hash === contentHash(current)) {
      return { ...respond(db, latest, latest.version, current, now), created: false };
    }
    const snap = insertSnapshot(db, scopeKey, (latest?.version ?? 0) + 1, current, now);
    return { ...respond(db, snap, snap.version, current, now), created: true };
  });
}

export function listDigestVersions(db: Db, date: string, tz: string): DigestVersionsResponse {
  const scopeKey = digestScopeKey(date, tz);
  const items = stmt(
    db,
    `SELECT id, version, created_at, content_hash, json_extract(content_json, '$.summary.total_findings') AS total_findings
     FROM finding_snapshots WHERE kind = 'digest' AND scope_key = ? ORDER BY version DESC`,
  )
    .all(scopeKey)
    .map((r) => ({
      id: r.id as string,
      version: Number(r.version),
      created_at: r.created_at as string,
      content_hash: r.content_hash as string,
      total_findings: Number(r.total_findings),
    }));
  return { scope_key: scopeKey, items };
}
