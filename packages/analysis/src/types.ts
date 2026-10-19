import type {
  Confidence,
  CorrelationMatch,
  CoverageReport,
  Event,
  EventCorrelation,
  Finding,
  FindingCategory,
  PolicyVersion,
  Run,
  Severity,
} from "@kw/schema";
import type { AnalysisContext } from "./context";
import type { CanonicalPath } from "./paths";
import type { KwPolicy, PolicyClassification, PolicyDecisionRecord } from "./policy";

/**
 * PROPOSED SCHEMA ADDITION: per-event details that @kw/schema Event does not carry yet. Supplied out of band as
 * `details[event_id]`. Every field is optional; absent means "source did not provide it" and the engine degrades
 * (lower confidence, undetermined outcome) rather than guessing.
 */
export interface EventDetails {
  /** Observed execve argv (process_exec). */
  argv?: string[] | null;
  /** Process cwd at the time of the event (for relative paths). */
  cwd?: string | null;
  /** Symbolic errno when the syscall failed, e.g. "EACCES", "EPERM", "ENOENT". */
  errno?: string | null;
  /** Exit code (process_exit). Null when killed by a signal. */
  exit_code?: number | null;
  signal?: string | null;
  /** Access mode for file_open. */
  access_mode?: "read" | "write" | "read_write" | null;
  /** Kernel-resolved path (d_path) when the collector provides it. */
  resolved_path?: string | null;
  /** Underwatch enforcement rule id when this record is (or is paired with) a KW enforcement action. */
  enforcement_rule_id?: string | null;
  /** Process start time (ISO). Disambiguates pid reuse. */
  process_start_time?: string | null;
  /** Network destination host and port (network_connect / dns_query) when not encoded in target_resource. */
  host?: string | null;
  port?: number | null;
  /** Bytes sent upstream, if the proxy reports it. Never interpreted as "data exfiltrated". */
  bytes_up?: number | null;
  /** repo_change kind. */
  change_kind?: "added" | "modified" | "deleted" | "mode" | null;
  /** Claude Code subagent id carried by hook payloads. */
  agent_id?: string | null;
  /** agent_message: full message text when the collector supplies it (the schema summary may be cut off). Agent-authored; compared, never trusted. */
  message_text?: string | null;
}

export type PolicyInput = KwPolicy | PolicyVersion;

export interface AnalyzeRunInput {
  run: Run;
  events: Event[];
  policy: PolicyInput | null;
  coverage: CoverageReport | null;
  rulesetVersion?: string;
  context?: Partial<AnalysisContext>;
  details?: Record<string, EventDetails>;
  /**
   * Evidence records for the run (@kw/schema Evidence is compatible). Used only to read the full final-report text of
   * agent_message events from their evidence excerpt (hook payload last_assistant_message). Optional.
   */
  evidence?: ReadonlyArray<{ id: string; excerpt?: string | null }>;
}

/** Observed action kinds after aggregation. */
export type ActionKind =
  | "file.read"
  | "file.write"
  | "file.delete"
  | "proc.exec"
  | "proc.exit"
  | "net.connect"
  | "net.dns"
  | "fs.change"
  | "other";

export type OutcomeClass = "completed" | "blocked" | "failed" | "cannot_determine";
export type BlockedBy = "kw_enforcement" | "proxy" | "sandbox" | "environment" | "agent_layer";

export interface ObservedOutcome {
  value: OutcomeClass;
  /** e.g. "opened" (FR-2: an open does not prove contents were read), "written", "executed", "proxy_forwarded". */
  level: string | null;
  blockedBy: BlockedBy | null;
  errno: string | null;
  disputed: boolean;
  /** How the outcome was established; consumed only by the confidence rubric. */
  basis: "observed_return" | "observed_partial" | "none";
}

/** One observed action, possibly seen by several collectors (constituents are linked, never deleted). */
export interface LogicalObservation {
  id: string;
  kind: ActionKind;
  /** Lowest constituent event id. */
  representative: string;
  constituents: string[];
  sources: string[];
  t: number;
  pid: number | null;
  ppid: number | null;
  processName: string | null;
  argv: string[] | null;
  path: CanonicalPath | null;
  host: string | null;
  port: number | null;
  /** Command text for proc.exec (argv joined, else target_resource). */
  command: string | null;
  toolUseId: string | null;
  outcome: ObservedOutcome;
  evidenceIds: string[];
  attributionCaps: Confidence[];
  collectionPartial: boolean;
  limitations: string[];
}

export type ReportedOutcome = "success" | "error" | "denied" | "no_result";

export interface ReportedCall {
  toolUseId: string;
  toolName: string | null;
  target: string | null;
  path: CanonicalPath | null;
  host: string | null;
  eventIds: string[];
  sources: string[];
  start: number;
  end: number;
  openEnded: boolean;
  outcome: ReportedOutcome;
  outcomeEventIds: string[];
  agentId: string | null;
  evidenceIds: string[];
  conflicts: string[];
}

export type Scope = "tool_call" | "agent_runtime" | "kw_instrumentation" | "external" | "unattributed";
export type MatchState = "exact" | "probable" | "ambiguous" | "unmatched_observed" | "unmatched_reported";
export type AttributionMethod = "tool_use_id" | "process_ancestry" | "command_binding" | "resource_time" | "time_window" | "identity" | "none";

export interface Candidate {
  toolUseId: string;
  score: number;
  features: Record<string, number>;
}

export interface Attribution {
  observationId: string;
  scope: Scope;
  toolUseId: string | null;
  state: MatchState;
  method: AttributionMethod;
  score: number;
  candidates: Candidate[];
  /** Lineage of the observation's process reaches the agent root through observed edges. */
  lineageToAgent: boolean | null;
  /** Process chain (pids, child first) used for the attribution. */
  chain: number[];
  /** Direct child of the agent root that the observation descends from (its binding decides the attribution). */
  anchorPid: number | null;
  note: string | null;
}

/** Correlation output record. `schema_match` maps the five-state model onto @kw/schema CorrelationMatch. */
export interface CorrelationRecord {
  id: string;
  state: MatchState;
  schema_match: CorrelationMatch;
  confidence: Confidence;
  method: AttributionMethod;
  score: number;
  tool_use_id: string | null;
  tool_name: string | null;
  reported_event_ids: string[];
  observed_event_ids: string[];
  logical_observation_id: string | null;
  role: "primary_footprint" | "in_scope" | "unmatched";
  alternatives: Array<{ tool_use_id: string; score: number }>;
  reason: string | null;
}

export interface SuppressedEvent {
  event_id: string;
  logical_observation_id: string;
  rule_id: string;
  noise_class: string;
  noise_model_version: string;
  rationale: string;
}

export interface Diagnostic {
  code:
    | "duplicate_event_id"
    | "run_mismatch"
    | "invalid_timestamp"
    | "collector_disagreement"
    | "agent_record_conflict"
    | "basis_source_mismatch"
    | "invalid_detail"
    | "agent_root_unknown"
    | "external_process"
    | "unknown_tool_use_id"
    | "policy_rule_unrecognized"
    | "policy_missing"
    | "enforcement_gap"
    | "bash_exit_mismatch";
  message: string;
  event_ids: string[];
}

export interface AnalysisNote {
  code:
    | "unreported_read"
    | "sensitive_access_allowed"
    | "agent_record_unavailable"
    | "reported_action_not_corroborated"
    | "attribution_alternatives"
    | "change_mismatch_not_assessable"
    | "workspace_root_inferred"
    | "narrative_report_unavailable"
    | "narrative_claim_hedged"
    | "narrative_claim_consistent"
    | "narrative_claim_not_assessable";
  message: string;
  event_ids: string[];
}

export interface ConfidenceClaim {
  claim: "occurred" | "attributed" | "outcome" | "reported" | "policy_applies" | "correlation";
  grade: Confidence;
  reason: string;
}

export interface FindingAnnotation {
  finding_id: string;
  rule_id: string;
  secondary: Array<{ category: FindingCategory; rule_id: string }>;
  confidence_basis: ConfidenceClaim[];
  severity_basis: string;
  match_state: MatchState | null;
  policy_classification: PolicyClassification | null;
  cluster_key: string;
}

export interface UnprocessedEvent {
  event_id: string;
  reason: string;
}

export interface Accounting {
  input_events: number;
  observed_in_observations: number;
  reported_in_calls: number;
  reported_context: number;
  collector_status: number;
  unprocessed: number;
}

export interface AnalysisResult {
  analysisVersion: string;
  analysisId: string;
  engineVersion: string;
  rulesetVersion: string;
  noiseModelVersion: string;
  policyVersionId: string | null;
  correlations: CorrelationRecord[];
  /** Same correlations in @kw/schema EventCorrelation shape (one row per reported/observed pair). */
  schemaCorrelations: EventCorrelation[];
  findings: Finding[];
  annotations: FindingAnnotation[];
  suppressed: SuppressedEvent[];
  decisions: PolicyDecisionRecord[];
  observations: LogicalObservation[];
  reportedCalls: ReportedCall[];
  attributions: Attribution[];
  notes: AnalysisNote[];
  diagnostics: Diagnostic[];
  unprocessed: UnprocessedEvent[];
  accounting: Accounting;
}

export type { Severity, Confidence, FindingCategory };
