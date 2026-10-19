/**
 * Safeguard v2 (addendum Feature B). The existing `Safeguard` entity/row keeps working (lists, overview, fixtures);
 * v2 adds immutable versions, an append-only event history, an explicit lifecycle, and a capability table that says
 * honestly what each mechanism can and cannot enforce and whether this build can apply AND test it.
 */
import { z } from "zod";
import { FindingId, RunId, Safeguard as SafeguardEntity, SafeguardId, Timestamp } from "./entities";
import {
  SafeguardType,
  Severity,
  type SafeguardApplicationStatus,
  type SafeguardApprovalStatus,
  type SafeguardVerificationStatus,
} from "./enums";
import { ClientRequestId, InvestigationId } from "./askwitness";
import { idPattern } from "./ids";
import { FileDiffPreview, SafeguardVersionId, Sha256Hex, Workspace, WorkspaceFileChange, WorkspaceFileChangeId, WorkspaceId } from "./workspaces";
import { VerificationCaseKindV2, VerificationRunV2, VerificationState } from "./verification";

export const SafeguardEventId = z.string().regex(idPattern("safeguard_event"));

/** v2 lifecycle. "approved" is transient in the normal flow (approve -> apply -> applied | application_failed). */
export const SafeguardLifecycleStatus = z.enum(["proposed", "rejected", "approved", "applied", "application_failed", "rolled_back"]);
export type SafeguardLifecycleStatus = z.infer<typeof SafeguardLifecycleStatus>;

export const SAFEGUARD_LIFECYCLE_LABELS: Record<SafeguardLifecycleStatus, string> = {
  proposed: "Proposed",
  rejected: "Rejected",
  approved: "Approved (not yet applied)",
  applied: "Applied",
  application_failed: "Application failed",
  rolled_back: "Rolled back",
};

/**
 * Allowed lifecycle moves, enforced by the server (409 invalid_transition otherwise):
 * - edit (POST versions) creates a new version and returns to "proposed" from any state except "approved".
 *   Editing an applied safeguard does NOT touch the file; the next approve applies the new version over the current file.
 * - approve from proposed | application_failed | rolled_back.
 * - reject from proposed | application_failed | rolled_back.
 * - rollback only from applied.
 */
export const SAFEGUARD_LIFECYCLE_TRANSITIONS: Readonly<Record<SafeguardLifecycleStatus, readonly SafeguardLifecycleStatus[]>> = {
  proposed: ["proposed", "approved", "rejected"],
  rejected: ["proposed"],
  approved: ["applied", "application_failed"],
  applied: ["proposed", "rolled_back"],
  application_failed: ["proposed", "approved", "rejected"],
  rolled_back: ["proposed", "approved", "rejected"],
};

export function canTransitionSafeguard(from: SafeguardLifecycleStatus, to: SafeguardLifecycleStatus): boolean {
  return SAFEGUARD_LIFECYCLE_TRANSITIONS[from].includes(to);
}

export const SafeguardAuthor = z.enum(["ai", "template", "user"]);
export type SafeguardAuthor = z.infer<typeof SafeguardAuthor>;

/**
 * workspace_file:        a file in an authorized workspace (CLAUDE.md only in this build).
 * supervised_run_policy: Underwatch's own read-only managed policy for KW-supervised agent runs (docker/agent/policy).
 *                        Never written into the user's repository or the host's Claude Code settings.
 * scenario:              a verification scenario stored by Underwatch (regression test); nothing is written anywhere.
 */
export const SafeguardTargetKind = z.enum(["workspace_file", "supervised_run_policy", "scenario"]);
export type SafeguardTargetKind = z.infer<typeof SafeguardTargetKind>;

export const SafeguardTarget = z.object({
  kind: SafeguardTargetKind,
  workspace_id: WorkspaceId.optional(),
  rel_path: z.string().min(1).optional(),
});
export type SafeguardTarget = z.infer<typeof SafeguardTarget>;

export const VerificationCaseKind = VerificationCaseKindV2;
export type VerificationCaseKind = z.infer<typeof VerificationCaseKind>;

export const VerificationPlanCase = z.object({
  /** Stable within the plan, e.g. "restricted-env-read-bash". */
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,60}$/),
  kind: VerificationCaseKind,
  description: z.string().min(1).max(1000),
  /** Expected observable outcome, e.g. "blocked", "denied", "succeeded", "file unchanged". */
  expected: z.string().min(1).max(300),
});
export type VerificationPlanCase = z.infer<typeof VerificationPlanCase>;

export const VerificationPlan = z.object({ cases: z.array(VerificationPlanCase).max(10) });
export type VerificationPlan = z.infer<typeof VerificationPlan>;

/** Immutable. Edits create a new version (version + 1); the original AI/template proposal is never overwritten. */
export const SafeguardVersion = z.object({
  id: SafeguardVersionId,
  safeguard_id: SafeguardId,
  version: z.number().int().positive(),
  type: SafeguardType,
  /** Instruction text (claude_md), rule JSON (permission_rule), hook spec (hook_policy), or scenario text (regression_test). */
  content: z.string().min(1).max(8000),
  target: SafeguardTarget,
  rationale: z.string(),
  intended_effect: z.string(),
  limitations: z.array(z.string()),
  verification_plan: VerificationPlan,
  /** In-bundle evidence ids the proposal cites (validated against the bundle; invalid ids dropped and noted in history). */
  evidence_ids: z.array(z.string()),
  author: SafeguardAuthor,
  source_investigation_id: InvestigationId.nullable(),
  /** Provenance for author "ai" (null otherwise). */
  model: z.string().nullable(),
  prompt_version: z.string().nullable(),
  created_at: Timestamp,
});
export type SafeguardVersion = z.infer<typeof SafeguardVersion>;

export const SafeguardEventAction = z.enum([
  "proposed",
  "edited",
  "rejected",
  "approved",
  "applied",
  "application_failed",
  "conflict_detected",
  "rolled_back",
]);
export type SafeguardEventAction = z.infer<typeof SafeguardEventAction>;

/** "ai" = the ai& proposer (never the supervised agent, which can never act on safeguards). */
export const SafeguardEventActorType = z.enum(["user", "system", "ai"]);
export type SafeguardEventActorType = z.infer<typeof SafeguardEventActorType>;

/** Append-only history row. */
export const SafeguardEvent = z.object({
  id: SafeguardEventId,
  safeguard_id: SafeguardId,
  version_id: SafeguardVersionId.nullable(),
  action: SafeguardEventAction,
  actor_type: SafeguardEventActorType,
  actor: z.string().min(1),
  note: z.string().nullable(),
  /** e.g. {change_id, before_sha256, after_sha256} or {expected_sha256, current_sha256}. Never file contents or secrets. */
  details: z.record(z.string(), z.unknown()).nullable(),
  at: Timestamp,
});
export type SafeguardEvent = z.infer<typeof SafeguardEvent>;

// ---------------------------------------------------------------------------------------------------------------
// Mechanism capability table (server + UI). Statements come from the verified research
// (scratchpad plan/_integ/research_claude-code.md, Claude Code 2.1.302); see docs/ASK-WITNESS.md section 2.
// ---------------------------------------------------------------------------------------------------------------

export const MechanismKind = z.enum(["instruction", "permission control", "hook", "test", "kernel enforcement"]);
export type MechanismKind = z.infer<typeof MechanismKind>;

export const MechanismAvailability = z.discriminatedUnion("status", [
  z.object({ status: z.literal("available"), requires: z.array(z.string()) }),
  z.object({ status: z.literal("unavailable"), reason: z.string() }),
]);
export type MechanismAvailability = z.infer<typeof MechanismAvailability>;

export const MechanismInfo = z.object({
  type: SafeguardType,
  kind: MechanismKind,
  label: z.string(),
  /** False for instructions and tests. The UI must never call a can_enforce=false safeguard an "enforced control". */
  can_enforce: z.boolean(),
  can: z.array(z.string()),
  cannot: z.array(z.string()),
  apply_target: SafeguardTargetKind,
  /** How "apply" works in this build, in one sentence. */
  apply_description: z.string(),
  /** How verification works in this build, in one sentence. */
  test_description: z.string(),
  availability: MechanismAvailability,
});
export type MechanismInfo = z.infer<typeof MechanismInfo>;

const VERIFY_REQUIRES = ["Docker running", "kw-agent:2.1.302 image built", "Claude OAuth token at ~/.underwatch/claude-oauth-token"];

export const MECHANISMS: Readonly<Record<SafeguardType, MechanismInfo>> = {
  claude_md_instruction: {
    type: "claude_md_instruction",
    kind: "instruction",
    label: "CLAUDE.md instruction",
    can_enforce: false,
    can: [
      "Gives Claude Code project guidance: CLAUDE.md in the working directory and every ancestor is loaded at session start; subdirectory CLAUDE.md files load on demand.",
      "Can make the agent less likely to attempt the action, and more likely to report blocked or failed operations accurately.",
    ],
    cannot: [
      "Cannot block any action. It is guidance, not a security boundary.",
      "Does not apply to a session already running: root CLAUDE.md is read once at session start (applies after /clear, /compact or restart).",
      "The agent can edit CLAUDE.md itself (it stayed writable even under the native sandbox in testing).",
    ],
    apply_target: "workspace_file",
    apply_description: "After explicit approval, Underwatch writes a marked block into CLAUDE.md in an authorized workspace (hash compare-and-swap, before/after stored for rollback).",
    test_description: "A controlled Claude Code run in the disposable kw-agent container against a snapshot of the workspace; results come from the run's recorded stream-json/hook output.",
    availability: { status: "available", requires: VERIFY_REQUIRES },
  },
  permission_rule: {
    type: "permission_rule",
    kind: "permission control",
    label: "Claude Code permission rule",
    can_enforce: true,
    can: [
      "Deny rules are evaluated before ask and allow rules; a Read(...) deny blocks the Read tool on matching paths (and Edit/Write on them).",
      "A Read(...) deny also blocks the Bash file commands Claude Code recognizes (cat, head, tail, sed, tee) and redirect targets on matching paths.",
      "In KW-supervised runs it is delivered through read-only managed settings with allowManagedPermissionRulesOnly, so repository settings cannot remove it.",
    ],
    cannot: [
      "Does not stop arbitrary subprocesses (e.g. python3 open('.env'), grep -r) unless the OS sandbox is enabled; the native sandbox cannot start inside KW's unprivileged Docker agent container.",
      "Bash deny rules match command text only (not /bin/rm, sh -c '...', reordered flags); Claude Code documents them as not a security boundary.",
      "Applies only to Underwatch verification runs of this safeguard (supervised runs do not load applied safeguards in this build); it does not change your own Claude Code settings on this Mac.",
      "Read-rule denials are rejected before hooks run; they are visible only in result.permission_denials / PostToolBatch / the transcript.",
    ],
    apply_target: "supervised_run_policy",
    apply_description: "After explicit approval, the rule is recorded as applied in Underwatch and is put in the managed policy (mounted read-only at /etc/claude-code in the agent container) of this safeguard's verification runs. In this build, Start supervised run does not load applied safeguards; nothing in your repository or your own Claude Code settings changes.",
    test_description: "A controlled Claude Code run in the disposable kw-agent container with the rule in its managed policy; restricted and legitimate cases are judged from recorded permission_denials, tool results and hook events.",
    availability: { status: "available", requires: VERIFY_REQUIRES },
  },
  hook_policy: {
    type: "hook_policy",
    kind: "hook",
    label: "Claude Code hook",
    can_enforce: true,
    can: [
      "A PreToolUse command hook returning hookSpecificOutput.permissionDecision \"deny\" blocks the tool call (exercised: blocked a Read of .env).",
      "With onFailure: \"block\" a failing or timed-out hook blocks the action instead of failing open.",
    ],
    cannot: [
      "A hook that matches only the Read tool does not stop Bash `cat .env` (exercised).",
      "Hooks never see Read/Edit calls already rejected by a permission deny rule.",
      "Hooks fail open by default; the matcher \"if\" field is best-effort.",
    ],
    apply_target: "supervised_run_policy",
    apply_description: "Not applied in this build: Underwatch does not generate or install enforcement hook scripts.",
    test_description: "Not tested in this build.",
    availability: {
      status: "unavailable",
      reason:
        "Underwatch does not yet generate, apply or test enforcement hook scripts. The supervised-run policy only installs the read-only kw-hook recorder. Hook proposals are shown as text only.",
    },
  },
  regression_test: {
    type: "regression_test",
    kind: "test",
    label: "Regression / verification test",
    can_enforce: false,
    can: [
      "Re-runs the restricted case and a legitimate case in a disposable container and records what was actually observed.",
      "Detects a regression when a later policy or instruction change lets the restricted action succeed again.",
    ],
    cannot: [
      "Prevents nothing by itself.",
      "A pass covers only the tested scenario, model and policy; agent behavior is non-deterministic.",
    ],
    apply_target: "scenario",
    apply_description: "After approval the scenario is stored in Underwatch and linked to the finding; nothing is written to your repository.",
    test_description: "Executed by the same controlled kw-agent harness; status comes only from recorded harness observations.",
    availability: { status: "available", requires: VERIFY_REQUIRES },
  },
  kernel_enforcement: {
    type: "kernel_enforcement",
    kind: "kernel enforcement",
    label: "Kernel enforcement (Tetragon deny-file-open)",
    can_enforce: true,
    can: [
      "Denies open() of the listed paths in-kernel (BPF-LSM file_open Override -> EPERM) for every process in the disposable agent container, including Bash, python3 and other subprocesses that a Claude Code permission rule does not see.",
      "Also denies rename and hard-link of the protected paths (and their parent directories), so the file cannot be moved to an unprotected name after the policy is loaded.",
      "Each denial is recorded by Tetragon as an observed event carrying the policy name and sha256, outside the agent container.",
    ],
    cannot: [
      "Applies only to the disposable verification / supervised container it is scoped to (by pid namespace) and only while that run lasts; it does not protect your Mac or other containers.",
      "Does not stop reads of files opened before the policy loaded, copies made earlier, or other names that already pointed to the file (the harness holds the agent behind a start gate until the policy is loaded).",
      "Does not hide the content of paths that are not listed, and says nothing about what an allowed read returned.",
      "mmap-only access is stopped only because the open itself fails; read-time hooks alone would not catch mmap.",
      "Depends on the Docker Desktop kernel keeping BTF, BPF-LSM and override support (reported by the observer health check).",
    ],
    apply_target: "supervised_run_policy",
    apply_description: "After explicit approval, the policy is recorded as applied in Underwatch; during this safeguard's verification runs Underwatch loads a Tetragon deny-file-open policy scoped to the disposable agent container's pid namespace and removes it afterwards. In this build, Start supervised run does not load applied safeguards; nothing in your repository or on your Mac changes.",
    test_description: "A controlled Claude Code run in the disposable kw-agent container with the policy loaded before the agent starts; the restricted case is judged from Tetragon's kernel events (blocked / succeeded opens) plus the host-side records.",
    availability: { status: "available", requires: [...VERIFY_REQUIRES, "kw-tetragon observer (Tetragon v1.7.0) healthy with BPF-LSM support"] },
  },
};

// ---------------------------------------------------------------------------------------------------------------
// Compatibility with the v1 Safeguard row (lists, overview, fixtures keep working)
// ---------------------------------------------------------------------------------------------------------------

/** v1 fields written alongside v2 state so existing list/overview queries stay correct. */
export function legacySafeguardStatuses(
  lifecycle: SafeguardLifecycleStatus,
  verification: VerificationState,
): { approval_status: SafeguardApprovalStatus; application_status: SafeguardApplicationStatus; verification_status: SafeguardVerificationStatus } {
  const approval_status: SafeguardApprovalStatus =
    lifecycle === "rejected" ? "rejected" : lifecycle === "proposed" ? "proposed" : "approved";
  const application_status: SafeguardApplicationStatus =
    lifecycle === "applied" ? "applied" : lifecycle === "application_failed" ? "application_failed" : lifecycle === "rolled_back" ? "reverted" : "not_applied";
  const verification_status: SafeguardVerificationStatus = {
    not_tested: "not_tested",
    running: "test_pending",
    passed: "verified_for_tested_scenario",
    failed: "failed_verification",
    inconclusive: "verification_inconclusive",
  }[verification] as SafeguardVerificationStatus;
  return { approval_status, application_status, verification_status };
}

/** Derives v2 state for v1-only rows (fixtures / pre-addendum), where the v2 columns are NULL. */
export function lifecycleFromLegacy(s: Pick<SafeguardEntity, "approval_status" | "application_status" | "verification_status">): {
  lifecycle: SafeguardLifecycleStatus;
  verification: VerificationState;
} {
  const lifecycle: SafeguardLifecycleStatus =
    s.approval_status === "rejected"
      ? "rejected"
      : s.application_status === "applied"
        ? "applied"
        : s.application_status === "application_failed"
          ? "application_failed"
          : s.application_status === "reverted"
            ? "rolled_back"
            : s.approval_status === "approved"
              ? "approved"
              : "proposed";
  const verification: VerificationState = (
    {
      not_tested: "not_tested",
      test_pending: "running",
      verified_for_tested_scenario: "passed",
      failed_verification: "failed",
      verification_inconclusive: "inconclusive",
    } as const
  )[s.verification_status];
  return { lifecycle, verification };
}

// ---------------------------------------------------------------------------------------------------------------
// API bodies / responses
// ---------------------------------------------------------------------------------------------------------------

/**
 * POST /api/findings/:id/safeguards/proposals. Uses ai& when available (author "ai"), otherwise deterministic
 * templates (author "template", clearly labeled). Creates one safeguard per proposed mechanism (typically a
 * claude_md_instruction plus a permission_rule / regression_test where relevant). Idempotent on client_request_id.
 */
export const SafeguardProposalBody = z.object({
  investigation_id: InvestigationId.optional(),
  workspace_id: WorkspaceId.optional(),
  client_request_id: ClientRequestId,
});
export type SafeguardProposalBody = z.infer<typeof SafeguardProposalBody>;

export const SafeguardFindingRef = z.object({ id: FindingId, title: z.string(), severity: Severity, run_id: RunId, is_fixture: z.boolean() });
export type SafeguardFindingRef = z.infer<typeof SafeguardFindingRef>;

export const SafeguardDetailResponse = z.object({
  /** v1 row (legacy statuses kept in sync). */
  safeguard: SafeguardEntity,
  lifecycle_status: SafeguardLifecycleStatus,
  verification_status: VerificationState,
  finding: SafeguardFindingRef,
  /** Null only for v1/fixture safeguards that predate versioning. */
  current_version: SafeguardVersion.nullable(),
  /** Ordered by version asc. */
  versions: z.array(SafeguardVersion),
  /** Ordered by `at` asc. */
  history: z.array(SafeguardEvent),
  mechanism: MechanismInfo,
  workspace: Workspace.nullable(),
  /** For workspace_file targets: current_version vs the file as it is NOW (regenerated per request). Null otherwise. */
  diff_preview: FileDiffPreview.nullable(),
  /** Ordered by applied_at asc. */
  file_changes: z.array(WorkspaceFileChange),
  /** Ordered by started_at desc. */
  verification_runs: z.array(VerificationRunV2),
  /** Lifecycle targets reachable now (UI decides which buttons to show). */
  allowed_transitions: z.array(SafeguardLifecycleStatus),
});
export type SafeguardDetailResponse = z.infer<typeof SafeguardDetailResponse>;

export const SafeguardProposalResponse = z.object({
  items: z.array(SafeguardDetailResponse),
  /** How the proposal was produced. ai.status mirrors the inference result ("ok" | "unavailable" | ...). */
  generation: z.object({
    author: z.enum(["ai", "template"]),
    ai_status: z.string(),
    detail: z.string(),
  }),
  replayed: z.boolean(),
  /**
   * FR9-01 gate: false when the source finding is not (yet) confirmed by a reviewer (new / under_review). Proposing is
   * still allowed for those (they have related evidence); dismissed findings and findings with no related events or
   * evidence are rejected with a 4xx. Optional for older clients/records.
   */
  finding_confirmed: z.boolean().optional(),
  /** Human-readable warnings about the proposal's basis (e.g. the finding is not confirmed). */
  warnings: z.array(z.string()).optional(),
});
export type SafeguardProposalResponse = z.infer<typeof SafeguardProposalResponse>;

export const SafeguardVersionBody = z.object({
  content: z.string().trim().min(1).max(8000),
  note: z.string().trim().max(2000).nullable().optional(),
});
export type SafeguardVersionBody = z.infer<typeof SafeguardVersionBody>;

export const SafeguardRejectBody = z.object({ note: z.string().trim().min(1).max(2000) });
export type SafeguardRejectBody = z.infer<typeof SafeguardRejectBody>;

/**
 * Explicit approval. confirm must be literally true. For workspace_file targets, expected_before_sha256 is the
 * before_sha256 of the diff the user reviewed (null = "file did not exist"); a mismatch with the file on disk returns
 * 409 file_conflict with details FileConflictDetails and writes nothing.
 */
export const SafeguardApproveBody = z.object({
  version_id: SafeguardVersionId,
  workspace_id: WorkspaceId.nullable().optional(),
  expected_before_sha256: Sha256Hex.nullable(),
  confirm: z.literal(true),
});
export type SafeguardApproveBody = z.infer<typeof SafeguardApproveBody>;

export const SafeguardRollbackBody = z.object({ change_id: WorkspaceFileChangeId });
export type SafeguardRollbackBody = z.infer<typeof SafeguardRollbackBody>;

/** `error.details` of a 409 file_conflict. */
export const FileConflictDetails = z.object({
  expected_before_sha256: Sha256Hex.nullable(),
  current_sha256: Sha256Hex.nullable(),
  /** Regenerated against the current file; the user must review it and approve again with its before_sha256. */
  diff_preview: FileDiffPreview,
});
export type FileConflictDetails = z.infer<typeof FileConflictDetails>;

export const SafeguardMutationResponse = z.object({
  detail: SafeguardDetailResponse,
  /** The file change written by approve / reverted by rollback, when there is one. */
  change: WorkspaceFileChange.nullable(),
});
export type SafeguardMutationResponse = z.infer<typeof SafeguardMutationResponse>;

export const SafeguardPatchQuery = z.object({ version_id: SafeguardVersionId.optional() });
export type SafeguardPatchQuery = z.infer<typeof SafeguardPatchQuery>;

export const MechanismsResponse = z.object({ items: z.array(MechanismInfo) });
export type MechanismsResponse = z.infer<typeof MechanismsResponse>;
