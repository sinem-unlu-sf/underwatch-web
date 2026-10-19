/**
 * Persists one Tetragon capture as an observed run: Run row (the disposable agent container's run), the slice
 * Evidence (sha256 of the raw per-run Tetragon slice), every normalized Event (basis "observed", source
 * "kernel_tracer", collector tetragon) and a CoverageReport that says exactly what was and was not observed.
 * Idempotent (INSERT OR IGNORE by stable ids): re-ingesting the same slice inserts nothing.
 */
import type { CoverageCategoryEntry, CoverageReport, CoverageSourceEntry, Event, PolicyVersion, Run } from "@kw/schema";
import type { CaptureResult } from "@kw/observer-tetragon";
import { transaction, type Db } from "../db/connection";
import * as t from "../db/tables";
import { recordRedactionOutcomes, redactionKey, sanitizeRecords } from "../ingest/sanitize";
import type { KernelObservation } from "./tetragon-run";

export interface IngestKernelInput {
  obsRunId: string;
  label: string;
  task: string;
  adapter: string;
  observation: KernelObservation;
  /** Extra host-side sources that captured this run (shown in coverage alongside the kernel tracer). */
  hostSources?: { streamJson: boolean; gitDiff: boolean; proxyLog: boolean };
  now: Date;
  /** Policy in force for this run (verification: base + scenario baseline + tested safeguard version). Stored and linked. */
  policyVersion?: PolicyVersion | null;
}

export interface IngestKernelResult {
  run_id: string;
  evidence_id: string;
  event_ids: string[];
  inserted_events: number;
  coverage: CoverageReport;
}

const base = (b: string | null) => (b ? b.split("/").pop() || b : "?");

/** Schema Event row from a normalized Tetragon event; the in-container lineage is appended to the summary. */
export function toEventRow(e: CaptureResult["events"][number]): Event {
  const chain = e.tetragon.ancestry.map((a) => base(a.binary));
  const lineage = chain.length ? ` [lineage: ${[base(e.tetragon.process.binary), ...chain].join(" <- ")}]` : "";
  const enf = e.tetragon.enforcement ? ` [policy ${e.tetragon.enforcement.policy_name} sha256:${e.tetragon.enforcement.policy_sha256.slice(0, 12)}]` : "";
  return {
    id: e.id,
    run_id: e.run_id,
    is_fixture: false,
    basis: e.basis,
    source: e.source,
    source_native_key: e.source_native_key,
    source_sequence: e.source_sequence,
    event_type: e.event_type,
    timestamp: e.timestamp,
    process_id: e.process_id,
    parent_process_id: e.parent_process_id,
    process_name: e.process_name,
    tool_name: e.tool_name,
    tool_use_id: e.tool_use_id,
    target_resource: e.target_resource,
    outcome: e.outcome,
    evidence_id: e.evidence_id,
    attribution_confidence: e.attribution_confidence,
    collection_status: e.collection_status,
    unavailable_fields: e.unavailable_fields,
    limitations: e.limitations,
    summary: `${e.summary}${enf}${lineage}`.slice(0, 2000),
    raw_summary: e.raw_summary,
  };
}

export function kernelCoverageReport(input: Pick<IngestKernelInput, "obsRunId" | "observation" | "hostSources" | "now">): CoverageReport {
  const cap = input.observation.capture;
  const frag = cap?.coverage.report;
  const sources: CoverageSourceEntry[] = [...(frag?.sources ?? [])];
  const categories: CoverageCategoryEntry[] = [...(frag?.categories ?? [])];
  const enf = input.observation.enforcement;
  if (sources[0] && input.observation.errors.length) sources[0] = { ...sources[0], errors: [...sources[0].errors, ...input.observation.errors] };
  const h = input.hostSources;
  if (h?.streamJson) {
    sources.push({ source: "claude_code_transcript", active: true, categories: ["tool_calls", "permission_decisions", "agent_reported_actions"], attribution_available: true, errors: [] });
    categories.push(
      { category: "tool_calls", status: "partial", note: "Claude Code stream-json captured on the host; produced inside the agent container (agent-side, basis reported)." },
      { category: "permission_decisions", status: "partial", note: "result.permission_denials from stream-json (agent-side record)." },
    );
  }
  if (h?.gitDiff) {
    sources.push({ source: "git_observer", active: true, categories: ["repository_changes"], attribution_available: false, errors: [] });
    categories.push({ category: "repository_changes", status: "observed", note: "Host-side git diff of the disposable workspace against a baseline the container never saw (no process attribution)." });
  }
  if (enf) {
    const i = categories.findIndex((c) => c.category === "permission_decisions");
    if (i !== -1) categories.splice(i, 1);
    categories.push({
      category: "permission_decisions",
      status: enf.loaded ? "observed" : "unavailable",
      note: (enf.loaded
        ? `Kernel enforcement policy ${enf.policy_name} (sha256 ${enf.policy_sha256 ?? "?"}) denied open() of ${enf.paths.join(", ")} in this container only; blocked opens are Tetragon process_lsm events. Removed after the run: ${enf.removed === true ? "yes" : enf.removed === false ? "NO" : "unknown"}.`
        : `Kernel enforcement was requested but not loaded: ${enf.error ?? "unknown"}.`) + (h?.streamJson ? " Claude Code permission_denials are also recorded from stream-json (agent-side)." : ""),
    });
  }
  return {
    run_id: input.obsRunId,
    is_fixture: false,
    level: cap ? "partial" : "minimal",
    sources,
    categories,
    unsupported_capabilities: [
      ...(frag?.unsupported_capabilities ?? ["Kernel observation unavailable for this run"]),
      "Content-read is not established (an open or a passed read() permission check does not prove which bytes were read)",
      "Bytes sent are not established (tcp_connect = attempt only; the egress proxy log shows hosts, never content)",
    ],
    network_outcomes_observable: false,
    final_state_complete: false,
    generated_at: input.now.toISOString(),
  };
}

export function ingestKernelObservation(db: Db, input: IngestKernelInput): IngestKernelResult | null {
  const cap = input.observation.capture;
  if (!cap) return null;
  const coverage = kernelCoverageReport(input);
  const run: Run = {
    id: input.obsRunId,
    is_fixture: false,
    label: input.label,
    agent_type: "claude_code",
    adapter: input.adapter,
    task_description: input.task,
    repository_id: null,
    repository_revision: null,
    policy_version: input.policyVersion?.id ?? null,
    started_at: cap.stats.started_at,
    ended_at: cap.stats.stopped_at,
    status: "completed",
    coverage_status: coverage.level,
    created_at: input.now.toISOString(),
  };
  // Secret redaction before any row is written (same fail-closed sanitizer as persistRunBundle; ISSUE 3).
  const safe = sanitizeRecords({ run, evidence: [cap.evidence], events: cap.events.map(toEventRow) });
  const rows = safe.events;
  let inserted = 0;
  transaction(db, () => {
    const written = new Set<string>();
    if (input.policyVersion) t.policyVersions.insertOrIgnore(db, input.policyVersion);
    if (t.runs.insertOrIgnore(db, safe.run!)) written.add(redactionKey("runs", run.id));
    if (t.evidence.insertOrIgnore(db, safe.evidence[0]!)) written.add(redactionKey("evidence", cap.evidence.id));
    for (const e of rows)
      if (t.events.insertOrIgnore(db, e)) {
        inserted++;
        written.add(redactionKey("events", e.id));
      }
    t.coverageReports.insertOrIgnore(db, coverage);
    recordRedactionOutcomes(db, safe.records, written);
  });
  return { run_id: run.id, evidence_id: cap.evidence.id, event_ids: rows.map((e) => e.id), inserted_events: inserted, coverage };
}
