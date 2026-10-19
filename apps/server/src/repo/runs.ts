import {
  EventBasis,
  FindingStatus,
  type CoverageReport,
  type Event,
  type EventCorrelation,
  type PolicyVersion,
  type Run,
  type RunDetailResponse,
  type RunEventsQuery,
  type RunEventsResponse,
  type RunListItem,
  type RunsQuery,
  type RunsResponse,
} from "@kw/schema";
import type { SQLInputValue } from "node:sqlite";
import { stmt } from "../db/codec";
import type { Db } from "../db/connection";
import * as t from "../db/tables";
import { notFound } from "../errors";
import { EVENT_ORDER, OPEN_STATUSES_SQL, countOf, fixtureCondition, likePattern, severityFromRank, whereClause } from "./sql";

/** Runs with per-run aggregates. Wrapped as a derived table so callers can filter/sort on the aggregates. */
const RUN_LIST_SOURCE = `(
  SELECT ${t.runs.columns("r")},
    (SELECT COUNT(*) FROM events e WHERE e.run_id = r.id) AS event_count,
    (SELECT COUNT(*) FROM findings f WHERE f.run_id = r.id) AS finding_count,
    (SELECT COUNT(*) FROM findings f WHERE f.run_id = r.id AND f.status IN ${OPEN_STATUSES_SQL}) AS open_finding_count,
    (SELECT MAX(f.severity_rank) FROM findings f WHERE f.run_id = r.id AND f.status IN ${OPEN_STATUSES_SQL}) AS max_open_rank
  FROM runs r
) AS rl`;

export function toRunListItem(row: Record<string, unknown>): RunListItem {
  return {
    ...t.runs.fromRow(row),
    event_count: Number(row.event_count),
    finding_count: Number(row.finding_count),
    open_finding_count: Number(row.open_finding_count),
    max_open_severity: severityFromRank(row.max_open_rank),
  };
}

export function queryRunList(
  db: Db,
  opts: { where?: string; params?: Record<string, SQLInputValue>; orderBy: string; limit: number; offset?: number },
): { items: RunListItem[]; total: number } {
  const params = opts.params ?? {};
  const where = opts.where ?? "";
  const total = countOf(stmt(db, `SELECT COUNT(*) AS n FROM ${RUN_LIST_SOURCE} ${where}`).get(params));
  const rows = stmt(db, `SELECT * FROM ${RUN_LIST_SOURCE} ${where} ${opts.orderBy} LIMIT :limit OFFSET :offset`).all({
    ...params,
    limit: opts.limit,
    offset: opts.offset ?? 0,
  });
  return { items: rows.map(toRunListItem), total };
}

export const RECENT_RUNS_ORDER = "ORDER BY julianday(rl.started_at) DESC, rl.id";

export function listRuns(db: Db, q: RunsQuery): RunsResponse {
  const params: Record<string, SQLInputValue> = {};
  const conditions: (string | null)[] = [fixtureCondition(q.fixture, "rl.is_fixture")];
  if (q.q) {
    params.q = likePattern(q.q);
    conditions.push("(rl.id LIKE :q ESCAPE '\\' OR rl.label LIKE :q ESCAPE '\\' OR rl.task_description LIKE :q ESCAPE '\\')");
  }
  if (q.agent) {
    params.agent = q.agent;
    conditions.push("rl.agent_type = :agent");
  }
  if (q.status) {
    params.status = q.status;
    conditions.push("rl.status = :status");
  }
  if (q.from) {
    params.from = q.from;
    conditions.push("julianday(rl.started_at) >= julianday(:from)");
  }
  if (q.to) {
    params.to = q.to;
    conditions.push("julianday(rl.started_at) <= julianday(:to)");
  }
  if (q.has_findings !== undefined) conditions.push(q.has_findings ? "rl.finding_count > 0" : "rl.finding_count = 0");

  return queryRunList(db, { where: whereClause(conditions), params, orderBy: RECENT_RUNS_ORDER, limit: q.limit, offset: q.offset });
}

export function getRun(db: Db, id: string): Run | null {
  const row = stmt(db, `SELECT ${t.runs.selectColumns} FROM runs WHERE id = ?`).get(id);
  return row ? t.runs.fromRow(row) : null;
}

export function requireRun(db: Db, id: string): Run {
  const run = getRun(db, id);
  if (!run) throw notFound("Run", id);
  return run;
}

export function getPolicyVersion(db: Db, id: string | null): PolicyVersion | null {
  if (id === null) return null;
  const row = stmt(db, `SELECT ${t.policyVersions.selectColumns} FROM policy_versions WHERE id = ?`).get(id);
  return row ? t.policyVersions.fromRow(row) : null;
}

export function getCoverage(db: Db, runId: string): CoverageReport | null {
  const row = stmt(db, `SELECT ${t.coverageReports.selectColumns} FROM coverage_reports WHERE run_id = ?`).get(runId);
  return row ? t.coverageReports.fromRow(row) : null;
}

export function getRunDetail(db: Db, id: string): RunDetailResponse {
  const run = requireRun(db, id);

  const eventsByBasis = Object.fromEntries(EventBasis.options.map((b) => [b, 0])) as Record<EventBasis, number>;
  for (const r of stmt(db, "SELECT basis, COUNT(*) AS n FROM events WHERE run_id = ? GROUP BY basis").all(id)) {
    eventsByBasis[r.basis as EventBasis] = Number(r.n);
  }
  const findingsByStatus = Object.fromEntries(FindingStatus.options.map((s) => [s, 0])) as Record<FindingStatus, number>;
  for (const r of stmt(db, "SELECT status, COUNT(*) AS n FROM findings WHERE run_id = ? GROUP BY status").all(id)) {
    findingsByStatus[r.status as FindingStatus] = Number(r.n);
  }

  return {
    run,
    policy: getPolicyVersion(db, run.policy_version),
    coverage: getCoverage(db, id),
    counts: {
      events: Object.values(eventsByBasis).reduce((a, b) => a + b, 0),
      events_by_basis: eventsByBasis,
      evidence: countOf(stmt(db, "SELECT COUNT(*) AS n FROM evidence WHERE run_id = ?").get(id)),
      findings: Object.values(findingsByStatus).reduce((a, b) => a + b, 0),
      findings_by_status: findingsByStatus,
      open_findings: countOf(stmt(db, `SELECT COUNT(*) AS n FROM findings WHERE run_id = ? AND status IN ${OPEN_STATUSES_SQL}`).get(id)),
    },
  };
}

export function getRunEvents(db: Db, runId: string, q: RunEventsQuery): RunEventsResponse {
  requireRun(db, runId);
  const params: Record<string, SQLInputValue> = { run_id: runId };
  const conditions = ["e.run_id = :run_id"];
  if (q.event_type) {
    params.event_type = q.event_type;
    conditions.push("e.event_type = :event_type");
  }
  if (q.outcome) {
    params.outcome = q.outcome;
    conditions.push("e.outcome = :outcome");
  }
  if (q.process_id !== undefined) {
    params.process_id = q.process_id;
    conditions.push("e.process_id = :process_id");
  }
  if (q.basis) {
    params.basis = q.basis;
    conditions.push("e.basis = :basis");
  }
  if (q.finding_id) {
    params.finding_id = q.finding_id;
    conditions.push("e.id IN (SELECT event_id FROM finding_events WHERE finding_id = :finding_id)");
  }
  const items: Event[] = stmt(db, `SELECT ${t.events.columns("e")} FROM events e ${whereClause(conditions)} ${EVENT_ORDER}`)
    .all(params)
    .map((r) => t.events.fromRow(r));
  const correlations: EventCorrelation[] = stmt(
    db,
    `SELECT ${t.correlations.selectColumns} FROM event_correlations WHERE run_id = ? ORDER BY id`,
  )
    .all(runId)
    .map((r) => t.correlations.fromRow(r));
  return { items, total: items.length, correlations };
}

export function getEventsByIds(db: Db, ids: readonly string[]): Event[] {
  if (ids.length === 0) return [];
  return stmt(db, `SELECT ${t.events.columns("e")} FROM events e WHERE e.id IN (SELECT value FROM json_each(?)) ${EVENT_ORDER}`)
    .all(JSON.stringify(ids))
    .map((r) => t.events.fromRow(r));
}
