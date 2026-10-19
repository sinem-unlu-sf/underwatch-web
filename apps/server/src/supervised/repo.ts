/** supervised_runs persistence (migration 083). */
import { safeRedact } from "@kw/redaction";
import { SupervisedRun } from "@kw/schema";
import { stmt, TableCodec } from "../db/codec";
import type { Db } from "../db/connection";
import { processRedactionOptions } from "../ingest/sanitize";

/**
 * Storage-boundary redaction for a supervised_runs row (ISSUE 3): the free-text fields (task, error, limitations) are
 * redacted fail-closed before every INSERT/UPDATE. Idempotent over earlier placeholders. The raw task is only ever
 * handed to the executor in memory; it is never stored or returned by the API.
 */
export function redactSupervisedText(text: string): string {
  return safeRedact(text, { ...processRedactionOptions(), keepCleanTextVerbatim: true }).text;
}

export function sanitizeSupervisedRun(row: SupervisedRun): SupervisedRun {
  return {
    ...row,
    task: redactSupervisedText(row.task),
    error: row.error === null ? null : redactSupervisedText(row.error),
    limitations: row.limitations.map(redactSupervisedText),
  };
}

export const supervisedRuns = new TableCodec<SupervisedRun>("supervised_runs", ["run_id"], {
  run_id: "text",
  client_request_id: "text",
  workspace_id: "text",
  task: "text",
  model: "text",
  status: "text",
  stage: "text",
  error: "text",
  policy_sha256: "text",
  workspace_snapshot_sha256: "text",
  artifacts: "json",
  capture: "json",
  ingest: "json",
  limitations: "json",
  started_at: "text",
  ended_at: "text",
});

/** A run still "running" after this long was orphaned (its process died): finalized as failed on read. */
export const STALE_SUPERVISED_RUN_MS = 30 * 60_000;

export function insertSupervised(db: Db, row: SupervisedRun): boolean {
  return supervisedRuns.insertOrIgnore(db, sanitizeSupervisedRun(row));
}

export function updateSupervised(db: Db, row: SupervisedRun): void {
  const r = supervisedRuns.toRow(sanitizeSupervisedRun(row));
  stmt(
    db,
    `UPDATE supervised_runs SET status = :status, stage = :stage, error = :error, policy_sha256 = :policy_sha256,
       workspace_snapshot_sha256 = :workspace_snapshot_sha256, artifacts = :artifacts, capture = :capture, ingest = :ingest,
       limitations = :limitations, ended_at = :ended_at WHERE run_id = :run_id`,
  ).run({
    status: r.status!,
    stage: r.stage!,
    error: r.error ?? null,
    policy_sha256: r.policy_sha256 ?? null,
    workspace_snapshot_sha256: r.workspace_snapshot_sha256 ?? null,
    artifacts: r.artifacts!,
    capture: r.capture ?? null,
    ingest: r.ingest ?? null,
    limitations: r.limitations!,
    ended_at: r.ended_at ?? null,
    run_id: r.run_id!,
  });
}

function decode(row: Record<string, unknown> | undefined): SupervisedRun | null {
  return row ? SupervisedRun.parse(supervisedRuns.fromRow(row)) : null;
}

export function getSupervised(db: Db, runId: string): SupervisedRun | null {
  return decode(stmt(db, `SELECT ${supervisedRuns.selectColumns} FROM supervised_runs WHERE run_id = ?`).get(runId));
}

export function getSupervisedByRequest(db: Db, clientRequestId: string): SupervisedRun | null {
  return decode(stmt(db, `SELECT ${supervisedRuns.selectColumns} FROM supervised_runs WHERE client_request_id = ?`).get(clientRequestId));
}

export function updateRunStatus(db: Db, runId: string, status: string, endedAt: string | null, coverage: string): void {
  stmt(db, "UPDATE runs SET status = ?, ended_at = ?, coverage_status = ? WHERE id = ?").run(status, endedAt, coverage, runId);
}

/**
 * Read for GET /api/runs/:id. A row left "running" past STALE_SUPERVISED_RUN_MS (server restarted mid-run) is
 * finalized as failed here, so the UI never polls forever. `isActive` reports runs this process is still executing.
 */
export function readSupervisedRun(db: Db, runId: string, now: Date = new Date(), isActive: (id: string) => boolean = () => false): SupervisedRun | null {
  const row = getSupervised(db, runId);
  if (!row || row.status !== "running" || isActive(runId)) return row;
  if (now.getTime() - Date.parse(row.started_at) < STALE_SUPERVISED_RUN_MS) return row;
  const done: SupervisedRun = {
    ...row,
    status: "failed",
    stage: "orphaned",
    error: "The supervised run did not finish (the server process restarted or the run was orphaned). No results were recorded.",
    ended_at: now.toISOString(),
  };
  updateSupervised(db, done);
  updateRunStatus(db, runId, "failed", done.ended_at, "unknown");
  return done;
}
