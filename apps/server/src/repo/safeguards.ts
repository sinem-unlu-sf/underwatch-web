import type { SQLInputValue } from "node:sqlite";
import type {
  FindingStatus,
  Safeguard,
  SafeguardListItem,
  SafeguardsQuery,
  SafeguardsResponse,
  VerificationRun,
  VerificationRunListItem,
} from "@kw/schema";
import { stmt } from "../db/codec";
import type { Db } from "../db/connection";
import * as t from "../db/tables";
import { countOf, fixtureCondition, whereClause } from "./sql";
import { getRunRow, recordedOutcomesFromRow } from "../verification/repo";
import { servedVerification } from "../safeguards/store";

/**
 * Read guard shared with the detail endpoint (FR10 consistency): a legacy single-value "verified" result is served only
 * when the run itself is served as passed by verification/repo normalize() (Addendum A + kernel_enforcement + rule 5).
 * Otherwise it is served as inconclusive. Stored rows are not modified.
 */
function guardRun<T extends VerificationRun>(db: Db, run: T): T {
  if (run.result !== "verified_for_tested_scenario") return run;
  const served = getRunRow(db, run.id);
  return served && served.verification_status === "passed" ? run : { ...run, result: "verification_inconclusive" };
}

/** Same guard for the safeguard-level legacy status shown in lists (the detail endpoint uses servedVerification()). */
function guardSafeguard<T extends Safeguard>(db: Db, sg: T): T {
  if (sg.verification_status !== "verified_for_tested_scenario") return sg;
  return servedVerification(db, sg, "passed") === "passed" ? sg : { ...sg, verification_status: "verification_inconclusive" };
}

const SAFEGUARD_LIST_SELECT = `SELECT ${t.safeguards.columns("sg")}, f.title AS finding_title, f.status AS finding_status, f.run_id AS run_id
  FROM safeguards sg JOIN findings f ON f.id = sg.finding_id`;

function getVerificationRun(db: Db, id: string | null): VerificationRun | null {
  if (id === null) return null;
  const row = stmt(db, `SELECT ${t.verificationRuns.selectColumns}, security_outcome, task_outcome, reported_task_claim FROM verification_runs WHERE id = ?`).get(id);
  // Issue 4: include harness-recorded outcomes when present (historical rows have none; the UI derives them as legacy).
  return row ? guardRun(db, { ...t.verificationRuns.fromRow(row), ...recordedOutcomesFromRow(row) }) : null;
}

function toListItem(db: Db, row: Record<string, unknown>): SafeguardListItem {
  const safeguard = guardSafeguard(db, t.safeguards.fromRow(row));
  return {
    ...safeguard,
    finding_title: row.finding_title as string,
    finding_status: row.finding_status as FindingStatus,
    run_id: row.run_id as string,
    last_verification: getVerificationRun(db, safeguard.last_verification_run_id),
  };
}

export function querySafeguardList(
  db: Db,
  opts: { where?: string; params?: Record<string, SQLInputValue>; limit?: number },
): { items: SafeguardListItem[]; total: number } {
  const params = opts.params ?? {};
  const where = opts.where ?? "";
  const total = countOf(stmt(db, `SELECT COUNT(*) AS n FROM safeguards sg ${where}`).get(params));
  const limit = opts.limit === undefined ? "" : "LIMIT :limit";
  const rows = stmt(db, `${SAFEGUARD_LIST_SELECT} ${where} ORDER BY julianday(sg.created_at) DESC, sg.id ${limit}`).all(
    opts.limit === undefined ? params : { ...params, limit: opts.limit },
  );
  return { items: rows.map((r) => toListItem(db, r)), total };
}

export function listSafeguards(db: Db, q: SafeguardsQuery): SafeguardsResponse {
  const params: Record<string, SQLInputValue> = {};
  const conditions: (string | null)[] = [fixtureCondition(q.fixture, "sg.is_fixture")];
  for (const key of ["approval_status", "application_status", "verification_status", "finding_id"] as const) {
    const value = q[key];
    if (value === undefined) continue;
    params[key] = value;
    conditions.push(`sg.${key} = :${key}`);
  }
  return querySafeguardList(db, { where: whereClause(conditions), params });
}

export function listSafeguardsForFinding(db: Db, findingId: string): Safeguard[] {
  return stmt(db, `SELECT ${t.safeguards.selectColumns} FROM safeguards WHERE finding_id = ? ORDER BY julianday(created_at) DESC, id`)
    .all(findingId)
    .map((r) => guardSafeguard(db, t.safeguards.fromRow(r)));
}

/** Completed verification runs, most recently ended first. */
export function recentCompletedVerifications(db: Db, limit: number): { items: VerificationRunListItem[]; total: number } {
  const total = countOf(stmt(db, "SELECT COUNT(*) AS n FROM verification_runs WHERE status = 'completed'").get());
  const rows = stmt(
    db,
    `SELECT ${t.verificationRuns.columns("v")}, v.security_outcome, v.task_outcome, v.reported_task_claim, sg.title AS safeguard_title
     FROM verification_runs v JOIN safeguards sg ON sg.id = v.safeguard_id
     WHERE v.status = 'completed'
     ORDER BY v.ended_at IS NULL, julianday(v.ended_at) DESC, v.id
     LIMIT ?`,
  ).all(limit);
  return { items: rows.map((r) => guardRun(db, { ...t.verificationRuns.fromRow(r), ...recordedOutcomesFromRow(r), safeguard_title: r.safeguard_title as string })), total };
}
