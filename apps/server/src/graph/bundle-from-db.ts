/**
 * Reads everything the relational store (system of record) knows about one run and shapes it as a @kw/graph
 * RunBundle. The graph is a rebuildable projection of these rows: nothing here writes, and no file contents or evidence
 * excerpts are projected (the projector drops excerpts itself).
 */
import type { RunBundleInput } from "@kw/graph";
import type { EventCorrelation, FindingStatusChange, Safeguard, VerificationRun } from "@kw/schema";
import { stmt } from "../db/codec";
import type { Db } from "../db/connection";
import * as t from "../db/tables";
import { getFinding } from "../repo/findings";
import { getCoverage, getPolicyVersion, getRun } from "../repo/runs";
import { recordedOutcomesFromRow } from "../verification/repo";

export function listRunIds(db: Db): string[] {
  return stmt(db, "SELECT id FROM runs ORDER BY julianday(started_at), id")
    .all()
    .map((r) => r.id as string);
}

export function runBundleFromDb(db: Db, runId: string): RunBundleInput | null {
  const run = getRun(db, runId);
  if (!run) return null;
  const events = stmt(db, `SELECT ${t.events.selectColumns} FROM events WHERE run_id = ? ORDER BY id`)
    .all(runId)
    .map((r) => t.events.fromRow(r));
  const evidence = stmt(db, `SELECT ${t.evidence.selectColumns} FROM evidence WHERE run_id = ? ORDER BY id`)
    .all(runId)
    .map((r) => t.evidence.fromRow(r));
  const correlations: EventCorrelation[] = stmt(db, `SELECT ${t.correlations.selectColumns} FROM event_correlations WHERE run_id = ? ORDER BY id`)
    .all(runId)
    .map((r) => t.correlations.fromRow(r));
  const findingIds = stmt(db, "SELECT id FROM findings WHERE run_id = ? ORDER BY id")
    .all(runId)
    .map((r) => r.id as string);
  const findings = findingIds.flatMap((id) => getFinding(db, id) ?? []);
  const history: FindingStatusChange[] = stmt(
    db,
    `SELECT ${t.statusHistory.selectColumns} FROM finding_status_history WHERE finding_id IN (SELECT id FROM findings WHERE run_id = ?) ORDER BY julianday(at), seq`,
  )
    .all(runId)
    .map((r) => t.statusHistory.fromRow(r));
  const safeguards: Safeguard[] = stmt(
    db,
    `SELECT ${t.safeguards.selectColumns} FROM safeguards WHERE finding_id IN (SELECT id FROM findings WHERE run_id = ?) ORDER BY id`,
  )
    .all(runId)
    .map((r) => t.safeguards.fromRow(r));
  const verification: VerificationRun[] = stmt(
    db,
    `SELECT ${t.verificationRuns.selectColumns}, security_outcome, task_outcome, reported_task_claim FROM verification_runs WHERE safeguard_id IN (SELECT s.id FROM safeguards s JOIN findings f ON f.id = s.finding_id WHERE f.run_id = ?) ORDER BY id`,
  )
    .all(runId)
    // Issue 4: carry harness-recorded security/task outcomes into the projection (absent for historical rows).
    .map((r) => ({ ...t.verificationRuns.fromRow(r), ...recordedOutcomesFromRow(r) }));
  return {
    run,
    policy_version: getPolicyVersion(db, run.policy_version),
    events,
    evidence,
    correlations,
    findings,
    finding_status_history: history,
    safeguards,
    verification_runs: verification,
    coverage: getCoverage(db, runId),
  };
}

/** Run that owns a finding / safeguard / verification run / investigation (projection unit), or null. */
export function runIdForFinding(db: Db, findingId: string): string | null {
  return (stmt(db, "SELECT run_id FROM findings WHERE id = ?").get(findingId)?.run_id as string | undefined) ?? null;
}

export function runIdForSafeguard(db: Db, safeguardId: string): string | null {
  return (stmt(db, "SELECT f.run_id AS run_id FROM safeguards s JOIN findings f ON f.id = s.finding_id WHERE s.id = ?").get(safeguardId)?.run_id as string | undefined) ?? null;
}
