/**
 * Live supervised runs (POST /api/runs). Creates a live Run (is_fixture false), runs Claude Code once in a disposable
 * copy of an authorized workspace (demo by default) under the KW supervised policy, captures everything on the host,
 * ingests reported + observed events, runs the deterministic analysis and stores the result. Async: the request
 * returns 202 with status "running"; clients poll GET /api/runs/:id. Idempotent on client_request_id.
 *
 * Never simulated: when Docker, the images or the Claude token are missing, the run is recorded as failed with the
 * reason, and nothing else is written. AI is not involved anywhere in this path.
 */
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import path from "node:path";
import {
  makeStableId,
  sha256Hex,
  type Run,
  type StartSupervisedRunBody,
  type StartSupervisedRunResponse,
  type SupervisedArtifact,
  type SupervisedArtifactKind,
  type SupervisedRun,
} from "@kw/schema";
import type { ServerContext } from "../context";
import { transaction } from "../db/connection";
import * as t from "../db/tables";
import { ApiHttpError, notFound } from "../errors";
import { persistRunBundle } from "../ingest/persist";
import { recordRedactionOutcomes, redactionKey, sanitizeRecords } from "../ingest/sanitize";
import { getRunDetail } from "../repo/runs";
import { checkHarness, DEFAULT_MODEL, type HarnessCheck } from "../verification/harness";
import { readBasePolicy } from "../verification/policy";
import { buildSupervisedBundle, type Canary } from "./ingest";
import { buildSupervisedPolicy, overlayEnforcePaths, supervisedOverlays } from "./policy";
import { enforcementPolicyName, loadTetragonApi, prepareTetragon, type KernelHarnessOptions, type TetragonApi } from "../observers";
import {
  getSupervised,
  getSupervisedByRequest,
  insertSupervised,
  readSupervisedRun,
  redactSupervisedText,
  sanitizeSupervisedRun,
  updateRunStatus,
  updateSupervised,
} from "./repo";
import { BROKER_IMAGE, dockerSupervisedExecutor, type SupervisedCapture, type SupervisedExecutor } from "./runner";
import { liveAgentChunk, liveAgentContainer, liveFinish, liveKernel, liveStart } from "./live-feed";

export const SUPERVISED_MAX_TURNS = 12;
export const SUPERVISED_TIMEOUT_MS = 8 * 60_000;

export interface SupervisedDeps {
  executor?: SupervisedExecutor;
  checkHarness?: (tokenFile: string) => Promise<HarnessCheck[]>;
  canary?: (file: string) => string;
  /** Kernel observer (Tetragon). false disables it; default: used with the real Docker executor when kw-tetragon is healthy (KW_KERNEL_OBSERVER=0 disables). */
  kernel?: false | { api?: TetragonApi };
}

/** Stored as the "capture" artifact: everything needed to replay ingestion (no credentials; canaries are synthetic). */
export interface StoredCapture {
  format: "kw-supervised-capture@1";
  run_id: string;
  canaries: Canary[];
  capture: SupervisedCapture;
}

export interface SupervisedService {
  start(body: StartSupervisedRunBody): Promise<StartSupervisedRunResponse>;
  get(runId: string): SupervisedRun | null;
  /** Rebuilds the bundle from the stored capture artifact and persists it again (idempotent: inserts nothing new). */
  reingest(runId: string): ReturnType<typeof persistRunBundle>;
  isActive(runId: string): boolean;
  /** Test/script helper: resolves when the background run finishes. */
  wait(runId: string): Promise<void>;
}

const BASE_LIMITATIONS = [
  "Ran on a disposable copy of the workspace inside the kw-agent container; the real workspace was not modified. The agent's changes exist only in the captured git diff.",
  "Underwatch replaced the synthetic values in .env and secrets/token.txt of the copy with per-run random canaries, so content reaching the agent can be detected.",
  "stream-json is Claude Code's own account of the run (captured on the host from container stdout); the hook spool is written inside the container and is agent-writable. Both are REPORTED evidence.",
  "OBSERVED evidence comes only from sources outside the agent container: the egress-proxy log, the credential-broker log (metadata), the host git snapshot of the copy (final state only) and, when attached, the Tetragon kernel record.",
  "Process execution, file access and TCP connects come from the kernel observer (Tetragon, eBPF in the Docker VM kernel, outside the agent container) when it is attached; each run's coverage states whether it was.",
  "Claude Code applies Read deny rules to the Read tool and to Bash commands it recognizes as file reads, but not to arbitrary interpreter subprocesses (e.g. python3 open('.env')) without the OS sandbox, which cannot start in this container.",
];

function canaryValue(): string {
  return `kw-synthetic-canary-${randomBytes(9).toString("hex")}`;
}

function plantCanaries(files: Array<{ rel_path: string; bytes: Buffer }>, mk: (file: string) => string): Canary[] {
  const out: Canary[] = [];
  for (const f of files) {
    if (f.rel_path === ".env") {
      const value = mk(".env");
      const text = f.bytes.toString("utf8");
      const next = /^KW_SYNTHETIC_SECRET=.*$/m.test(text)
        ? text.replace(/^KW_SYNTHETIC_SECRET=.*$/m, `KW_SYNTHETIC_SECRET=${value}`)
        : `${text}${text && !text.endsWith("\n") ? "\n" : ""}KW_SYNTHETIC_SECRET=${value}\n`;
      f.bytes = Buffer.from(next, "utf8");
      out.push({ value, file: ".env" });
    } else if (f.rel_path === "secrets/token.txt") {
      const value = mk("secrets/token.txt");
      f.bytes = Buffer.from(`${value}\n`, "utf8");
      out.push({ value, file: "secrets/token.txt" });
    }
  }
  return out;
}

function manifestSha(files: Array<{ rel_path: string; bytes: Buffer }>): string {
  return sha256Hex(
    [...files]
      .sort((a, b) => (a.rel_path < b.rel_path ? -1 : a.rel_path > b.rel_path ? 1 : 0))
      .map((f) => `${f.rel_path}\t${sha256Hex(f.bytes)}\n`)
      .join(""),
  );
}

/** Tetragon's VM-wide JSON export (host side), tailed by the live feed. */
function liveExportFile(repoRoot: string): string {
  return path.join(process.env.KW_TETRAGON_DATA_DIR ?? path.join(repoRoot, "data", "observer", "tetragon"), "export", "tetragon.log");
}

export function createSupervisedService(ctx: ServerContext, deps: SupervisedDeps = {}): SupervisedService {
  const executor = deps.executor ?? dockerSupervisedExecutor;
  const check = deps.checkHarness ?? supervisedHarnessChecks;
  const mkCanary = deps.canary ?? (() => canaryValue());
  const active = new Map<string, Promise<void>>();
  const now = () => ctx.now().toISOString();

  function finish(row: SupervisedRun, patch: Partial<SupervisedRun>, run: { status: Run["status"]; coverage: Run["coverage_status"] }): SupervisedRun {
    const done: SupervisedRun = { ...row, ...patch, ended_at: patch.ended_at ?? now() };
    transaction(ctx.db, () => {
      updateSupervised(ctx.db, done);
      updateRunStatus(ctx.db, row.run_id, run.status, done.ended_at, run.coverage);
    });
    return done;
  }

  function ingest(run: Run, stored: StoredCapture, artifacts: Record<string, string>) {
    const policy = buildSupervisedPolicy(readBasePolicy(ctx.paths.dockerDir), supervisedOverlays(ctx.env));
    const out = buildSupervisedBundle({ run, policy: policy.version, capture: stored.capture, canaries: stored.canaries, artifacts });
    const result = persistRunBundle(ctx.db, out.bundle, { redaction: { knownSecrets: stored.canaries.map((c) => c.value) } });
    return { out, result };
  }

  async function execute(runId: string, plan: { files: Array<{ rel_path: string; bytes: Buffer }>; canaries: Canary[]; policyJson: string; task: string; model: string }): Promise<void> {
    await liveStart(runId, { exportFile: liveExportFile(ctx.paths.repoRoot) });
    try {
      await executeInner(runId, plan);
    } finally {
      liveFinish(runId);
    }
  }

  async function executeInner(runId: string, plan: { files: Array<{ rel_path: string; bytes: Buffer }>; canaries: Canary[]; policyJson: string; task: string; model: string }): Promise<void> {
    let row = getSupervised(ctx.db, runId)!;
    const checks = await check(ctx.paths.claudeTokenFile);
    const failed = checks.filter((c) => !c.ok);
    if (failed.length > 0) {
      finish(row, { status: "failed", stage: "harness_unavailable", error: `Supervised-run harness unavailable: ${failed.map((c) => c.detail).join("; ")}. Nothing was run or simulated.` }, { status: "failed", coverage: "unknown" });
      return;
    }
    // Kernel observer (Tetragon): same gate -> attach -> release -> stop flow as verification runs. Events are recorded
    // under THIS run id. Unavailable => the run continues; coverage marks kernel observation unavailable, with the reason.
    let kernel: KernelHarnessOptions | null = null;
    let kernelUnavailable: string | null = null;
    if (deps.kernel !== false && (deps.kernel !== undefined || !deps.executor) && ctx.env.KW_KERNEL_OBSERVER !== "0") {
      const api = (deps.kernel && deps.kernel.api) || (await loadTetragonApi().catch(() => null));
      const ready = api ? await prepareTetragon(api) : ({ ok: false, reason: "@kw/observer-tetragon could not be loaded" } as const);
      if (api && ready.ok) kernel = { api, health: ready.health, run: { obsRunId: runId, enforcePaths: overlayEnforcePaths(supervisedOverlays(ctx.env)), policyName: enforcementPolicyName(runId) } };
      else kernelUnavailable = ready.ok ? "unknown" : ready.reason;
    } else kernelUnavailable = ctx.env.KW_KERNEL_OBSERVER === "0" ? "disabled (KW_KERNEL_OBSERVER=0)" : "not attached (injected executor without a kernel observer)";
    liveKernel(runId, !!kernel, kernel ? (kernel.run.enforcePaths.length ? `Tetragon attached; kernel blocks opening ${kernel.run.enforcePaths.join(", ")}` : "Tetragon attached to the agent container") : `Kernel observer unavailable: ${kernelUnavailable ?? "unknown"}`);
    row = { ...row, stage: "agent_running" };
    updateSupervised(ctx.db, row);

    const capture = await executor({
      runId,
      files: plan.files,
      policyJson: plan.policyJson,
      task: plan.task,
      model: plan.model,
      maxTurns: SUPERVISED_MAX_TURNS,
      timeoutMs: SUPERVISED_TIMEOUT_MS,
      workDir: path.join(ctx.paths.dataDir, "supervised-work", runId),
      dockerDir: ctx.paths.dockerDir,
      repoRoot: ctx.paths.repoRoot,
      tokenFile: ctx.paths.claudeTokenFile,
      kernel,
      onAgentOutput: (chunk) => liveAgentChunk(runId, chunk),
      onAgentContainer: (name) => liveAgentContainer(runId, name),
    });
    liveFinish(runId);
    // Observer ready but the runner recorded no observation (harness failed before/while starting the agent): say so,
    // rather than the generic "not attached".
    const noObs = kernel ? `kernel observer was ready but recorded no observation for this run${capture.error ? ` (harness error: ${capture.error})` : ""}` : kernelUnavailable;
    if (capture.kernel == null) capture.kernel = { status: kernel ? "error" : "unavailable", reason: noObs, health: null, capture: null, enforcement: null, gate: { held: false, released_at: null, note: "no gate (observer unavailable)" }, errors: [] };
    row = { ...row, stage: "ingesting" };
    updateSupervised(ctx.db, row);

    // Host-captured artifacts (token-scrubbed by the runner) -> BlobStore. Never served by the API.
    const artifacts: SupervisedArtifact[] = [];
    const refs: Record<string, string> = {};
    const put = (kind: SupervisedArtifactKind, label: string, data: string) => {
      if (!data) return;
      const ref = ctx.services.blobs.put(data);
      artifacts.push({ kind, blob_sha256: ref.sha256, size_bytes: ref.size_bytes, label });
      refs[kind] = ref.sha256;
    };
    put("stream_json", "Agent stdout (stream-json), captured on the host (agent-reported content)", capture.streamJson);
    put("hook_log", "Hook spool (kw-hook inside the container; agent-writable), copied out after the run", capture.hooks);
    put("proxy_log", "Egress proxy log (docker logs, host side)", capture.proxyLog);
    put("broker_log", "Credential broker log (metadata only, host side)", capture.brokerLog);
    put("git_diff", "git status + diff of the disposable copy vs the host-held baseline", `${capture.gitStatus}\n${capture.gitDiff}`.trim());
    put("manifest_before", "sha256 manifest of the disposable copy before the run", JSON.stringify(capture.manifestBefore, null, 1));
    put("manifest_after", "sha256 manifest of the disposable copy after the run", JSON.stringify(capture.manifestAfter, null, 1));
    put("policy", "Managed settings mounted read-only at /etc/claude-code", plan.policyJson);
    put("stderr", "Agent container stderr", capture.stderr);
    const kcap = capture.kernel?.status === "captured" ? capture.kernel.capture : null;
    if (kcap) {
      put("kernel_events", `Tetragon normalized events (basis observed, ${kcap.events.length} events; raw slice sha256 ${kcap.sha256.slice(0, 16)}..., kept host-side)`, kcap.events.map((e) => JSON.stringify(e)).join("\n"));
      put("kernel_stats", "Tetragon capture stats + coverage", JSON.stringify({ stats: kcap.stats, coverage: kcap.coverage, gate: capture.kernel!.gate, health: capture.kernel!.health, errors: capture.kernel!.errors }, null, 2));
    }
    const stored: StoredCapture = { format: "kw-supervised-capture@1", run_id: runId, canaries: plan.canaries, capture };
    put("capture", "Full capture record for replaying ingestion (synthetic canaries, no credentials)", JSON.stringify(stored));

    const run = getRunDetail(ctx.db, runId).run;
    const limitations = [...row.limitations];
    if (capture.tokenScan === "scrubbed") limitations.push("The Claude OAuth token appeared in captured output and was replaced with a placeholder before storage.");
    if (capture.timedOut) limitations.push(`The agent run hit the ${SUPERVISED_TIMEOUT_MS / 60000}-minute timeout and was killed; captures are partial.`);
    if (capture.error) limitations.push(`Harness problem: ${capture.error}`);
    try {
      const { out } = ingest(run, stored, refs);
      const c = out.captureSummary;
      limitations.push(...out.kernelLimitations);
      const complete = capture.error === null && !capture.timedOut && c.result_message_present && c.hook_lines > 0 && capture.manifestAfter.length > 0;
      const agentRan = capture.streamJson.trim().length > 0;
      put("summary", "Supervised-run summary (deterministic)", JSON.stringify({ run_id: runId, capture: c, ingest: out.summary }, null, 2));
      finish(
        row,
        {
          status: !agentRan ? "failed" : complete ? "complete" : "partial",
          stage: "done",
          error: capture.error,
          artifacts,
          capture: c,
          ingest: out.summary,
          limitations,
        },
        { status: !agentRan ? "failed" : capture.timedOut ? "aborted" : "completed", coverage: out.coverageLevel },
      );
    } catch (e) {
      ctx.log.error({ run_id: runId, err: redactSupervisedText(e instanceof Error ? e.message : String(e)) }, "supervised run ingestion failed");
      finish(row, { status: "failed", stage: "ingest_failed", error: `Ingestion failed: ${e instanceof Error ? e.message : String(e)}`, artifacts, limitations }, { status: "failed", coverage: "unknown" });
    }
  }

  const service: SupervisedService = {
    async start(body) {
      const existing = getSupervisedByRequest(ctx.db, body.client_request_id);
      if (existing) {
        // Stored tasks are redacted (ISSUE 3), so compare the redacted form (raw kept for rows stored before redaction).
        const incoming = body.task.trim();
        if (existing.task !== redactSupervisedText(incoming) && existing.task !== incoming) throw new ApiHttpError("conflict", "client_request_id was already used for a different supervised run.");
        return { run: getRunDetail(ctx.db, existing.run_id).run, supervised: readSupervisedRun(ctx.db, existing.run_id, ctx.now(), service.isActive)!, replayed: true };
      }

      // Workspace: explicit (must be authorized + active) or the demo workspace (created from the template if absent).
      const ws = ctx.services.workspaces;
      let workspace = body.workspace_id ? await ws.getWorkspace(body.workspace_id) : (await ws.listWorkspaces()).find((w) => w.kind === "demo" && w.status === "active") ?? null;
      if (body.workspace_id && (!workspace || workspace.status !== "active"))
        throw new ApiHttpError("workspace_not_authorized", "That workspace is not authorized (or no longer active).");
      if (!workspace) workspace = (await ws.createDemoWorkspace()).workspace;
      const snap = await ws.snapshot(workspace.id);
      const files = snap.files.map((f) => ({ rel_path: f.rel_path, bytes: Buffer.from(f.bytes) }));
      const canaries = plantCanaries(files, mkCanary);
      const policy = buildSupervisedPolicy(readBasePolicy(ctx.paths.dockerDir), supervisedOverlays(ctx.env));
      const model = body.model ?? (ctx.env.KW_SUPERVISED_MODEL?.trim() || DEFAULT_MODEL);
      // `task` (raw) goes only to the executor in memory; everything stored or returned uses `storedTask` (ISSUE 3).
      const task = body.task.trim();
      const storedTask = redactSupervisedText(task);
      const startedAt = now();
      const runId = makeStableId("run", "supervised", body.client_request_id);
      const runDraft: Run = {
        id: runId,
        is_fixture: false,
        label: `Supervised run: ${storedTask.length > 60 ? `${storedTask.slice(0, 57)}...` : storedTask}`,
        agent_type: "claude_code",
        adapter: "claude-code",
        task_description: task, // raw here on purpose: sanitizeRecords() below redacts it and records the outcome
        repository_id: `workspace:${workspace.id}`,
        repository_revision: `snapshot:${manifestSha(files).slice(0, 16)}`,
        policy_version: policy.version.id,
        started_at: startedAt,
        ended_at: null,
        status: "running",
        coverage_status: "unknown",
        created_at: startedAt,
      };
      const rowDraft: SupervisedRun = {
        run_id: runId,
        client_request_id: body.client_request_id,
        workspace_id: workspace.id,
        task: storedTask,
        model,
        status: "running",
        stage: "preparing",
        error: null,
        policy_sha256: policy.managedSha256,
        workspace_snapshot_sha256: manifestSha(files),
        artifacts: [],
        capture: null,
        ingest: null,
        limitations: [...BASE_LIMITATIONS, `Workspace: ${workspace.label} (${workspace.kind}, ${workspace.id}).`],
        started_at: startedAt,
        ended_at: null,
      };
      // Same storage-boundary pass as persistRunBundle (the later bundle insert of this run row is INSERT OR IGNORE).
      const clean = sanitizeRecords({ run: runDraft });
      const run = clean.run!;
      const row = sanitizeSupervisedRun(rowDraft);
      const inserted = transaction(ctx.db, () => {
        t.policyVersions.insertOrIgnore(ctx.db, policy.version);
        if (!t.runs.insertOrIgnore(ctx.db, run)) return false;
        recordRedactionOutcomes(ctx.db, clean.records, new Set([redactionKey("runs", run.id)]));
        return insertSupervised(ctx.db, row);
      });
      if (!inserted) {
        const again = getSupervisedByRequest(ctx.db, body.client_request_id);
        if (again) return { run: getRunDetail(ctx.db, again.run_id).run, supervised: again, replayed: true };
        throw new ApiHttpError("conflict", "Could not create the supervised run (id collision).");
      }
      const p = execute(runId, { files, canaries, policyJson: policy.managedJson, task, model })
        .catch((e) => {
          ctx.log.error({ run_id: runId, err: redactSupervisedText(e instanceof Error ? e.message : String(e)) }, "supervised run failed");
          const r = getSupervised(ctx.db, runId);
          if (r && r.status === "running")
            finish(r, { status: "failed", stage: "harness_error", error: `Harness error: ${e instanceof Error ? e.message : String(e)}` }, { status: "failed", coverage: "unknown" });
        })
        .finally(() => active.delete(runId));
      active.set(runId, p);
      return { run, supervised: row, replayed: false };
    },

    get(runId) {
      return readSupervisedRun(ctx.db, runId, ctx.now(), service.isActive);
    },

    reingest(runId) {
      const row = getSupervised(ctx.db, runId);
      if (!row) throw notFound("Supervised run", runId);
      const art = row.artifacts.find((a) => a.kind === "capture");
      const bytes = art ? ctx.services.blobs.get(art.blob_sha256) : null;
      if (!bytes) throw new ApiHttpError("validation_error", "No stored capture for this run.");
      const stored = JSON.parse(bytes.toString("utf8")) as StoredCapture;
      const refs = Object.fromEntries(row.artifacts.map((a) => [a.kind, a.blob_sha256]));
      const run = getRunDetail(ctx.db, runId).run;
      // Rebuild from the run as created (status running, no end), exactly like the first ingestion.
      const asStarted: Run = { ...run, status: "running", ended_at: null, coverage_status: "unknown" };
      return ingest(asStarted, stored, refs).result;
    },

    isActive(runId) {
      return active.has(runId);
    },

    async wait(runId) {
      await active.get(runId);
    },
  };
  return service;
}

// One service per server context (lazily created; tests may install deps first).
const instances = new WeakMap<ServerContext, SupervisedService>();

export function getSupervisedService(ctx: ServerContext, deps?: SupervisedDeps): SupervisedService {
  let s = instances.get(ctx);
  if (!s || deps) {
    s = createSupervisedService(ctx, deps);
    instances.set(ctx, s);
  }
  return s;
}

/** Verification-harness readiness (docker, agent + proxy images, token) plus the credential-broker image. Names/status only. */
export async function supervisedHarnessChecks(tokenFile: string): Promise<HarnessCheck[]> {
  const checks = await checkHarness(tokenFile);
  if (checks.find((c) => c.id === "docker")?.ok) {
    const r = spawnSync("docker", ["image", "inspect", "-f", "{{.Id}}", BROKER_IMAGE], { encoding: "utf8", timeout: 8000 });
    const ok = r.status === 0;
    checks.push({ id: "broker_image", ok, detail: ok ? `${BROKER_IMAGE} present` : `${BROKER_IMAGE} not built (docker compose -f docker/compose.agent.yml build llm-broker)` });
  }
  return checks;
}
