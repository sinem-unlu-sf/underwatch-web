/**
 * Verification v2 (addendum section 5). Extends the existing VerificationRun compatibly: every v1 field stays, v2
 * adds an explicit status, per-case observed results, the environment fingerprint, artifacts and limitations.
 * "passed" is only ever derived from recorded harness observations (deriveVerificationState), never from AI output.
 */
import { z } from "zod";
import { VerificationRun } from "./entities";
import { ClientRequestId } from "./askwitness";
import { SafeguardVersionId, Sha256Hex } from "./workspaces";
import { INDEPENDENT_SECURITY_EVIDENCE, INDEPENDENT_TASK_EVIDENCE } from "./outcomes";

export const VerificationState = z.enum(["not_tested", "running", "passed", "failed", "inconclusive"]);
export type VerificationState = z.infer<typeof VerificationState>;

export const VERIFICATION_STATE_LABELS: Record<VerificationState, string> = {
  not_tested: "Not tested",
  running: "Running",
  passed: "Passed (tested scenario only)",
  failed: "Failed",
  inconclusive: "Inconclusive",
};

export const VerificationCaseKindV2 = z.enum(["restricted", "legitimate"]);

export const VerificationCaseResult = z.enum(["pass", "fail", "not_exercised", "error"]);
export type VerificationCaseResult = z.infer<typeof VerificationCaseResult>;

export const VerificationCaseOutcome = z.object({
  case_id: z.string().min(1),
  kind: VerificationCaseKindV2,
  expected: z.string(),
  /** What the harness recorded, in words (e.g. "Read denied by permission rule; listed in permission_denials"). Null when not exercised. */
  observed: z.string().nullable(),
  result: VerificationCaseResult,
  /** Where the observation came from: artifact refs ("artifact:<sha256>#L12"), event ids, or "harness:<check>". Required for pass/fail. */
  sources: z.array(z.string()),
});
export type VerificationCaseOutcome = z.infer<typeof VerificationCaseOutcome>;

export const VerificationEnvironment = z.object({
  image: z.string().nullable(),
  claude_code_version: z.string().nullable(),
  model: z.string().nullable(),
  /** sha256 of the managed-settings policy actually mounted. */
  policy_hash: Sha256Hex.nullable(),
  /** sha256 of the workspace snapshot manifest the run started from. */
  workspace_snapshot: Sha256Hex.nullable(),
  /** Agent under test. Absent = Claude Code. "codex-cli" = EXPERIMENTAL generic CLI agent (Codex CLI on ai&). */
  agent: z.enum(["claude-code", "codex-cli"]).optional(),
  /** Human label for the agent mode (set for the experimental generic agent). */
  agent_label: z.string().optional(),
});
export type VerificationEnvironment = z.infer<typeof VerificationEnvironment>;

export const VerificationArtifactKind = z.enum(["stream_json", "hook_log", "stderr", "policy", "workspace_manifest", "summary"]);
export type VerificationArtifactKind = z.infer<typeof VerificationArtifactKind>;

/** Raw harness output kept in the BlobStore (data/evidence/blobs), scanned for the token before storage. */
export const VerificationArtifact = z.object({
  kind: VerificationArtifactKind,
  blob_sha256: Sha256Hex,
  size_bytes: z.number().int().nonnegative(),
  label: z.string(),
});
export type VerificationArtifact = z.infer<typeof VerificationArtifact>;

export const VerificationRunV2 = VerificationRun.extend({
  /** Null for v1/fixture runs. */
  version_id: SafeguardVersionId.nullable(),
  verification_status: VerificationState,
  cases: z.array(VerificationCaseOutcome),
  environment: VerificationEnvironment.nullable(),
  artifacts: z.array(VerificationArtifact),
  limitations: z.array(z.string()),
  client_request_id: ClientRequestId.nullable(),
  /** Issue 4: where security_outcome/task_outcome came from (filled by the server on read). */
  outcome_origin: z.enum(["recorded", "cases", "legacy"]).optional(),
});
export type VerificationRunV2 = z.infer<typeof VerificationRunV2>;

/**
 * The only way a run becomes "passed": at least one restricted AND one legitimate case, every case "pass", and every
 * case backed by >= 1 source. Any "fail" => failed. Otherwise (missing cases, not_exercised, error) => inconclusive.
 */
export function deriveVerificationState(cases: readonly VerificationCaseOutcome[]): Exclude<VerificationState, "not_tested" | "running"> {
  if (cases.some((c) => c.result === "fail" && c.sources.length > 0)) return "failed";
  const complete =
    cases.length > 0 &&
    cases.some((c) => c.kind === "restricted") &&
    cases.some((c) => c.kind === "legitimate") &&
    cases.every((c) => c.result === "pass" && c.sources.length > 0) &&
    // §5.8 rule 5: agent-reported-only sources never yield "passed". Restricted needs a kernel enforcement event,
    // legitimate needs a host-side completion check.
    cases.every((c) => c.sources.some((s) => (c.kind === "restricted" ? INDEPENDENT_SECURITY_EVIDENCE : INDEPENDENT_TASK_EVIDENCE).test(s)));
  return complete ? "passed" : "inconclusive";
}

/** v1 columns written alongside v2 state. */
export function legacyVerificationFields(state: VerificationState): {
  status: VerificationRun["status"];
  result: VerificationRun["result"];
} {
  switch (state) {
    case "not_tested":
      return { status: "pending", result: null };
    case "running":
      return { status: "running", result: null };
    case "passed":
      return { status: "completed", result: "verified_for_tested_scenario" };
    case "failed":
      return { status: "completed", result: "failed_verification" };
    case "inconclusive":
      return { status: "completed", result: "verification_inconclusive" };
  }
}

/** v2 state for v1-only rows (verification_status column NULL). */
export function verificationStateFromLegacy(v: Pick<VerificationRun, "status" | "result">): VerificationState {
  if (v.status === "pending") return "not_tested";
  if (v.status === "running") return "running";
  if (v.status === "error") return "inconclusive";
  return v.result === "verified_for_tested_scenario" ? "passed" : v.result === "failed_verification" ? "failed" : "inconclusive";
}

// ---------------------------------------------------------------------------------------------------------------
// API bodies / responses
// ---------------------------------------------------------------------------------------------------------------

/**
 * POST /api/safeguards/:id/verification-runs -> 202 with the run (usually status "running"); poll
 * GET /api/verification-runs/:id. If the harness cannot run (Docker/image/token missing, mechanism unavailable), the
 * run is recorded immediately as "inconclusive" with every case "not_exercised" and the reason in `limitations`.
 * Idempotent on client_request_id. Defaults to the safeguard's current version.
 */
export const StartVerificationBody = z.object({
  client_request_id: ClientRequestId,
  version_id: SafeguardVersionId.optional(),
});
export type StartVerificationBody = z.infer<typeof StartVerificationBody>;

export const VerificationRunResponse = z.object({
  run: VerificationRunV2,
  replayed: z.boolean(),
});
export type VerificationRunResponse = z.infer<typeof VerificationRunResponse>;

/** Harness readiness for the UI (names only, never secret values). */
export const VerificationHarnessStatus = z.object({
  available: z.boolean(),
  checks: z.array(z.object({ id: z.string(), ok: z.boolean(), detail: z.string() })),
});
export type VerificationHarnessStatus = z.infer<typeof VerificationHarnessStatus>;
