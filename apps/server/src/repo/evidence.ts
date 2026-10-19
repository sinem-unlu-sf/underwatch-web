import type { Evidence, EvidenceResponse } from "@kw/schema";
import { stmt } from "../db/codec";
import type { Db } from "../db/connection";
import * as t from "../db/tables";
import { notFound } from "../errors";

export function getEvidenceByIds(db: Db, ids: readonly string[]): Evidence[] {
  if (ids.length === 0) return [];
  return stmt(db, `SELECT ${t.evidence.selectColumns} FROM evidence WHERE id IN (SELECT value FROM json_each(?)) ORDER BY julianday(timestamp), id`)
    .all(JSON.stringify(ids))
    .map((r) => t.evidence.fromRow(r));
}

/** referenced_by_finding_ids covers direct finding->evidence links and findings whose related events cite this evidence. */
export function getEvidenceDetail(db: Db, id: string): EvidenceResponse {
  const row = stmt(db, `SELECT ${t.evidence.selectColumns} FROM evidence WHERE id = ?`).get(id);
  if (!row) throw notFound("Evidence", id);
  const eventIds = stmt(db, "SELECT id FROM events WHERE evidence_id = ? ORDER BY julianday(timestamp), id")
    .all(id)
    .map((r) => r.id as string);
  const findingIds = stmt(
    db,
    `SELECT finding_id FROM finding_evidence WHERE evidence_id = :id
     UNION
     SELECT fe.finding_id FROM finding_events fe JOIN events e ON e.id = fe.event_id WHERE e.evidence_id = :id
     ORDER BY finding_id`,
  )
    .all({ id })
    .map((r) => r.finding_id as string);
  return { evidence: t.evidence.fromRow(row), referenced_by_event_ids: eventIds, referenced_by_finding_ids: findingIds };
}
