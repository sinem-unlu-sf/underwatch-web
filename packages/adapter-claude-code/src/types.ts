import type { RedactOptions } from "@kw/redaction";
import type { CollectionStatus, Event, EventType, Evidence } from "@kw/schema";

/** Physical channel a record came from. Each channel is agent-reported (basis "reported"). */
export type Channel = "hook_log" | "stream_json" | "transcript";

export const CHANNEL_CUSTODY: Record<Channel, string> = {
  hook_log:
    "Hook log written by kw-hook inside the agent container; the agent can write to it, so it is not authoritative.",
  stream_json:
    "stream-json read from the agent process's stdout by the host; custody is outside the container, but the content is still Claude Code's own account.",
  transcript: "Session transcript written by Claude Code inside the agent container; agent-writable.",
};

/**
 * Event types this adapter emits that the shared schema's EventType lacks (PROPOSED SCHEMA ADDITIONS).
 * `raw_record` carries an unrecognized record, preserved instead of dropped.
 */
export const LOCAL_EVENT_TYPES = [
  "instructions_loaded",
  "config_change",
  "agent_lifecycle",
  "hook_execution",
  "raw_record",
] as const;
export type LocalEventType = (typeof LOCAL_EVENT_TYPES)[number];
export type ReportedEventType = EventType | LocalEventType;

/** `unparsed` is a PROPOSED SCHEMA ADDITION to CollectionStatus: the record was kept but not understood. */
export type ReportedCollectionStatus = CollectionStatus | "unparsed";

export type ToolPhase = "requested" | "resolved";

export type TimestampBasis =
  /** The record's own timestamp field (agent clock, ordering hint). */
  | "record"
  /** kw-hook's received_at (agent-container clock when the hook ran). */
  | "hook_received_at"
  /** Record has no timestamp; taken from the nearest timestamped record in the same channel. */
  | "neighbor_record"
  /** No timestamp anywhere; ParseContext.fallback_timestamp (e.g. run start). */
  | "run_fallback";

export interface RecordRef {
  channel: Channel;
  /** 1-based line number within the channel's file. */
  line: number;
  /** "<label>#L<n>" */
  locator: string;
  record_kind: string;
  evidence_id: string;
}

/**
 * How Claude Code resolved the permission check for one tool call.
 *  allowed                     permission_decision.decision = "accept"
 *  hook_deny                   a PreToolUse hook denied (permission_decision.source = "hook")
 *  permission_rule_deny        a deny rule matched (source "config", non_execution_kind "permission-rule")
 *  approval_unavailable_deny   the call needed approval and nobody could give it in -p mode
 *                              (source "config", non_execution_kind "user-rejected")
 *  auto_mode_deny              auto-mode classifier denial (PermissionDenied hook; doc-sourced, UNVERIFIED in captures)
 *  unknown_deny                Claude Code reports a denial but not why
 *  unknown                     no permission information captured
 */
export type PermissionKind =
  | "allowed"
  | "hook_deny"
  | "permission_rule_deny"
  | "approval_unavailable_deny"
  | "auto_mode_deny"
  | "unknown_deny"
  | "unknown";

export interface PermissionInfo {
  kind: PermissionKind;
  decision: "allowed" | "denied" | "unknown";
  /**
   * What the kind rests on:
   *  permission_metadata  stream tool_result_meta[].permission_decision or transcript permissionDecision
   *                       (fields observed in 2.1.302 captures, NOT documented: UNVERIFIED as a stable API)
   *  hook_payload         PermissionDenied hook payload
   *  error_text           tool_result error text only
   *  denial_list_only     only listed in result.permission_denials / system permission_denied
   *  inferred_from_result no permission record; "allowed" is inferred from a success result or a
   *                       PostToolUseFailure hook (both mean the tool ran)
   *  none                 nothing captured
   */
  evidence: "permission_metadata" | "hook_payload" | "error_text" | "denial_list_only" | "inferred_from_result" | "none";
  /** Raw values as reported by Claude Code. */
  cc_decision: string | null;
  cc_source: string | null;
  cc_reason_type: string | null;
  cc_non_execution_kind: string | null;
  listed_in_result_permission_denials: boolean;
  stream_permission_denied_message: boolean;
  permission_request_hook_fired: boolean;
  reason_text: string | null;
}

export interface ReportedDetail {
  channel: Channel;
  record_kind: string;
  session_id: string | null;
  phase: ToolPhase | null;
  /** Channel-independent key of the logical action, e.g. "tool_use:<id>:requested" (domain-schema design). */
  logical_key: string | null;
  timestamp_basis: TimestampBasis;
  /** Other records that describe the same logical event (other channels, other hook events). */
  corroborating: RecordRef[];
  /** Claude Code hook events seen for this tool_use_id, in record order. */
  hook_events: string[];
  permission: PermissionInfo | null;
  agent_id: string | null;
  parent_tool_use_id: string | null;
  is_error: boolean | null;
  /** Error text reported to the agent (redacted with ParseContext.redact when given). */
  error_text: string | null;
  duration_ms: number | null;
  /** Prompt / assistant / final-report text (redacted with ParseContext.redact when given). */
  text: string | null;
  /** Disagreements between channels, e.g. hook tool_input differs from the model's tool_use input. */
  conflicts: string[];
  extra: Record<string, unknown>;
}

/**
 * A normalized agent-reported event. Same fields as the shared schema Event, except that event_type and
 * collection_status are widened (see LOCAL_EVENT_TYPES, ReportedCollectionStatus) and adapter detail is
 * attached. Use toSchemaEvents() to get schema-valid Events.
 */
export interface ReportedEvent extends Omit<Event, "event_type" | "collection_status"> {
  event_type: ReportedEventType;
  collection_status: ReportedCollectionStatus;
  detail: ReportedDetail;
}

export type RecordDisposition =
  /** Primary record of a normalized event. */
  | "event"
  /** Attached to an event as corroboration. */
  | "corroboration"
  /** Recognized housekeeping record (API request bookkeeping, hook start/stop markers, ...). Kept as evidence, no timeline event. */
  | "metadata"
  /** Not understood. Preserved as a raw_record event with collection_status "unparsed". */
  | "unparsed";

export interface ParsedRecord {
  evidence_id: string;
  channel: Channel;
  line: number;
  locator: string;
  record_kind: string;
  session_id: string | null;
  disposition: RecordDisposition;
  reason: string | null;
  event_ids: string[];
}

export interface ChannelInput {
  text: string;
  /** Label used in evidence locators, e.g. "hooks.ndjson". */
  label?: string;
}

export interface RunOutputs {
  hookLog?: string | ChannelInput | null;
  /** The session transcript, or several (main + subagent transcripts from agent_transcript_path). Labels must differ. */
  transcript?: string | ChannelInput | null | Array<ChannelInput>;
  streamJson?: string | ChannelInput | null;
}

/** What the captured records say about whether the agent-side record set is complete (PRD FR-11). */
export interface Completeness {
  /** stream-json result message present (absent on SIGKILL/OOM/crash or when stream-json was not captured). */
  result_message_present: boolean;
  session_end_hook_present: boolean;
  /** Tool calls with no result record in any channel. */
  tool_calls_without_result: string[];
  /** Tool calls seen only in the hook log or only in conversation records, when both channels were supplied. */
  tool_calls_missing_from_hook_log: string[];
  unparsed_records: number;
  /**
   * True when a result message and a SessionEnd hook are present, every tool call has a result and nothing
   * is unparsed. tool_calls_missing_from_hook_log is NOT part of it: Claude Code fires no hooks for
   * validation-stage rejections (hooks.md; capture run1). Says nothing about independently observed activity.
   */
  agent_record_complete: boolean;
}

export interface ParseContext {
  run_id: string;
  /** Used only when no record in any channel carries a timestamp (marked timestamp_basis "run_fallback"). */
  fallback_timestamp: string;
  is_fixture?: boolean;
  /**
   * Every free-text field the adapter copies out of records (targets, summaries, prompt/assistant/error text,
   * detail.extra / permission fields) is ALWAYS redacted with the @kw/redaction default redactor (fail closed:
   * "[REDACTION_FAILED]" replaces a field whose redaction throws). Omitting options cannot disable it.
   * `redact` is an optional EXTRA redactor run before the built-in one (it can only add redaction).
   * Evidence excerpts are left null; their redaction_status stays "not_scanned".
   */
  redact?: (text: string) => string;
  /** Options for the built-in redactor (known secrets, operator patterns from redactionOptionsFromEnv). */
  redaction?: RedactOptions;
  /**
   * DANGEROUS. "unsafe_raw_for_restricted_blob_store" disables ALL redaction. Only for producing content destined for
   * the access-restricted raw evidence blob store; such output must never be persisted to the database, projected to
   * the graph, sent to AI, or returned by the API.
   */
  rawMode?: "unsafe_raw_for_restricted_blob_store";
}

export interface ParseResult {
  events: ReportedEvent[];
  evidence: Evidence[];
  records: ParsedRecord[];
  session_ids: string[];
  warnings: string[];
  completeness: Completeness;
  stats: Record<Channel, { lines: number; events: number; corroboration: number; metadata: number; unparsed: number }>;
}
