import type {
  CoverageReport,
  Event,
  EventCorrelation,
  Evidence,
  Finding,
  FindingStatusChange,
  PolicyVersion,
  Run,
  Safeguard,
  VerificationRun,
} from "@kw/schema";
import { TableCodec } from "./codec";

/** Finding columns stored on the findings table; the id arrays live in finding_events / finding_evidence. */
export type FindingRow = Omit<Finding, "related_event_ids" | "evidence_ids">;

export const policyVersions = new TableCodec<PolicyVersion>("policy_versions", ["id"], {
  id: "text",
  is_fixture: "bool",
  policy_id: "text",
  version: "text",
  name: "text",
  description: "text",
  source_reference: "text",
  content_sha256: "text",
  rules: "json",
  created_at: "text",
});

export const runs = new TableCodec<Run>("runs", ["id"], {
  id: "text",
  is_fixture: "bool",
  label: "text",
  agent_type: "text",
  adapter: "text",
  task_description: "text",
  repository_id: "text",
  repository_revision: "text",
  policy_version: "text",
  started_at: "text",
  ended_at: "text",
  status: "text",
  coverage_status: "text",
  created_at: "text",
});

export const evidence = new TableCodec<Evidence>("evidence", ["id"], {
  id: "text",
  run_id: "text",
  is_fixture: "bool",
  source_type: "text",
  source_reference: "text",
  timestamp: "text",
  integrity_metadata: "json",
  redaction_status: "text",
  excerpt: "text",
});

export const events = new TableCodec<Event>("events", ["id"], {
  id: "text",
  run_id: "text",
  is_fixture: "bool",
  basis: "text",
  source: "text",
  source_native_key: "text",
  source_sequence: "int",
  event_type: "text",
  timestamp: "text",
  process_id: "int",
  parent_process_id: "int",
  process_name: "text",
  tool_name: "text",
  tool_use_id: "text",
  target_resource: "text",
  outcome: "text",
  evidence_id: "text",
  attribution_confidence: "text",
  collection_status: "text",
  unavailable_fields: "json",
  limitations: "json",
  summary: "text",
  raw_summary: "text",
});

export const correlations = new TableCodec<EventCorrelation>("event_correlations", ["id"], {
  id: "text",
  run_id: "text",
  is_fixture: "bool",
  reported_event_id: "text",
  observed_event_id: "text",
  match: "text",
  confidence: "text",
  note: "text",
});

export const findings = new TableCodec<FindingRow>("findings", ["id"], {
  id: "text",
  run_id: "text",
  is_fixture: "bool",
  category: "text",
  title: "text",
  description: "text",
  severity: "text",
  confidence: "text",
  status: "text",
  policy_id: "text",
  policy_rule_id: "text",
  recommended_next_step: "text",
  missing_information: "json",
  recurrence_of_finding_id: "text",
  created_at: "text",
  updated_at: "text",
});

/** Fields of a finding that legitimately change after import (status workflow). */
export const FINDING_MUTABLE_FIELDS = ["status", "updated_at"] as const satisfies readonly (keyof FindingRow)[];

export const statusHistory = new TableCodec<FindingStatusChange>("finding_status_history", ["id"], {
  id: "text",
  finding_id: "text",
  is_fixture: "bool",
  from: { kind: "text", column: "from_status" },
  to: { kind: "text", column: "to_status" },
  actor_type: "text",
  actor: "text",
  note: "text",
  at: "text",
});

export const safeguards = new TableCodec<Safeguard>("safeguards", ["id"], {
  id: "text",
  finding_id: "text",
  is_fixture: "bool",
  type: "text",
  title: "text",
  content: "text",
  application_mechanism: "text",
  target_path: "text",
  intended_effect: "text",
  legitimate_workflow_impact: "text",
  approval_status: "text",
  application_status: "text",
  verification_status: "text",
  created_at: "text",
  approved_at: "text",
  approved_by: "text",
  applied_at: "text",
  last_verification_run_id: "text",
});

/**
 * v1 columns only. The issue-4 outcome columns (migration 080) are owned by verification/repo.ts; bundle rows written
 * here leave them NULL, and readers derive outcomes with outcomesForRun() (never a task success from legacy columns).
 */
export type VerificationRunV1Columns = Omit<VerificationRun, "security_outcome" | "task_outcome" | "reported_task_claim">;
export const verificationRuns = new TableCodec<VerificationRunV1Columns>("verification_runs", ["id"], {
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
});

export const coverageReports = new TableCodec<CoverageReport>("coverage_reports", ["run_id"], {
  run_id: "text",
  is_fixture: "bool",
  level: "text",
  sources: "json",
  categories: "json",
  unsupported_capabilities: "json",
  network_outcomes_observable: "bool",
  final_state_complete: "bool",
  generated_at: "text",
});

export interface FindingLink {
  finding_id: string;
  event_id: string;
  position: number;
}
export interface FindingEvidenceLink {
  finding_id: string;
  evidence_id: string;
  position: number;
}

export const findingEvents = new TableCodec<FindingLink>("finding_events", ["finding_id", "event_id"], {
  finding_id: "text",
  event_id: "text",
  position: "int",
});

export const findingEvidence = new TableCodec<FindingEvidenceLink>("finding_evidence", ["finding_id", "evidence_id"], {
  finding_id: "text",
  evidence_id: "text",
  position: "int",
});
