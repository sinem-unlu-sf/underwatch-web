/**
 * Per-run Tetragon orchestration for a disposable agent container (verification runs; any runner that can create the
 * container before starting it). Follows the @kw/observer-tetragon README "paused start":
 *
 *   docker create (agent entrypoint held behind a gate) -> attach(backfill:false) -> docker start -a
 *   -> [kernel_enforcement only] applyEnforcement scoped to THIS container's pid namespace
 *   -> release the gate (docker exec touch /tmp/.kw-go) -> agent runs -> exit
 *   -> removeEnforcement (always, finally) -> capture.stop() (slice + sha256 + normalized events + coverage)
 *
 * Residual gap (stated in every result): the gate shell (`sh -c 'until [ -e /tmp/.kw-go ]...'`) and the
 * `docker exec touch` run in the container before the agent starts; they are harness processes, not agent
 * processes, and are labeled as such. The agent itself (claude) does not exec until the gate opens, so no agent
 * activity happens before attach() or before the enforcement policy is loaded.
 */
import type { CaptureResult, ApplyEnforcementResult, TetragonHealth } from "@kw/observer-tetragon";

export const GATE_FILE = "/tmp/.kw-go";
/** Holds the image's own entrypoint until the host releases the gate (max ~120 s, then exits 70). */
export const GATE_ENTRYPOINT_ARGS = [
  "--entrypoint",
  "/bin/sh",
] as const;
export const GATE_COMMAND = ["-c", `i=0; while [ ! -e ${GATE_FILE} ]; do i=$((i+1)); [ $i -gt 1200 ] && exit 70; sleep 0.1; done; exec /usr/local/bin/kw-agent-entrypoint`] as const;

export interface TetragonApi {
  ensureTetragon(): Promise<TetragonHealth>;
  loadObservationPolicies(): Promise<Array<{ name: string; ok?: boolean; enabled?: boolean; error?: string | null }>>;
  attach(o: { runId: string; containerId: string; backfill: boolean }): Promise<{ stop(o?: { settleMs?: number }): Promise<CaptureResult> }>;
  applyEnforcement(o: { scopeContainerId: string; paths: string[]; policyName: string }): Promise<ApplyEnforcementResult>;
  removeEnforcement(name: string): Promise<{ removed: boolean; stillLoaded: boolean }>;
}

export async function loadTetragonApi(): Promise<TetragonApi> {
  const m = await import("@kw/observer-tetragon");
  return {
    ensureTetragon: () => m.ensureTetragon(),
    loadObservationPolicies: async () => (await m.loadObservationPolicies()) as unknown as Array<{ name: string }>,
    attach: (o) => m.attach(o),
    applyEnforcement: (o) => m.applyEnforcement(o),
    removeEnforcement: (n) => m.removeEnforcement(n),
  };
}

export interface KernelRunOptions {
  /** run_ id that the Tetragon events are recorded under (a Run row is created for it at ingestion). */
  obsRunId: string;
  /** Non-empty => apply a kernel_enforcement deny-file-open policy scoped to the agent container. */
  enforcePaths: string[];
  policyName: string;
}

export interface KernelEnforcementRecord {
  policy_name: string;
  policy_sha256: string | null;
  paths: string[];
  pidns_inode: string | null;
  yaml: string | null;
  loaded: boolean;
  applied_at: string | null;
  removed: boolean | null;
  still_loaded: boolean | null;
  error: string | null;
}

export interface KernelObservation {
  status: "captured" | "unavailable" | "error";
  reason: string | null;
  health: Pick<TetragonHealth, "tetragon_server_version" | "kernel_version" | "bpf_lsm_supported" | "override_return_supported" | "btf_present"> | null;
  capture: CaptureResult | null;
  enforcement: KernelEnforcementRecord | null;
  gate: { held: boolean; released_at: string | null; note: string };
  errors: string[];
}

export function unavailableObservation(reason: string): KernelObservation {
  return { status: "unavailable", reason, health: null, capture: null, enforcement: null, gate: { held: false, released_at: null, note: "no gate (observer unavailable)" }, errors: [] };
}

/** Startup / per-run readiness: ensure kw-tetragon runs and the observation policies are loaded. Never throws. */
export async function prepareTetragon(api: TetragonApi): Promise<{ ok: true; health: TetragonHealth } | { ok: false; reason: string }> {
  try {
    const h = await api.ensureTetragon();
    if (!h.tetragon_running || !h.tetragon_healthy) return { ok: false, reason: `Tetragon not healthy: ${h.errors.join("; ") || "unknown"}` };
    await api.loadObservationPolicies();
    return { ok: true, health: h };
  } catch (e) {
    return { ok: false, reason: `Tetragon unavailable: ${e instanceof Error ? e.message : String(e)}` };
  }
}

export interface ContainerControl {
  /** `docker start -a <name>`; resolves when the container exits. */
  startAttached(): Promise<unknown>;
  /** Resolves true once the container is running (pid namespace exists). */
  waitRunning(): Promise<boolean>;
  /** `docker exec <name> touch GATE_FILE`. */
  releaseGate(): Promise<boolean>;
  /** Kill the container (enforcement could not be applied). */
  kill(): Promise<void>;
}

/**
 * Runs one created-but-not-started agent container under Tetragon. Returns the container start result (whatever
 * `startAttached` resolved to; null if the container was killed before the agent ran) plus the observation.
 */
export async function runUnderTetragon<T>(
  api: TetragonApi,
  health: TetragonHealth,
  containerName: string,
  opts: KernelRunOptions,
  ctl: Omit<ContainerControl, "startAttached"> & { startAttached(): Promise<T> },
): Promise<{ result: T | null; observation: KernelObservation }> {
  const errors: string[] = [];
  const obs: KernelObservation = {
    status: "error",
    reason: null,
    health: {
      tetragon_server_version: health.tetragon_server_version,
      kernel_version: health.kernel_version,
      bpf_lsm_supported: health.bpf_lsm_supported,
      override_return_supported: health.override_return_supported,
      btf_present: health.btf_present,
    },
    capture: null,
    enforcement: null,
    gate: { held: true, released_at: null, note: "Agent entrypoint held behind a gate until attach() (and enforcement, if any) were in place; the gate shell and the release `docker exec touch` are harness processes in the same container." },
    errors,
  };
  let capture: Awaited<ReturnType<TetragonApi["attach"]>>;
  try {
    capture = await api.attach({ runId: opts.obsRunId, containerId: containerName, backfill: false });
  } catch (e) {
    obs.reason = `attach failed: ${e instanceof Error ? e.message : String(e)}`;
    return { result: null, observation: obs };
  }
  let result: T | null = null;
  try {
    const started = ctl.startAttached();
    if (!(await ctl.waitRunning())) {
      errors.push("agent container did not reach running state");
      result = await started;
    } else {
      let releaseOk = true;
      if (opts.enforcePaths.length > 0) {
        const rec: KernelEnforcementRecord = { policy_name: opts.policyName, policy_sha256: null, paths: opts.enforcePaths, pidns_inode: null, yaml: null, loaded: false, applied_at: null, removed: null, still_loaded: null, error: null };
        obs.enforcement = rec;
        try {
          const r = await api.applyEnforcement({ scopeContainerId: containerName, paths: opts.enforcePaths, policyName: opts.policyName });
          Object.assign(rec, { policy_sha256: r.policyHash, pidns_inode: r.pidnsInode, yaml: r.yaml, loaded: r.loaded, applied_at: new Date().toISOString() });
          if (!r.loaded) {
            rec.error = "policy did not report enabled after load";
            releaseOk = false;
          }
        } catch (e) {
          rec.error = e instanceof Error ? e.message : String(e);
          releaseOk = false;
        }
      }
      if (releaseOk) {
        releaseOk = await ctl.releaseGate();
        if (releaseOk) obs.gate.released_at = new Date().toISOString();
        else errors.push("could not release the start gate");
      }
      if (!releaseOk) {
        errors.push("agent was not started: enforcement or gate release failed; container killed");
        await ctl.kill();
        await started;
        result = null;
      } else {
        result = await started;
      }
    }
  } finally {
    // Always attempt removal once enforcement was requested: applyEnforcement may have loaded the policy and then
    // thrown (e.g. the post-load listing failed), leaving applied_at null. Deleting an absent policy is a no-op.
    if (obs.enforcement) {
      try {
        const r = await api.removeEnforcement(opts.policyName);
        obs.enforcement.removed = r.removed;
        obs.enforcement.still_loaded = r.stillLoaded;
        if (r.stillLoaded) errors.push(`enforcement policy ${opts.policyName} is still loaded after removal`);
      } catch (e) {
        obs.enforcement.removed = false;
        errors.push(`removeEnforcement failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    try {
      obs.capture = await capture.stop({ settleMs: 2000 });
      obs.status = "captured";
    } catch (e) {
      obs.reason = `capture.stop failed: ${e instanceof Error ? e.message : String(e)}`;
    }
  }
  if (obs.status === "captured" && obs.enforcement?.error) obs.reason = `enforcement not applied: ${obs.enforcement.error}`;
  return { result, observation: obs };
}
