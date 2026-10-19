import { z } from "zod";

/**
 * reported: emitted by or about the agent's own account of what it did (hooks, transcript, final message).
 * observed: captured by a collector independent of the agent's narrative.
 * derived:  produced by Underwatch analysis (correlation, policy evaluation). Never raw evidence.
 */
export const EventBasis = z.enum(["reported", "observed", "derived"]);
export type EventBasis = z.infer<typeof EventBasis>;

/**
 * Where an event came from. Agent-side sources carry basis "reported"; collector sources carry
 * basis "observed"; Underwatch analysis sources carry basis "derived" (see EVENT_SOURCE_BASIS).
 * Which of these are actually implemented is decided after architecture review.
 */
export const EventSource = z.enum([
  "claude_code_hooks",
  "claude_code_transcript",
  "claude_code_otel",
  "process_tracer",
  "kernel_tracer",
  "file_watcher",
  "network_proxy",
  "git_observer",
  "sandbox_runtime",
  "kw_correlator",
  "kw_policy_engine",
]);
export type EventSource = z.infer<typeof EventSource>;

export const EVENT_SOURCE_BASIS: Record<EventSource, EventBasis> = {
  claude_code_hooks: "reported",
  claude_code_transcript: "reported",
  claude_code_otel: "reported",
  process_tracer: "observed",
  kernel_tracer: "observed",
  file_watcher: "observed",
  network_proxy: "observed",
  git_observer: "observed",
  sandbox_runtime: "observed",
  kw_correlator: "derived",
  kw_policy_engine: "derived",
};

export const EVENT_SOURCE_LABELS: Record<EventSource, string> = {
  claude_code_hooks: "Claude Code hooks",
  claude_code_transcript: "Claude Code transcript",
  claude_code_otel: "Claude Code OpenTelemetry",
  process_tracer: "Process tracer (ptrace/strace)",
  kernel_tracer: "Kernel tracer (eBPF)",
  file_watcher: "File watcher (inotify/fanotify)",
  network_proxy: "Network egress proxy",
  git_observer: "Repository diff observer",
  sandbox_runtime: "Sandbox runtime",
  kw_correlator: "Underwatch correlator",
  kw_policy_engine: "Underwatch policy engine",
};

export const EventType = z.enum([
  "session_start",
  "session_end",
  "user_prompt",
  "tool_call",
  "tool_result",
  "permission_decision",
  "agent_message",
  "process_exec",
  "process_exit",
  "file_open",
  "file_read",
  "file_write",
  "file_create",
  "file_delete",
  "file_rename",
  "network_connect",
  "dns_query",
  "repo_change",
  "collector_status",
  "correlation",
  "policy_evaluation",
]);
export type EventType = z.infer<typeof EventType>;

/**
 * attempted: the action was initiated; completion is not established.
 * allowed / denied: a permission decision was made (by agent permissions or policy).
 * blocked: an enforcement mechanism prevented the action.
 * succeeded / failed: completion result is established by the source.
 * unknown: the source cannot establish an outcome.
 */
export const Outcome = z.enum([
  "attempted",
  "allowed",
  "denied",
  "blocked",
  "succeeded",
  "failed",
  "unknown",
]);
export type Outcome = z.infer<typeof Outcome>;

/** How completely a single event record was captured. Fields the source could not provide are null AND listed in `unavailable_fields`. */
export const CollectionStatus = z.enum(["complete", "partial", "error"]);
export type CollectionStatus = z.infer<typeof CollectionStatus>;

export const FindingCategory = z.enum([
  "unreported_observed_action",
  "outcome_mismatch",
  "change_mismatch",
  "permission_violation",
  "uncertain_correlation",
]);
export type FindingCategory = z.infer<typeof FindingCategory>;

export const FINDING_CATEGORY_LABELS: Record<FindingCategory, string> = {
  unreported_observed_action: "Unreported observed action",
  outcome_mismatch: "Outcome mismatch",
  change_mismatch: "Change mismatch",
  permission_violation: "Permission violation",
  uncertain_correlation: "Uncertain correlation",
};

export const FindingStatus = z.enum([
  "new",
  "under_review",
  "confirmed",
  "resolved",
  "dismissed",
  "unresolved",
]);
export type FindingStatus = z.infer<typeof FindingStatus>;

export const FINDING_STATUS_LABELS: Record<FindingStatus, string> = {
  new: "New",
  under_review: "Under review",
  confirmed: "Confirmed",
  resolved: "Resolved",
  dismissed: "Dismissed",
  unresolved: "Unresolved",
};

/** Statuses that still require a human decision. Used for "runs needing review". */
export const OPEN_FINDING_STATUSES = ["new", "under_review", "unresolved"] as const satisfies readonly FindingStatus[];

export const Severity = z.enum(["info", "low", "medium", "high", "critical"]);
export type Severity = z.infer<typeof Severity>;
export const SEVERITY_ORDER: Record<Severity, number> = { info: 0, low: 1, medium: 2, high: 3, critical: 4 };

export const Confidence = z.enum(["low", "medium", "high"]);
export type Confidence = z.infer<typeof Confidence>;

export const SafeguardType = z.enum([
  "claude_md_instruction",
  "permission_rule",
  "hook_policy",
  "regression_test",
  "kernel_enforcement",
]);
export type SafeguardType = z.infer<typeof SafeguardType>;

export const SAFEGUARD_TYPE_LABELS: Record<SafeguardType, string> = {
  claude_md_instruction: "CLAUDE.md instruction (influences behavior, not enforced)",
  permission_rule: "Claude Code permission rule (enforced by the agent runtime)",
  hook_policy: "Hook / policy check",
  regression_test: "Regression test (verifies a specific outcome)",
  kernel_enforcement: "Kernel enforcement (Tetragon deny-file-open in the disposable agent container)",
};

export const SafeguardApprovalStatus = z.enum(["proposed", "approved", "rejected"]);
export type SafeguardApprovalStatus = z.infer<typeof SafeguardApprovalStatus>;

export const SafeguardApplicationStatus = z.enum(["not_applied", "applied", "application_failed", "reverted"]);
export type SafeguardApplicationStatus = z.infer<typeof SafeguardApplicationStatus>;

export const SafeguardVerificationStatus = z.enum([
  "not_tested",
  "test_pending",
  "verified_for_tested_scenario",
  "failed_verification",
  "verification_inconclusive",
]);
export type SafeguardVerificationStatus = z.infer<typeof SafeguardVerificationStatus>;

export const VerificationRunStatus = z.enum(["pending", "running", "completed", "error"]);
export type VerificationRunStatus = z.infer<typeof VerificationRunStatus>;

/** Result of a completed verification run. Null while pending/running. */
export const VerificationResult = z.enum([
  "verified_for_tested_scenario",
  "failed_verification",
  "verification_inconclusive",
]);
export type VerificationResult = z.infer<typeof VerificationResult>;

export const RunStatus = z.enum(["pending", "running", "completed", "failed", "aborted"]);
export type RunStatus = z.infer<typeof RunStatus>;

export const AgentType = z.enum(["claude_code"]);
export type AgentType = z.infer<typeof AgentType>;

export const CoverageLevel = z.enum(["complete", "partial", "minimal", "unknown"]);
export type CoverageLevel = z.infer<typeof CoverageLevel>;

/** Event categories from PRD FR-2, used for coverage reporting. */
export const CoverageCategory = z.enum([
  "tool_calls",
  "process_execution",
  "file_access",
  "file_modification",
  "network",
  "permission_decisions",
  "agent_reported_actions",
  "repository_changes",
]);
export type CoverageCategory = z.infer<typeof CoverageCategory>;

export const CategoryCoverageStatus = z.enum(["observed", "partial", "unavailable"]);
export type CategoryCoverageStatus = z.infer<typeof CategoryCoverageStatus>;

export const EvidenceSourceType = z.enum([
  "hook_payload",
  "transcript_entry",
  "otel_record",
  "process_trace",
  "kernel_trace",
  "file_event_log",
  "file_snapshot",
  "network_log",
  "git_diff",
  "policy_document",
  "collector_log",
]);
export type EvidenceSourceType = z.infer<typeof EvidenceSourceType>;

export const RedactionStatus = z.enum(["not_scanned", "no_secrets_detected", "redacted", "withheld"]);
export type RedactionStatus = z.infer<typeof RedactionStatus>;

/** Who made a change. There is deliberately no "agent" actor: the supervised agent may never change findings or approve safeguards. */
export const ActorType = z.enum(["user", "system"]);
export type ActorType = z.infer<typeof ActorType>;

export const CorrelationMatch = z.enum(["matched", "reported_only", "observed_only", "uncertain"]);
export type CorrelationMatch = z.infer<typeof CorrelationMatch>;

export const PolicyRuleEffect = z.enum(["allow", "deny", "ask"]);
export type PolicyRuleEffect = z.infer<typeof PolicyRuleEffect>;

/**
 * Status of an integration/component on the settings page.
 * not_implemented: code does not exist yet (pending architecture review).
 * not_configured: code exists but required configuration is absent.
 */
export const IntegrationStatus = z.enum([
  "not_implemented",
  "not_configured",
  "configured",
  "connected",
  "degraded",
  "error",
  "disabled",
]);
export type IntegrationStatus = z.infer<typeof IntegrationStatus>;
