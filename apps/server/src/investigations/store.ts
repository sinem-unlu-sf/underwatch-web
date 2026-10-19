/**
 * Persistence for Ask Witness. AI output lives ONLY in investigation_turns (never in events/evidence/findings), and
 * turns are append-only (a trigger forbids deletes). Codecs stay in this module (shared db/tables.ts is frozen).
 */
import type { BundleEvidenceRef, Investigation, InvestigationSummary, InvestigationTurn } from "@kw/schema";
import { stmt } from "../db/codec";
import type { Db } from "../db/connection";

export interface TurnRecord extends InvestigationTurn {
  request_fingerprint: string;
  evidence_index: BundleEvidenceRef[];
}

const INV_COLS = "id, scope_kind, scope_id, finding_id, run_id, status, created_at, updated_at";
const TURN_COLS =
  "id, investigation_id, client_request_id, request_fingerprint, question, evidence_ids, bundle_hash, model, prompt_version, status, answer, error, evidence_index, created_at";

/** Addendum C: depth/style live in ai_meta.answer_mode (no new column); NULL for older turns. */
const TURN_SELECT = `${TURN_COLS}, json_extract(ai_meta, '$.answer_mode.depth') AS answer_depth, json_extract(ai_meta, '$.answer_mode.style') AS answer_style`;

function parseJson<T>(v: unknown, fallback: T): T {
  if (typeof v !== "string") return fallback;
  try {
    return JSON.parse(v) as T;
  } catch {
    return fallback;
  }
}

function invFromRow(r: Record<string, unknown>): Investigation {
  return {
    id: r.id as string,
    scope_kind: ((r.scope_kind as string | null) ?? "finding") as Investigation["scope_kind"],
    scope_id: (r.scope_id as string | null) ?? null,
    finding_id: (r.finding_id as string | null) ?? null,
    run_id: (r.run_id as string | null) ?? null,
    status: r.status as Investigation["status"],
    created_at: r.created_at as string,
    updated_at: r.updated_at as string,
  };
}

function turnFromRow(r: Record<string, unknown>): TurnRecord {
  return {
    id: r.id as string,
    investigation_id: r.investigation_id as string,
    client_request_id: r.client_request_id as string,
    request_fingerprint: r.request_fingerprint as string,
    question: r.question as string,
    evidence_ids: parseJson<string[]>(r.evidence_ids, []),
    bundle_hash: (r.bundle_hash as string | null) ?? null,
    model: r.model as string,
    prompt_version: r.prompt_version as string,
    status: r.status as InvestigationTurn["status"],
    answer: parseJson<InvestigationTurn["answer"]>(r.answer, null),
    error: parseJson<InvestigationTurn["error"]>(r.error, null),
    evidence_index: parseJson<BundleEvidenceRef[]>(r.evidence_index, []),
    created_at: r.created_at as string,
    ...(r.answer_depth === "concise" || r.answer_depth === "detailed" ? { depth: r.answer_depth } : {}),
    ...(r.answer_style === "standard" || r.answer_style === "simple" ? { style: r.answer_style } : {}),
  };
}

/** API shape of a turn (drops internal columns). */
export function publicTurn(t: TurnRecord): InvestigationTurn {
  const { request_fingerprint: _f, evidence_index: _e, ...rest } = t;
  return rest;
}

export function getInvestigation(db: Db, id: string): Investigation | null {
  const row = stmt(db, `SELECT ${INV_COLS} FROM investigations WHERE id = ?`).get(id);
  return row ? invFromRow(row) : null;
}

export function listInvestigations(db: Db, findingId: string): InvestigationSummary[] {
  return listWhere(db, "i.scope_kind = 'finding' AND i.finding_id = ?", [findingId]);
}

/** Run scope (scopeId = run id) or workspace scope (scopeId null). */
export function listScopedInvestigations(db: Db, kind: "run" | "workspace", scopeId: string | null): InvestigationSummary[] {
  return kind === "run" ? listWhere(db, "i.scope_kind = 'run' AND i.scope_id = ?", [scopeId]) : listWhere(db, "i.scope_kind = 'workspace'", []);
}

function listWhere(db: Db, where: string, params: unknown[]): InvestigationSummary[] {
  return stmt(
    db,
    `SELECT ${INV_COLS.split(", ").map((c) => `i.${c}`).join(", ")},
       (SELECT COUNT(*) FROM investigation_turns t WHERE t.investigation_id = i.id) AS turn_count,
       (SELECT t.question FROM investigation_turns t WHERE t.investigation_id = i.id ORDER BY t.seq DESC LIMIT 1) AS last_question
     FROM investigations i WHERE ${where} ORDER BY julianday(i.updated_at) DESC, i.id LIMIT 100`,
  )
    .all(...(params as never[]))
    .map((r) => ({ ...invFromRow(r), turn_count: Number(r.turn_count), last_question: (r.last_question as string | null) ?? null }));
}

export function getTurnByRequestId(db: Db, clientRequestId: string): TurnRecord | null {
  const row = stmt(db, `SELECT ${TURN_SELECT} FROM investigation_turns WHERE client_request_id = ?`).get(clientRequestId);
  return row ? turnFromRow(row) : null;
}

export function listTurns(db: Db, investigationId: string): TurnRecord[] {
  return stmt(db, `SELECT ${TURN_SELECT} FROM investigation_turns WHERE investigation_id = ? ORDER BY seq`)
    .all(investigationId)
    .map(turnFromRow);
}

export function insertInvestigation(db: Db, inv: Investigation): void {
  const kind = inv.scope_kind ?? "finding";
  const scopeId = kind === "finding" ? inv.finding_id : kind === "run" ? inv.run_id : null;
  stmt(db, `INSERT INTO investigations (${INV_COLS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(inv.id, kind, scopeId, inv.finding_id, inv.run_id, inv.status, inv.created_at, inv.updated_at);
}

export function touchInvestigation(db: Db, id: string, at: string): void {
  stmt(db, "UPDATE investigations SET updated_at = ? WHERE id = ?").run(at, id);
}

export function insertTurn(db: Db, t: TurnRecord, aiMeta: unknown): void {
  stmt(
    db,
    `INSERT INTO investigation_turns (${TURN_COLS}, ai_meta) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    t.id,
    t.investigation_id,
    t.client_request_id,
    t.request_fingerprint,
    t.question,
    JSON.stringify(t.evidence_ids),
    t.bundle_hash,
    t.model,
    t.prompt_version,
    t.status,
    t.answer === null ? null : JSON.stringify(t.answer),
    t.error === null ? null : JSON.stringify(t.error),
    JSON.stringify(t.evidence_index),
    t.created_at,
    aiMeta === undefined ? null : JSON.stringify(aiMeta),
  );
}
