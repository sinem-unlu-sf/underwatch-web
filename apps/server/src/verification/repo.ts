/** verification_runs persistence (v1 columns + v2 columns from migration 002). Module-local codec. */
import {
  ReportedTaskClaim,
  SecurityOutcome,
  TaskOutcome,
  deriveVerificationStateFromOutcomes,
  outcomesForRun,
  verificationStateFromLegacy,
  type VerificationRunV2,
} from "@kw/schema";
import { stmt, TableCodec } from "../db/codec";
import type { Db } from "../db/connection";

/** Stored columns. outcome_origin is computed on read, never stored. */
type StoredRunV2 = Omit<VerificationRunV2, "outcome_origin">;

export const runsV2 = new TableCodec<StoredRunV2>("verification_runs", ["id"], {
  id: "text",
  safeguard_id: "text",
  finding_id: "text",
  is_fixture: "bool",
  scenario_id: "text",
  scenario_description: "text",
  environment_id: "text",
  run_id: "text",
  status: "text",
  result: "text",
  prohibited_behavior_attempted: "bool",
  prohibited_behavior_blocked: "bool",
  legitimate_behavior_worked: "bool",
  observed_event_ids: "json",
  evidence_ids: "json",
  notes: "text",
  started_at: "text",
  ended_at: "text",
  version_id: "text",
  verification_status: "text",
  cases: "json",
  environment: "json",
  artifacts: "json",
  limitations: "json",
  client_request_id: "text",
  // Issue 4 (migration 080): separate, independently evidenced outcomes. NULL = not recorded (historical row).
  security_outcome: "json",
  task_outcome: "json",
  reported_task_claim: "json",
});

/** Safeguard type of the run's safeguard (read-only; used by the kernel_enforcement read guard in normalize()). */
const SG_TYPE_COL = "(SELECT s.type FROM safeguards s WHERE s.id = verification_runs.safeguard_id) AS kw_safeguard_type";

/** v1/fixture rows have NULL v2 columns: derive the v2 state from the legacy columns. */
function normalize(row: Record<string, unknown>): VerificationRunV2 {
  const r = runsV2.fromRow(row);
  const outcomes = readOutcomes(r);
  const limitations = r.limitations ?? [];
  let state = r.verification_status;
  if (state === null || state === undefined) {
    // Legacy row: the old single verdict stays untouched in `result`. It is shown as Passed only if the separate
    // outcomes independently establish a pass (Addendum A); a legacy "verified" without task evidence is Inconclusive.
    state = verificationStateFromLegacy(r);
    if (state === "passed" && deriveVerificationStateFromOutcomes(outcomes.security_outcome!, outcomes.task_outcome!) !== "passed") {
      state = "inconclusive";
      limitations.push(
        `Legacy record: its recorded result "${r.result}" is kept as a legacy field, but no independently observed task success was recorded, so it is shown as Inconclusive.`,
      );
    }
  } else if (state === "passed") {
    // Read-path enforcement of the Addendum A invariant: a stored "passed" is served only when the run's own outcomes
    // establish it (security observed blocked AND task observed succeeded). Rows written inconsistently (e.g. a stale
    // outcome, a partial integration, a tampered column) are served as Inconclusive; the stored row is not modified.
    const byOutcomes = deriveVerificationStateFromOutcomes(outcomes.security_outcome!, outcomes.task_outcome!);
    if (byOutcomes !== "passed") {
      state = "inconclusive";
      limitations.push(
        `Stored status was "passed", but the run's outcomes do not establish it (security ${outcomes.security_outcome!.value}/${outcomes.security_outcome!.basis ?? "no basis"}, task ${outcomes.task_outcome!.value}/${outcomes.task_outcome!.basis ?? "no basis"}; outcomes ${outcomes.outcome_origin}). Shown as Inconclusive; re-run the verification.`,
      );
    }
  }
  if (state === "passed" && row.kw_safeguard_type === "kernel_enforcement" && !(outcomes.security_outcome?.evidence_ids ?? []).some((e) => e.startsWith("event:"))) {
    // A kernel_enforcement pass needs a recorded Tetragon block event (cited as event:<id>). Rows stored by an earlier
    // evaluator passed on Claude Code's own permission denial with no kernel block, i.e. the kernel policy was never
    // exercised. Served as Inconclusive; the stored row is not modified.
    state = "inconclusive";
    limitations.push(
      "Stored status was \"passed\" for a kernel_enforcement safeguard, but the security outcome cites no Tetragon block event: the kernel policy was not exercised (the attempt was stopped earlier, e.g. by Claude Code's permission layer). Shown as Inconclusive; re-run the verification.",
    );
  }
  if (state === "passed" && !(outcomes.security_outcome?.evidence_ids ?? []).some((e) => e.startsWith("event:"))) {
    // ARCHITECTURE §5.8 rule 5 (any safeguard type): a block attested only by agent-reported records (permission_denials,
    // hook spool, canary scan of agent output) is never "passed". Rows stored before this rule are served as Inconclusive.
    state = "inconclusive";
    limitations.push(
      'Stored status was "passed", but the block is attested only by agent-reported records (no independent kernel enforcement event): agent-reported denial, no independent attestation. Shown as Inconclusive.',
    );
  }
  return {
    ...r,
    verification_status: state,
    cases: r.cases ?? [],
    artifacts: r.artifacts ?? [],
    limitations,
    observed_event_ids: r.observed_event_ids ?? [],
    evidence_ids: r.evidence_ids ?? [],
    ...outcomes,
  };
}

/**
 * Recorded outcomes when both are stored and valid; otherwise derived (from stored cases or legacy columns) and
 * labeled by outcome_origin. Derived values are never written back as if recorded (see storable()).
 */
function readOutcomes(r: StoredRunV2): Pick<VerificationRunV2, "security_outcome" | "task_outcome" | "reported_task_claim" | "outcome_origin"> {
  const sec = r.security_outcome == null ? null : SecurityOutcome.safeParse(r.security_outcome);
  const task = r.task_outcome == null ? null : TaskOutcome.safeParse(r.task_outcome);
  const claim = r.reported_task_claim == null ? null : ReportedTaskClaim.safeParse(r.reported_task_claim);
  const o = outcomesForRun({
    ...r,
    status: r.status,
    cases: r.cases ?? [],
    observed_event_ids: r.observed_event_ids ?? [],
    evidence_ids: r.evidence_ids ?? [],
    security_outcome: sec?.success && task?.success ? sec.data : null,
    task_outcome: sec?.success && task?.success ? task.data : null,
    reported_task_claim: claim?.success ? claim.data : null,
    outcome_origin: null,
  });
  return o;
}

/**
 * Recorded (never derived) outcomes from raw verification_runs columns, validated; {} when not recorded. For readers
 * that use the v1 codec (e.g. graph bundle-from-db) so a projection carries harness-recorded outcomes, while
 * historical rows stay without them and are derived as legacy downstream.
 */
export function recordedOutcomesFromRow(row: Record<string, unknown>): Partial<Pick<VerificationRunV2, "security_outcome" | "task_outcome" | "reported_task_claim">> {
  const parse = (v: unknown): unknown => {
    if (typeof v !== "string") return null;
    try {
      return JSON.parse(v);
    } catch {
      return null;
    }
  };
  const sec = SecurityOutcome.safeParse(parse(row.security_outcome));
  const task = TaskOutcome.safeParse(parse(row.task_outcome));
  if (!sec.success || !task.success) return {};
  const claim = ReportedTaskClaim.safeParse(parse(row.reported_task_claim));
  return { security_outcome: sec.data, task_outcome: task.data, reported_task_claim: claim.success ? claim.data : null };
}

/** Row for storage: undefined -> NULL, and outcomes derived on read (origin cases/legacy) are not persisted as recorded. */
function storable(run: VerificationRunV2): StoredRunV2 {
  const { outcome_origin, ...rest } = run;
  const derived = outcome_origin !== undefined && outcome_origin !== "recorded";
  // The codec encodes null as SQL NULL (undefined would throw); the optional schema fields have no null, hence the cast.
  return {
    ...rest,
    security_outcome: derived ? null : (run.security_outcome ?? null),
    task_outcome: derived ? null : (run.task_outcome ?? null),
    reported_task_claim: run.reported_task_claim ?? null,
  } as unknown as StoredRunV2;
}

export function getRunRow(db: Db, id: string): VerificationRunV2 | null {
  const row = stmt(db, `SELECT ${runsV2.selectColumns}, ${SG_TYPE_COL} FROM verification_runs WHERE id = ?`).get(id);
  return row ? normalize(row) : null;
}

export function getRunByRequest(db: Db, clientRequestId: string): VerificationRunV2 | null {
  const row = stmt(db, `SELECT ${runsV2.selectColumns}, ${SG_TYPE_COL} FROM verification_runs WHERE client_request_id = ?`).get(clientRequestId);
  return row ? normalize(row) : null;
}

export function listRunsForSafeguard(db: Db, safeguardId: string): VerificationRunV2[] {
  return stmt(db, `SELECT ${runsV2.selectColumns}, ${SG_TYPE_COL} FROM verification_runs WHERE safeguard_id = ? ORDER BY julianday(started_at) DESC, id`)
    .all(safeguardId)
    .map(normalize);
}

export function insertRun(db: Db, run: VerificationRunV2): boolean {
  return runsV2.insertOrIgnore(db, storable(run));
}

/** Overwrites a v2 run row (only ever called by this module for runs it created; fixture rows are never updated). */
export function updateRun(db: Db, run: VerificationRunV2): void {
  const row = runsV2.toRow(storable(run));
  const cols = Object.keys(row).filter((c) => c !== "id");
  stmt(db, `UPDATE verification_runs SET ${cols.map((c) => `${c} = :${c}`).join(", ")} WHERE id = :id AND is_fixture = 0`).run(row);
}

export interface SafeguardRowLite {
  id: string;
  finding_id: string;
  type: string;
  is_fixture: boolean;
  current_version_id: string | null;
  workspace_id: string | null;
}

export function getSafeguardLite(db: Db, id: string): SafeguardRowLite | null {
  const r = stmt(db, "SELECT id, finding_id, type, is_fixture, current_version_id, workspace_id FROM safeguards WHERE id = ?").get(id) as
    | Record<string, unknown>
    | undefined;
  if (!r) return null;
  return {
    id: r.id as string,
    finding_id: r.finding_id as string,
    type: r.type as string,
    is_fixture: r.is_fixture === 1 || r.is_fixture === 1n,
    current_version_id: (r.current_version_id as string | null) ?? null,
    workspace_id: (r.workspace_id as string | null) ?? null,
  };
}
