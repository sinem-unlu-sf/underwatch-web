import { z } from "zod";
import {
  ActorType,
  AgentType,
  CategoryCoverageStatus,
  CollectionStatus,
  Confidence,
  CorrelationMatch,
  CoverageCategory,
  CoverageLevel,
  EventBasis,
  EventSource,
  EventType,
  EvidenceSourceType,
  FindingCategory,
  FindingStatus,
  Outcome,
  PolicyRuleEffect,
  RedactionStatus,
  RunStatus,
  SafeguardApplicationStatus,
  SafeguardApprovalStatus,
  SafeguardType,
  SafeguardVerificationStatus,
  Severity,
  VerificationResult,
  VerificationRunStatus,
} from "./enums";
import { idPattern } from "./ids";
import { ReportedTaskClaim, SecurityOutcome, TaskOutcome } from "./outcomes";

/** ISO-8601 timestamp, UTC "Z" or explicit offset. */
export const Timestamp = z.iso.datetime({ offset: true });
export type Timestamp = z.infer<typeof Timestamp>;

export const RunId = z.string().regex(idPattern("run"));
export const PolicyVersionId = z.string().regex(idPattern("policy_version"));
export const EventId = z.string().regex(idPattern("event"));
export const EvidenceId = z.string().regex(idPattern("evidence"));
export const FindingId = z.string().regex(idPattern("finding"));
export const FindingStatusChangeId = z.string().regex(idPattern("finding_status_change"));
export const SafeguardId = z.string().regex(idPattern("safeguard"));
export const VerificationRunId = z.string().regex(idPattern("verification_run"));
export const CorrelationId = z.string().regex(idPattern("correlation"));

/** true when the record came from a hand-authored fixture file; false for anything captured live. */
const isFixture = z.boolean();

export const PolicyRule = z.object({
  id: z.string().min(1),
  effect: PolicyRuleEffect,
  /** Action class the rule governs, e.g. "file_read", "network_connect", "Bash". Free text: matched by the policy engine, not the UI. */
  action: z.string().min(1),
  /** Resource pattern, e.g. "**\/.env", "api.example.com:443". */
  resource_pattern: z.string().min(1),
  description: z.string(),
});
export type PolicyRule = z.infer<typeof PolicyRule>;

/** Immutable snapshot of the policy in effect for a run. Later policy edits create a new version; runs keep theirs. */
export const PolicyVersion = z.object({
  id: PolicyVersionId,
  is_fixture: isFixture,
  /** Logical policy identifier shared by all versions of the same policy. */
  policy_id: z.string().min(1),
  version: z.string().min(1),
  name: z.string().min(1),
  description: z.string(),
  /** Where the policy was loaded from, e.g. ".claude/settings.json" or "kw-policy.yaml". */
  source_reference: z.string().nullable(),
  content_sha256: z.string().regex(/^[0-9a-f]{64}$/).nullable(),
  rules: z.array(PolicyRule),
  created_at: Timestamp,
});
export type PolicyVersion = z.infer<typeof PolicyVersion>;

export const Run = z.object({
  id: RunId,
  is_fixture: isFixture,
  label: z.string().nullable(),
  agent_type: AgentType,
  /** Adapter implementation name, e.g. "claude-code". Null if the run was not created through an adapter. */
  adapter: z.string().nullable(),
  task_description: z.string(),
  repository_id: z.string().nullable(),
  repository_revision: z.string().nullable(),
  policy_version: PolicyVersionId.nullable(),
  started_at: Timestamp,
  ended_at: Timestamp.nullable(),
  status: RunStatus,
  coverage_status: CoverageLevel,
  created_at: Timestamp,
});
export type Run = z.infer<typeof Run>;

/**
 * A normalized event. Every nullable field is null either because it does not apply or because the source could not
 * provide it; the latter case MUST also be listed by name in `unavailable_fields`. Never fill a field with a guess.
 */
export const Event = z.object({
  id: EventId,
  run_id: RunId,
  is_fixture: isFixture,
  basis: EventBasis,
  source: EventSource,
  /** Stable key native to the source; input to makeEventId. */
  source_native_key: z.string().min(1),
  /** Ordering hint within a source when timestamps tie. */
  source_sequence: z.number().int().nonnegative().nullable(),
  event_type: EventType,
  timestamp: Timestamp,
  process_id: z.number().int().nonnegative().nullable(),
  parent_process_id: z.number().int().nonnegative().nullable(),
  process_name: z.string().nullable(),
  tool_name: z.string().nullable(),
  tool_use_id: z.string().nullable(),
  target_resource: z.string().nullable(),
  outcome: Outcome,
  evidence_id: EvidenceId.nullable(),
  attribution_confidence: Confidence.nullable(),
  collection_status: CollectionStatus,
  unavailable_fields: z.array(z.string()),
  /** What this event does NOT establish, e.g. "file open does not prove contents were read". */
  limitations: z.array(z.string()),
  /** Normalized one-line description shown in timelines. */
  summary: z.string(),
  /** Short redacted summary of the raw source record. Full raw content lives in Evidence. */
  raw_summary: z.string().nullable(),
});
export type Event = z.infer<typeof Event>;

export const IntegrityMetadata = z.object({
  algorithm: z.literal("sha256"),
  /** Hash of the raw evidence bytes at capture time. Null when not computed (e.g. fixtures, or source exposed no raw bytes). */
  sha256: z.string().regex(/^[0-9a-f]{64}$/).nullable(),
  size_bytes: z.number().int().nonnegative().nullable(),
  captured_by: z.string().nullable(),
  note: z.string().nullable(),
});
export type IntegrityMetadata = z.infer<typeof IntegrityMetadata>;

export const Evidence = z.object({
  id: EvidenceId,
  run_id: RunId,
  is_fixture: isFixture,
  source_type: EvidenceSourceType,
  /** Locator for the raw record, e.g. "transcript.jsonl#L42", "strace.log@offset=1832". Not necessarily resolvable from the UI. */
  source_reference: z.string().min(1),
  timestamp: Timestamp,
  integrity_metadata: IntegrityMetadata,
  redaction_status: RedactionStatus,
  /** Redacted excerpt safe to display. Null if withheld or not captured. */
  excerpt: z.string().nullable(),
});
export type Evidence = z.infer<typeof Evidence>;

export const Finding = z.object({
  id: FindingId,
  run_id: RunId,
  is_fixture: isFixture,
  category: FindingCategory,
  title: z.string().min(1),
  /** Why it was flagged. */
  description: z.string(),
  severity: Severity,
  confidence: Confidence,
  status: FindingStatus,
  policy_id: PolicyVersionId.nullable(),
  policy_rule_id: z.string().nullable(),
  recommended_next_step: z.string(),
  /** Explicit gaps in evidence that limit the conclusion. */
  missing_information: z.array(z.string()),
  related_event_ids: z.array(EventId),
  evidence_ids: z.array(EvidenceId),
  /** Set when this finding looks like a recurrence of an earlier one (potential regression). */
  recurrence_of_finding_id: FindingId.nullable(),
  created_at: Timestamp,
  updated_at: Timestamp,
});
export type Finding = z.infer<typeof Finding>;

/** Append-only history row. The creation row has from = null. */
export const FindingStatusChange = z.object({
  id: FindingStatusChangeId,
  finding_id: FindingId,
  is_fixture: isFixture,
  from: FindingStatus.nullable(),
  to: FindingStatus,
  actor_type: ActorType,
  actor: z.string().min(1),
  note: z.string().nullable(),
  at: Timestamp,
});
export type FindingStatusChange = z.infer<typeof FindingStatusChange>;

/** Pairing produced by correlation between a reported and an observed event (basis is always "derived"). */
export const EventCorrelation = z.object({
  id: CorrelationId,
  run_id: RunId,
  is_fixture: isFixture,
  reported_event_id: EventId.nullable(),
  observed_event_id: EventId.nullable(),
  match: CorrelationMatch,
  confidence: Confidence,
  note: z.string().nullable(),
});
export type EventCorrelation = z.infer<typeof EventCorrelation>;

export const Safeguard = z.object({
  id: SafeguardId,
  finding_id: FindingId,
  is_fixture: isFixture,
  type: SafeguardType,
  title: z.string().min(1),
  /** The exact instruction / configuration / test source that would be applied. */
  content: z.string(),
  /** How it is applied, e.g. "append to CLAUDE.md", "permissions.deny in .claude/settings.json". */
  application_mechanism: z.string(),
  target_path: z.string().nullable(),
  intended_effect: z.string(),
  legitimate_workflow_impact: z.string(),
  approval_status: SafeguardApprovalStatus,
  application_status: SafeguardApplicationStatus,
  verification_status: SafeguardVerificationStatus,
  created_at: Timestamp,
  approved_at: Timestamp.nullable(),
  approved_by: z.string().nullable(),
  applied_at: Timestamp.nullable(),
  last_verification_run_id: VerificationRunId.nullable(),
});
export type Safeguard = z.infer<typeof Safeguard>;

export const VerificationRun = z.object({
  id: VerificationRunId,
  safeguard_id: SafeguardId,
  finding_id: FindingId,
  is_fixture: isFixture,
  scenario_id: z.string().min(1),
  scenario_description: z.string(),
  environment_id: z.string().min(1),
  /** The supervised run executed for this verification, if one was recorded. */
  run_id: RunId.nullable(),
  status: VerificationRunStatus,
  result: VerificationResult.nullable(),
  /** Tri-state: null means not established by evidence. */
  prohibited_behavior_attempted: z.boolean().nullable(),
  prohibited_behavior_blocked: z.boolean().nullable(),
  legitimate_behavior_worked: z.boolean().nullable(),
  observed_event_ids: z.array(EventId),
  evidence_ids: z.array(EvidenceId),
  notes: z.string().nullable(),
  started_at: Timestamp,
  ended_at: Timestamp.nullable(),
  /**
   * Issue 4: two SEPARATE, independently evidenced outcomes (see outcomes.ts). Optional so historical records and
   * fixtures stay valid; when absent, readers derive them with outcomesForRun() (legacy -> security "inferred", task
   * always "unknown"). The legacy single-value fields above (result, prohibited_behavior_*, legitimate_behavior_worked)
   * are kept unchanged and are never reinterpreted as a verified task outcome.
   */
  security_outcome: SecurityOutcome.optional(),
  task_outcome: TaskOutcome.optional(),
  /** The agent's own completion claim (basis "reported"); never sets task_outcome. */
  reported_task_claim: ReportedTaskClaim.nullable().optional(),
});
export type VerificationRun = z.infer<typeof VerificationRun>;

export const CoverageSourceEntry = z.object({
  source: EventSource,
  active: z.boolean(),
  categories: z.array(CoverageCategory),
  attribution_available: z.boolean(),
  errors: z.array(z.string()),
});
export type CoverageSourceEntry = z.infer<typeof CoverageSourceEntry>;

export const CoverageCategoryEntry = z.object({
  category: CoverageCategory,
  status: CategoryCoverageStatus,
  note: z.string().nullable(),
});
export type CoverageCategoryEntry = z.infer<typeof CoverageCategoryEntry>;

/** Per-run observation coverage (PRD FR-11). A run without a report is treated as coverage "unknown". */
export const CoverageReport = z.object({
  run_id: RunId,
  is_fixture: isFixture,
  level: CoverageLevel,
  sources: z.array(CoverageSourceEntry),
  categories: z.array(CoverageCategoryEntry),
  unsupported_capabilities: z.array(z.string()),
  network_outcomes_observable: z.boolean(),
  final_state_complete: z.boolean(),
  generated_at: Timestamp,
});
export type CoverageReport = z.infer<typeof CoverageReport>;
