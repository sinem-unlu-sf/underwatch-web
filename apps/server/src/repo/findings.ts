import { randomUUID } from "node:crypto";
import type { SQLInputValue } from "node:sqlite";
import {
  allowedFindingTransitions,
  checkFindingTransition,
  type Evidence,
  type Finding,
  type FindingDetailResponse,
  type FindingListItem,
  type FindingsQuery,
  type FindingsResponse,
  type FindingStatusChange,
  type FindingStatusUpdateBody,
  type FindingStatusUpdateResponse,
  type RunFindingsResponse,
} from "@kw/schema";
import { safeRedact } from "@kw/redaction";
import { stmt } from "../db/codec";
import { processRedactionOptions } from "../ingest/sanitize";
import { transaction, type Db } from "../db/connection";
import * as t from "../db/tables";
import { ApiHttpError, notFound } from "../errors";
import { getEventsByIds, getPolicyVersion, requireRun } from "./runs";
import { countOf, fixtureCondition, whereClause } from "./sql";
import { getEvidenceByIds } from "./evidence";
import { listSafeguardsForFinding } from "./safeguards";

const FINDING_LIST_SELECT = `SELECT ${t.findings.columns("f")}, r.label AS run_label FROM findings f JOIN runs r ON r.id = f.run_id`;

/** Attaches related_event_ids / evidence_ids (in their recorded order) from the link tables. */
function attachLinks<R extends t.FindingRow>(db: Db, rows: R[]): (R & Pick<Finding, "related_event_ids" | "evidence_ids">)[] {
  if (rows.length === 0) return [];
  const ids = JSON.stringify(rows.map((r) => r.id));
  const eventLinks = new Map<string, string[]>();
  const evidenceLinks = new Map<string, string[]>();
  for (const l of stmt(db, "SELECT finding_id, event_id FROM finding_events WHERE finding_id IN (SELECT value FROM json_each(?)) ORDER BY finding_id, position").all(ids)) {
    const list = eventLinks.get(l.finding_id as string) ?? [];
    list.push(l.event_id as string);
    eventLinks.set(l.finding_id as string, list);
  }
  for (const l of stmt(db, "SELECT finding_id, evidence_id FROM finding_evidence WHERE finding_id IN (SELECT value FROM json_each(?)) ORDER BY finding_id, position").all(ids)) {
    const list = evidenceLinks.get(l.finding_id as string) ?? [];
    list.push(l.evidence_id as string);
    evidenceLinks.set(l.finding_id as string, list);
  }
  return rows.map((r) => ({ ...r, related_event_ids: eventLinks.get(r.id) ?? [], evidence_ids: evidenceLinks.get(r.id) ?? [] }));
}

function toListItems(db: Db, rows: Record<string, unknown>[]): FindingListItem[] {
  return attachLinks(
    db,
    rows.map((r) => ({ ...t.findings.fromRow(r), run_label: (r.run_label as string | null) ?? null })),
  );
}

export function queryFindingList(
  db: Db,
  opts: { where?: string; params?: Record<string, SQLInputValue>; orderBy: string; limit: number; offset?: number },
): { items: FindingListItem[]; total: number } {
  const params = opts.params ?? {};
  const where = opts.where ?? "";
  const total = countOf(stmt(db, `SELECT COUNT(*) AS n FROM findings f ${where}`).get(params));
  const rows = stmt(db, `${FINDING_LIST_SELECT} ${where} ${opts.orderBy} LIMIT :limit OFFSET :offset`).all({
    ...params,
    limit: opts.limit,
    offset: opts.offset ?? 0,
  });
  return { items: toListItems(db, rows), total };
}

export function listFindings(db: Db, q: FindingsQuery): FindingsResponse {
  const params: Record<string, SQLInputValue> = {};
  const conditions: (string | null)[] = [fixtureCondition(q.fixture, "f.is_fixture")];
  for (const key of ["status", "category", "severity", "run_id"] as const) {
    const value = q[key];
    if (value === undefined) continue;
    params[key] = value;
    conditions.push(`f.${key} = :${key}`);
  }
  return queryFindingList(db, {
    where: whereClause(conditions),
    params,
    orderBy: "ORDER BY julianday(f.created_at) DESC, f.id",
    limit: q.limit,
    offset: q.offset,
  });
}

export function listRunFindings(db: Db, runId: string): RunFindingsResponse {
  requireRun(db, runId);
  const rows = stmt(db, `${FINDING_LIST_SELECT} WHERE f.run_id = ? ORDER BY f.severity_rank DESC, julianday(f.created_at) DESC, f.id`).all(runId);
  const items = toListItems(db, rows);
  return { items, total: items.length };
}

export function getFinding(db: Db, id: string): Finding | null {
  const row = stmt(db, `SELECT ${t.findings.selectColumns} FROM findings WHERE id = ?`).get(id);
  return row ? attachLinks(db, [t.findings.fromRow(row)])[0]! : null;
}

export function requireFinding(db: Db, id: string): Finding {
  const finding = getFinding(db, id);
  if (!finding) throw notFound("Finding", id);
  return finding;
}

export function getStatusHistory(db: Db, findingId: string): FindingStatusChange[] {
  return stmt(db, `SELECT ${t.statusHistory.selectColumns} FROM finding_status_history WHERE finding_id = ? ORDER BY julianday(at), seq`)
    .all(findingId)
    .map((r) => t.statusHistory.fromRow(r));
}

export function getFindingDetail(db: Db, id: string): FindingDetailResponse {
  const finding = requireFinding(db, id);
  const run = requireRun(db, finding.run_id);
  const related_events = getEventsByIds(db, finding.related_event_ids);

  const evidenceIds = [...new Set([...finding.evidence_ids, ...related_events.flatMap((e) => (e.evidence_id ? [e.evidence_id] : []))])];
  const byId = new Map(getEvidenceByIds(db, evidenceIds).map((e) => [e.id, e]));
  const evidence = evidenceIds.flatMap((eid) => byId.get(eid) ?? []) satisfies Evidence[];

  return {
    finding,
    run,
    related_events,
    evidence,
    policy: getPolicyVersion(db, finding.policy_id ?? run.policy_version),
    status_history: getStatusHistory(db, id),
    safeguards: listSafeguardsForFinding(db, id),
    allowed_transitions: [...allowedFindingTransitions(finding.status)],
    ai_explanation: {
      status: "not_implemented",
      detail: "No automatic AI explanation is generated. Use Ask Witness on this finding for advisory, citation-checked answers (ai& Inference, optional).",
    },
  };
}

/**
 * Applies a user-requested status change. The check, the history append, and the finding update happen in one
 * IMMEDIATE transaction so a concurrent change cannot slip between the check and the write.
 */
export function updateFindingStatus(db: Db, id: string, body: FindingStatusUpdateBody, actor: string, now = new Date()): FindingStatusUpdateResponse {
  const note = body.note?.trim() ? body.note.trim() : null;
  return transaction(db, () => {
    const current = requireFinding(db, id);
    const check = checkFindingTransition(current.status, body.to, note);
    if (!check.ok) {
      throw new ApiHttpError(check.code, check.message, { from: current.status, to: body.to, allowed: allowedFindingTransitions(current.status) });
    }
    const at = now.toISOString();
    const change: FindingStatusChange = {
      id: `fsc_${randomUUID()}`,
      finding_id: id,
      // A status change made by a person is a real action even when the finding itself came from a fixture.
      is_fixture: false,
      from: current.status,
      to: body.to,
      actor_type: "user",
      actor,
      // User-typed note: redacted fail-closed before storage (ISSUE 3), like every other free-text field.
      note: note === null ? null : safeRedact(note, { ...processRedactionOptions(), keepCleanTextVerbatim: true }).text,
      at,
    };
    if (!t.statusHistory.insertOrIgnore(db, change)) throw new Error(`Duplicate status change id ${change.id}`);
    stmt(db, "UPDATE findings SET status = ?, updated_at = ? WHERE id = ?").run(body.to, at, id);
    const finding = requireFinding(db, id);
    return { finding, status_change: change, allowed_transitions: [...allowedFindingTransitions(finding.status)] };
  });
}
