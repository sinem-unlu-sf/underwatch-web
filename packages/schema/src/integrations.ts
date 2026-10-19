/**
 * Interfaces for components that are PENDING ARCHITECTURE REVIEW. No implementations exist in the foundation.
 * They are here so the server can report honest "not_implemented" statuses and later implementations have a
 * fixed seam. Do not add stub implementations that return fabricated data.
 */
import type { ComponentStatus } from "./api";
import type { CoverageCategory } from "./enums";
import type { CoverageReport, Event, Evidence, Finding, Run, Safeguard, VerificationRun } from "./entities";

export interface CollectedBatch {
  events: Event[];
  evidence: Evidence[];
}

/** Agent-specific integration (initially Claude Code). Produces only basis "reported" events. */
export interface AgentAdapter {
  readonly id: string;
  status(): Promise<ComponentStatus>;
  /** Categories this adapter can genuinely report, used for coverage. */
  capabilities(): Promise<CoverageCategory[]>;
  startRun(input: { task_description: string; repository_path: string; policy_version_id: string }): Promise<Run>;
  collect(runId: string): Promise<CollectedBatch>;
}

/** Independent observer (eBPF, ptrace, file watcher, network proxy, git diff). Produces only basis "observed" events. */
export interface ObservationCollector {
  readonly id: string;
  status(): Promise<ComponentStatus>;
  capabilities(): Promise<CoverageCategory[]>;
  collect(runId: string): Promise<CollectedBatch & { coverage: Partial<CoverageReport> }>;
}

/** Projection of persisted records into the Neo4j evidence graph. */
export interface GraphProjector {
  status(): Promise<ComponentStatus>;
  projectRun(runId: string): Promise<{ nodes_merged: number; relationships_merged: number }>;
}

/** ai& Inference provider. Output must reference existing evidence IDs; it never changes finding status. */
export interface InferenceProvider {
  status(): Promise<ComponentStatus>;
  explainFinding(input: { finding: Finding; events: Event[]; evidence: Evidence[] }): Promise<{
    model: string;
    prompt_version: string;
    summary: string;
    cited_evidence_ids: string[];
    missing_evidence: string[];
    next_steps: string[];
  }>;
}

/** Applies an approved safeguard through a supported mechanism and runs controlled verification scenarios. */
export interface SafeguardExecutor {
  status(): Promise<ComponentStatus>;
  apply(safeguard: Safeguard): Promise<{ ok: boolean; detail: string }>;
  verify(safeguard: Safeguard, scenarioId: string): Promise<VerificationRun>;
}
