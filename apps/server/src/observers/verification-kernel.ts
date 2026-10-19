/**
 * Glue between a finished verification harness run and the kernel observer: ingest the Tetragon capture as an
 * observed run, store the normalized events / enforcement policy as artifacts, and summarize the restricted case.
 */
import { makeStableId, sha256Hex, type PolicyVersion, type VerificationArtifactKind } from "@kw/schema";
import type { ServerContext } from "../context";
import type { HarnessResult } from "../verification/harness";
import { ingestKernelObservation } from "./ingest";
import { summarizeKernelEvidence, type KernelRestrictedSummary } from "./kernel-evidence";

export interface KernelVerificationOutput {
  summary: KernelRestrictedSummary;
  evidenceId: string;
  relevantEventIds: string[];
  limitations: string[];
}

/**
 * PolicyVersion for one verification observation run (PRD §7.2 / FR1-08): the merged managed settings (by sha256) plus
 * the tested safeguard version and any Tetragon deny paths. Stable id by content, so identical policies share a row.
 * No KW analysis rules are evaluated on verification runs (rules: []); the verdict comes from the verification evaluator.
 */
export function verificationPolicyVersion(p: { managedSha256: string; safeguardId: string; versionId: string | null; type: string; enforcePaths: string[] }, now: Date): PolicyVersion {
  const content = JSON.stringify({
    managed_settings_sha256: p.managedSha256,
    tested_safeguard: { id: p.safeguardId, version_id: p.versionId, type: p.type },
    enforce_paths: [...p.enforcePaths].sort(),
  });
  const sha = sha256Hex(content);
  return {
    id: makeStableId("policy_version", "kw-verification", sha),
    is_fixture: false,
    policy_id: "kw-verification",
    version: `kw-verification@${sha.slice(0, 12)}`,
    name: "Underwatch verification run policy",
    description:
      `Policy for one safeguard verification run: Claude Code managed settings (base + scenario baseline${p.type === "permission_rule" ? " + the tested permission overlay" : ""}; sha256 ${p.managedSha256})` +
      (p.enforcePaths.length ? ` and a Tetragon deny-file-open policy for ${JSON.stringify([...p.enforcePaths].sort())} scoped to the run's agent container` : "") +
      `. Tested safeguard ${p.safeguardId}${p.versionId ? ` (version ${p.versionId})` : ""}, in isolation (other applied safeguards not added). No KW analysis rules are evaluated on verification runs.`,
    source_reference: `docker/agent/policy/managed-settings.json + apps/server/src/verification/policy.ts + safeguard ${p.safeguardId}`,
    content_sha256: sha,
    rules: [],
    created_at: now.toISOString(),
  };
}

export function recordKernelObservation(
  ctx: ServerContext,
  input: {
    runId: string;
    obsRunId: string;
    type: string;
    res: HarnessResult;
    task: string;
    put: (kind: VerificationArtifactKind, label: string, data: string) => string | null;
    /** Policy in force for the run; recorded as the observation run's policy_version when given. */
    policy?: { managedSha256: string; safeguardId: string; versionId: string | null; enforcePaths: string[] };
  },
): KernelVerificationOutput | null {
  const obs = input.res.kernel;
  if (!obs || obs.status !== "captured" || !obs.capture) return null;
  const cap = obs.capture;
  const ing = ingestKernelObservation(ctx.db, {
    obsRunId: input.obsRunId,
    label: `Verification ${input.runId}: disposable agent container (kernel-observed)`,
    task: input.task,
    adapter: "kw-verification-harness",
    observation: obs,
    hostSources: { streamJson: input.res.captures.streamJson.length > 0, gitDiff: true, proxyLog: input.res.captures.proxyLog.length > 0 },
    now: ctx.now(),
    policyVersion: input.policy ? verificationPolicyVersion({ ...input.policy, type: input.type }, ctx.now()) : null,
  });
  input.put(
    "summary",
    `Tetragon normalized events (basis observed, ${cap.events.length} events; raw slice sha256 ${cap.sha256.slice(0, 16)}...)`,
    cap.events.map((e) => JSON.stringify(e)).join("\n"),
  );
  input.put("summary", "Tetragon capture stats + coverage", JSON.stringify({ stats: cap.stats, coverage: cap.coverage, gate: obs.gate, health: obs.health, errors: obs.errors }, null, 2));
  if (obs.enforcement?.yaml) input.put("policy", `Kernel enforcement TracingPolicy ${obs.enforcement.policy_name} (sha256 ${obs.enforcement.policy_sha256 ?? "?"})`, obs.enforcement.yaml);

  const summary = summarizeKernelEvidence(cap.events, {
    enforcementPolicy: obs.enforcement?.loaded ? obs.enforcement.policy_name : null,
    enforcementSha256: obs.enforcement?.loaded ? obs.enforcement.policy_sha256 : null,
  });
  summary.lossy = cap.stats.lossy === true;
  const relevant = [...summary.opened, ...summary.read_checks, ...summary.blocked, ...summary.failed].map((t) => t.event_id);
  const s = cap.stats;
  const limitations = [
    `Kernel observer (Tetragon ${obs.health?.tetragon_server_version ?? "?"}, kernel ${obs.health?.kernel_version ?? "?"}): ${cap.events.length} observed events from the agent container (${Object.entries(s.by_type).map(([k, v]) => `${k} ${v}`).join(", ")}); raw slice sha256 ${cap.sha256}. Recorded as run ${input.obsRunId}.`,
    "Kernel observer establishes process exec/lineage, file opens and read()/write() permission checks on selected paths, and TCP connect attempts. It does NOT establish file content read, bytes sent, or mmap-only reads (only an open-time deny prevents those).",
    `Start gate: ${obs.gate.note}`,
    ...(obs.enforcement
      ? [
          obs.enforcement.loaded
            ? `Kernel enforcement ${obs.enforcement.policy_name} (sha256 ${obs.enforcement.policy_sha256}) was loaded before the agent started, scoped to pid namespace ${obs.enforcement.pidns_inode} only; removed after the run: ${obs.enforcement.removed === true ? "yes" : obs.enforcement.removed === false ? "NO" : "unknown"}.`
            : `Kernel enforcement requested but not loaded: ${obs.enforcement.error ?? "unknown"}.`,
        ]
      : []),
    ...(cap.stats.kernel_loss && Object.values(cap.stats.kernel_loss).some((v) => v > 0) ? [`Tetragon reported lost events (VM-wide counters): ${JSON.stringify(cap.stats.kernel_loss)}.`] : []),
    ...obs.errors.map((e) => `Kernel observer error: ${e}`),
  ];
  if (ing && ing.inserted_events === 0 && ing.event_ids.length > 0) limitations.push("Kernel events for this run were already stored (idempotent re-ingest).");
  return { summary, evidenceId: cap.evidence.id, relevantEventIds: relevant, limitations };
}
