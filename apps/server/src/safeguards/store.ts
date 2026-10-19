/**
 * Persistence for safeguard v2 (versions, append-only events, v2 columns on the v1 `safeguards` row, idempotency
 * keys). Tables come from migrations/002_ask_witness.sql; this module owns their codecs.
 */
import { randomUUID } from "node:crypto";
import {
  legacySafeguardStatuses,
  lifecycleFromLegacy,
  makeStableId,
  type Safeguard,
  type SafeguardEvent,
  type SafeguardEventAction,
  type SafeguardEventActorType,
  type SafeguardLifecycleStatus,
  type SafeguardVersion,
  type VerificationState,
} from "@kw/schema";
import { stmt, TableCodec } from "../db/codec";
import type { Db } from "../db/connection";
import * as t from "../db/tables";
import { getRunRow, listRunsForSafeguard } from "../verification/repo";

export const safeguardVersions = new TableCodec<SafeguardVersion>("safeguard_versions", ["id"], {
  id: "text",
  safeguard_id: "text",
  version: "int",
  type: "text",
  content: "text",
  target: "json",
  rationale: "text",
  intended_effect: "text",
  limitations: "json",
  verification_plan: "json",
  evidence_ids: "json",
  author: "text",
  source_investigation_id: "text",
  model: "text",
  prompt_version: "text",
  created_at: "text",
});

export const safeguardEvents = new TableCodec<SafeguardEvent>("safeguard_events", ["id"], {
  id: "text",
  safeguard_id: "text",
  version_id: "text",
  action: "text",
  actor_type: "text",
  actor: "text",
  note: "text",
  details: "json",
  at: "text",
});

/** v1 row plus the nullable v2 columns (NULL = v1/fixture row). */
export interface SafeguardRecord {
  safeguard: Safeguard;
  lifecycle: SafeguardLifecycleStatus;
  verification: VerificationState;
  /** False for v1/fixture rows: they cannot be edited, approved or rolled back through v2. */
  versioned: boolean;
  current_version_id: string | null;
  workspace_id: string | null;
  source_investigation_id: string | null;
  proposal_request_id: string | null;
}

const V2_COLS = "lifecycle_status, verification_state, current_version_id, workspace_id, source_investigation_id, proposal_request_id";

/**
 * Read guard: a stored safeguard-level "passed" is served only when its latest verification run is itself served as
 * passed (verification/repo normalize() applies the Addendum A and kernel_enforcement invariants). Otherwise it is
 * served as Inconclusive. The stored row is not modified here.
 */
export function servedVerification(db: Db, safeguard: { id: string; last_verification_run_id?: string | null }, stored: VerificationState): VerificationState {
  if (stored !== "passed") return stored;
  const last = (safeguard.last_verification_run_id ? getRunRow(db, safeguard.last_verification_run_id) : null) ?? listRunsForSafeguard(db, safeguard.id)[0] ?? null;
  return last && last.verification_status === "passed" ? stored : "inconclusive";
}

export function getSafeguardRecord(db: Db, id: string): SafeguardRecord | null {
  const row = stmt(db, `SELECT ${t.safeguards.selectColumns}, ${V2_COLS} FROM safeguards WHERE id = ?`).get(id);
  if (!row) return null;
  const safeguard = t.safeguards.fromRow(row);
  const legacy = lifecycleFromLegacy(safeguard);
  const versioned = row.current_version_id != null;
  return {
    safeguard,
    lifecycle: (row.lifecycle_status as SafeguardLifecycleStatus | null) ?? legacy.lifecycle,
    verification: servedVerification(db, safeguard, (row.verification_state as VerificationState | null) ?? legacy.verification),
    versioned,
    current_version_id: (row.current_version_id as string | null) ?? null,
    workspace_id: (row.workspace_id as string | null) ?? null,
    source_investigation_id: (row.source_investigation_id as string | null) ?? null,
    proposal_request_id: (row.proposal_request_id as string | null) ?? null,
  };
}

export function listVersions(db: Db, safeguardId: string): SafeguardVersion[] {
  return stmt(db, `SELECT ${safeguardVersions.selectColumns} FROM safeguard_versions WHERE safeguard_id = ? ORDER BY version`)
    .all(safeguardId)
    .map((r) => safeguardVersions.fromRow(r));
}

export function getVersion(db: Db, versionId: string): SafeguardVersion | null {
  const row = stmt(db, `SELECT ${safeguardVersions.selectColumns} FROM safeguard_versions WHERE id = ?`).get(versionId);
  return row ? safeguardVersions.fromRow(row) : null;
}

export function listEvents(db: Db, safeguardId: string): SafeguardEvent[] {
  return stmt(db, `SELECT ${safeguardEvents.selectColumns} FROM safeguard_events WHERE safeguard_id = ? ORDER BY seq`)
    .all(safeguardId)
    .map((r) => safeguardEvents.fromRow(r));
}

export function insertVersion(db: Db, v: SafeguardVersion): void {
  if (!safeguardVersions.insertOrIgnore(db, v)) throw new Error(`safeguard version ${v.id} already exists`);
}

export function versionId(safeguardId: string, version: number): string {
  return makeStableId("safeguard_version", safeguardId, String(version));
}

export function appendEvent(
  db: Db,
  e: {
    safeguard_id: string;
    version_id: string | null;
    action: SafeguardEventAction;
    actor_type: SafeguardEventActorType;
    actor: string;
    note?: string | null;
    details?: Record<string, unknown> | null;
    at: string;
  },
): SafeguardEvent {
  const ev: SafeguardEvent = {
    id: makeStableId("safeguard_event", e.safeguard_id, randomUUID()),
    safeguard_id: e.safeguard_id,
    version_id: e.version_id,
    action: e.action,
    actor_type: e.actor_type,
    actor: e.actor,
    note: e.note ?? null,
    details: e.details ?? null,
    at: e.at,
  };
  safeguardEvents.insertOrIgnore(db, ev);
  return ev;
}

/** Writes v2 lifecycle/verification state and keeps the v1 status columns in sync (lists, overview). */
export function setState(
  db: Db,
  id: string,
  s: {
    lifecycle: SafeguardLifecycleStatus;
    verification: VerificationState;
    current_version_id?: string;
    workspace_id?: string | null;
    approved?: { at: string; by: string } | null;
    applied_at?: string | null;
    content?: string;
    last_verification_run_id?: string;
  },
): void {
  const legacy = legacySafeguardStatuses(s.lifecycle, s.verification);
  const sets: string[] = [
    "lifecycle_status = :lifecycle",
    "verification_state = :verification",
    "approval_status = :approval_status",
    "application_status = :application_status",
    "verification_status = :verification_status",
  ];
  const params: Record<string, string | null> = { id, lifecycle: s.lifecycle, verification: s.verification, ...legacy };
  if (s.current_version_id !== undefined) (sets.push("current_version_id = :cv"), (params.cv = s.current_version_id));
  if (s.workspace_id !== undefined) (sets.push("workspace_id = :ws"), (params.ws = s.workspace_id));
  if (s.approved !== undefined) {
    sets.push("approved_at = :approved_at", "approved_by = :approved_by");
    params.approved_at = s.approved?.at ?? null;
    params.approved_by = s.approved?.by ?? null;
  }
  if (s.applied_at !== undefined) (sets.push("applied_at = :applied_at"), (params.applied_at = s.applied_at));
  if (s.content !== undefined) (sets.push("content = :content"), (params.content = s.content));
  if (s.last_verification_run_id !== undefined) (sets.push("last_verification_run_id = :lvr"), (params.lvr = s.last_verification_run_id));
  stmt(db, `UPDATE safeguards SET ${sets.join(", ")} WHERE id = :id`).run(params);
}

export function insertSafeguardRow(
  db: Db,
  row: Safeguard,
  v2: { source_investigation_id: string | null; proposal_request_id: string; workspace_id: string | null },
): void {
  t.safeguards.insertOrIgnore(db, row);
  stmt(db, "UPDATE safeguards SET source_investigation_id = ?, proposal_request_id = ?, workspace_id = ? WHERE id = ?").run(
    v2.source_investigation_id,
    v2.proposal_request_id,
    v2.workspace_id,
    row.id,
  );
}

/** Applied permission_rule safeguards (current version), for the supervised-run policy. */
export function appliedOfType(db: Db, type: string): { id: string; current_version_id: string }[] {
  return stmt(db, "SELECT id, current_version_id FROM safeguards WHERE type = ? AND lifecycle_status = 'applied' AND current_version_id IS NOT NULL ORDER BY id")
    .all(type)
    .map((r) => ({ id: r.id as string, current_version_id: r.current_version_id as string }));
}

// Idempotency ---------------------------------------------------------------------------------------------------

export interface IdempotencyRecord {
  request_fingerprint: string;
  result_ref: unknown;
}

export function getIdempotency(db: Db, scope: string, key: string): IdempotencyRecord | null {
  const row = stmt(db, "SELECT request_fingerprint, result_ref FROM idempotency_keys WHERE scope = ? AND client_request_id = ?").get(scope, key);
  return row ? { request_fingerprint: row.request_fingerprint as string, result_ref: JSON.parse(row.result_ref as string) } : null;
}

export function putIdempotency(db: Db, scope: string, key: string, fingerprint: string, resultRef: unknown, at: string): boolean {
  return (
    stmt(db, "INSERT OR IGNORE INTO idempotency_keys (scope, client_request_id, request_fingerprint, result_ref, created_at) VALUES (?, ?, ?, ?, ?)").run(
      scope,
      key,
      fingerprint,
      JSON.stringify(resultRef),
      at,
    ).changes > 0
  );
}
