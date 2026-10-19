import { FINDINGS_SNAPSHOT_LIMIT, contentHash, type FindingsSnapshotResponse, type RunStatus } from "@kw/schema";
import { stmt } from "../db/codec";
import type { Db } from "../db/connection";
import { queryFindingList } from "../repo/findings";
import { dataMode } from "../status";
import { completeness, toSnapshotFindings, type CaveatRun } from "./snapshot-findings";

export const CURRENT_ORDER = "ORDER BY f.severity_rank DESC, julianday(f.created_at) DESC, f.id";

/**
 * Current State snapshot: all persisted findings (fixture + live, each labeled), computed on request and never stored.
 * snapshot_id is a content hash, so an unchanged hash means nothing changed. Read-only.
 */
export function getFindingsSnapshot(db: Db, now: Date): FindingsSnapshotResponse {
  const { items, total } = queryFindingList(db, { orderBy: CURRENT_ORDER, limit: FINDINGS_SNAPSHOT_LIMIT });
  const findings = toSnapshotFindings(db, items);

  // Caveats for runs referenced by the findings shown, plus any run still in progress (more findings may come).
  const runRows = stmt(
    db,
    `SELECT id, status, coverage_status FROM runs
     WHERE id IN (SELECT value FROM json_each(?)) OR status IN ('pending', 'running')
     ORDER BY julianday(started_at), id`,
  ).all(JSON.stringify([...new Set(findings.map((f) => f.run_id))]));
  const runs: CaveatRun[] = runRows.map((r) => ({ id: r.id as string, status: r.status as RunStatus, coverage_status: r.coverage_status as string }));
  const comp = completeness(db, runs);

  return {
    snapshot_id: contentHash({ findings, total, completeness: comp }),
    generated_at: now.toISOString(),
    data_mode: dataMode(db),
    findings,
    total,
    truncated: total > findings.length,
    completeness: comp,
  };
}
