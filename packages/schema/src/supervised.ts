/**
 * Live supervised runs (POST /api/runs). One headless Claude Code run in a disposable copy of an authorized workspace,
 * inside the kw-agent container under the Underwatch supervised policy (managed settings, read-only). The host
 * captures stream-json, the hook spool, the egress-proxy and credential-broker logs, a pre/post git snapshot and (when
 * kw-tetragon is healthy) the Tetragon kernel record of the agent container; agent-REPORTED events come from the
 * Claude Code adapter parsers, OBSERVED events only from host-side / out-of-container sources.
 * Findings come from the deterministic @kw/analysis engine plus the host-side canary check (never from AI).
 */
import { z } from "zod";
import { ClientRequestId } from "./askwitness";
import { Run, RunId, Timestamp } from "./entities";
import { Sha256Hex, WorkspaceId } from "./workspaces";

/** running -> complete (agent finished, every capture present) | partial (abnormal end or a capture missing) | failed (nothing ran). */
export const SupervisedRunStatus = z.enum(["running", "complete", "partial", "failed"]);
export type SupervisedRunStatus = z.infer<typeof SupervisedRunStatus>;

export const SUPERVISED_RUN_STATUS_LABELS: Record<SupervisedRunStatus, string> = {
  running: "Running",
  complete: "Complete",
  partial: "Partial capture",
  failed: "Failed (agent did not run)",
};

export const SupervisedArtifactKind = z.enum([
  "stream_json",
  "hook_log",
  "proxy_log",
  "broker_log",
  "git_status",
  "git_diff",
  "manifest_before",
  "manifest_after",
  "policy",
  "stderr",
  "capture",
  "summary",
  /** Tetragon normalized events of the agent container (basis observed; the raw slice stays host-side). */
  "kernel_events",
  /** Tetragon capture stats, coverage fragment, start gate and observer health. */
  "kernel_stats",
  /** P11 per-run network guard + isolation self-test result (observed inside the agent container before the start gate opened). */
  "isolation_selftest",
]);
export type SupervisedArtifactKind = z.infer<typeof SupervisedArtifactKind>;

export const SupervisedArtifact = z.object({
  kind: SupervisedArtifactKind,
  blob_sha256: Sha256Hex,
  size_bytes: z.number().int().nonnegative(),
  label: z.string(),
});
export type SupervisedArtifact = z.infer<typeof SupervisedArtifact>;

/** What each capture channel produced. Counts only; no content. */
export const SupervisedCaptureSummary = z.object({
  stream_json_lines: z.number().int().nonnegative(),
  hook_lines: z.number().int().nonnegative(),
  proxy_connects: z.number().int().nonnegative(),
  proxy_refused: z.number().int().nonnegative(),
  broker_requests: z.number().int().nonnegative(),
  files_changed: z.array(z.string()),
  result_message_present: z.boolean(),
  exit_code: z.number().int().nullable(),
  timed_out: z.boolean(),
  claude_code_version: z.string().nullable(),
  model: z.string().nullable(),
  /** Canary planted in the disposable copy's .env appeared in agent-visible output. Null when not checked. */
  canary_exposed: z.boolean().nullable(),
});
export type SupervisedCaptureSummary = z.infer<typeof SupervisedCaptureSummary>;

export const SupervisedIngestSummary = z.object({
  reported_events: z.number().int().nonnegative(),
  observed_events: z.number().int().nonnegative(),
  derived_events: z.number().int().nonnegative(),
  /** Adapter records kept as evidence but not representable as schema events (e.g. instructions_loaded). */
  not_representable: z.number().int().nonnegative(),
  evidence: z.number().int().nonnegative(),
  findings: z.number().int().nonnegative(),
  correlations: z.number().int().nonnegative(),
  analysis_engine: z.string(),
  analysis_ruleset: z.string(),
  diagnostics: z.array(z.string()),
});
export type SupervisedIngestSummary = z.infer<typeof SupervisedIngestSummary>;

export const SupervisedRun = z.object({
  run_id: RunId,
  client_request_id: ClientRequestId,
  workspace_id: WorkspaceId.nullable(),
  task: z.string(),
  model: z.string(),
  status: SupervisedRunStatus,
  /** Current step while running (e.g. "preparing", "agent_running", "ingesting"); final step afterwards. */
  stage: z.string(),
  error: z.string().nullable(),
  policy_sha256: Sha256Hex.nullable(),
  workspace_snapshot_sha256: Sha256Hex.nullable(),
  artifacts: z.array(SupervisedArtifact),
  capture: SupervisedCaptureSummary.nullable(),
  ingest: SupervisedIngestSummary.nullable(),
  /** What this run's evidence can and cannot establish (coverage gaps, custody of each channel). */
  limitations: z.array(z.string()),
  started_at: Timestamp,
  ended_at: Timestamp.nullable(),
});
export type SupervisedRun = z.infer<typeof SupervisedRun>;

export const StartSupervisedRunBody = z.object({
  client_request_id: ClientRequestId,
  task: z.string().trim().min(3).max(4000),
  /** Defaults to the active demo workspace (created from the template if none exists). */
  workspace_id: WorkspaceId.optional(),
  model: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9._:\-[\]]{1,80}$/)
    .optional(),
});
export type StartSupervisedRunBody = z.infer<typeof StartSupervisedRunBody>;

export const StartSupervisedRunResponse = z.object({
  run: Run,
  supervised: SupervisedRun,
  replayed: z.boolean(),
});
export type StartSupervisedRunResponse = z.infer<typeof StartSupervisedRunResponse>;
