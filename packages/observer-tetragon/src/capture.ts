import { open, mkdir, writeFile, readFile, stat, appendFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { makeStableId, type Evidence } from "@kw/schema";
import { TETRAGON_CONTAINER, observerPaths } from "./config";
import { inspectContainer, isolationViolations } from "./docker";
import { listLoadedPolicies } from "./lifecycle";
import { isLossy, lossDelta, lossSnapshot, type LossSnapshot } from "./metrics";
import { containerIdMatches, normalizeSlice, recordDocker, type NormalizeStats, type TetragonObservedEvent } from "./parser";
import { readEnforcementRegistry, sha256, type EnforcementRegistry } from "./policies";
import { coverageFragment, type TetragonCoverageFragment } from "./coverage";

export interface AttachOptions {
  runId: string;
  /** Container name or id (full or prefix). Must exist (created is enough: attach before `docker start`). */
  containerId: string;
  dataDir?: string;
  pollMs?: number;
  /** Also scan the export file from the beginning for this container's earlier events. Default true. */
  backfill?: boolean;
  /**
   * attach() refuses a container that can see/tamper with the observer (docker socket, --privileged, --pid=host,
   * a mount exposing data/observer, CAP_SYS_ADMIN/BPF/...). Set true to capture anyway; the violations are then
   * recorded as coverage errors and in the manifest.
   */
  allowIsolationViolations?: boolean;
}

export interface CaptureStats {
  run_id: string;
  container_id: string;
  container_name: string | null;
  started_at: string;
  stopped_at: string;
  export_lines_scanned: number;
  /** Lines of the export file that were not valid JSON (any container). */
  export_parse_errors: number;
  matched_records: number;
  /** Export file shrank/rotated during capture: events may be missing. */
  export_gaps: number;
  /** VM-wide Tetragon loss counters over the capture window; null when metrics were unreachable. */
  kernel_loss: Record<string, number> | null;
  /** true when any loss counter delta is non-zero (coverage categories are then downgraded and labeled LOSSY). */
  lossy: boolean;
  /** Reasons the container was not independent of the observer (empty = none detected at attach time). */
  isolation_violations: string[];
  /** kw-observe-* policies enabled at attach and at stop (coverage is claimed only for policies enabled at both). */
  observation_policies_at_attach: string[];
  observation_policies_at_stop: string[];
  normalize: NormalizeStats;
  by_type: Record<string, number>;
}

export interface CaptureResult {
  runId: string;
  sliceFile: string;
  sha256: string;
  sizeBytes: number;
  normalizedFile: string;
  stats: CaptureStats;
  coverage: TetragonCoverageFragment;
  evidence: Evidence;
  events: TetragonObservedEvent[];
}

export interface Capture {
  readonly runId: string;
  readonly containerId: string;
  readonly sliceFile: string;
  /** Records matched so far. */
  matched(): number;
  /** Wait settleMs for Tetragon to flush, drain, write sha256 + manifest + normalized events. */
  stop(opts?: { settleMs?: number }): Promise<CaptureResult>;
}

export function sliceEvidenceId(runId: string): string {
  return makeStableId("evidence", runId, "tetragon", "events.jsonl");
}

export async function attach(opts: AttachOptions): Promise<Capture> {
  const paths = observerPaths(opts);
  const info = await inspectContainer(opts.containerId);
  const containerId = info?.id ?? (/^[0-9a-f]{64}$/.test(opts.containerId) ? opts.containerId : null);
  if (!containerId) throw new Error(`cannot resolve container ${opts.containerId}; create it before attach()`);
  const isolation = info ? isolationViolations(info, paths.dataDir, TETRAGON_CONTAINER) : ["container could not be inspected; isolation not verified"];
  if (isolation.length && !opts.allowIsolationViolations) {
    throw new Error(`refusing to attach: container ${info?.name ?? containerId} is not isolated from the observer: ${isolation.join("; ")}`);
  }
  const enabledObservation = async () =>
    (await listLoadedPolicies()).filter((p) => p.enabled && p.name.startsWith("kw-observe-")).map((p) => p.name);
  const obsAtAttach = await enabledObservation().catch(() => [] as string[]);
  const runDir = paths.runDir(opts.runId);
  await mkdir(runDir, { recursive: true });
  const sliceFile = join(runDir, "events.jsonl");
  await writeFile(sliceFile, "");
  const needle = containerId.slice(0, 12);
  const startedAt = new Date().toISOString();
  const loss0: LossSnapshot = await lossSnapshot();

  let offset = 0;
  if (opts.backfill === false && existsSync(paths.exportFile)) offset = (await stat(paths.exportFile)).size;
  let partial = "";
  let scanned = 0;
  let parseErrors = 0;
  let matched = 0;
  let gaps = 0;
  let stopped = false;
  let busy: Promise<void> = Promise.resolve();

  const drainOnce = async () => {
    if (!existsSync(paths.exportFile)) return;
    const size = (await stat(paths.exportFile)).size;
    if (size < offset) {
      gaps++;
      offset = 0;
      partial = "";
    }
    if (size === offset) return;
    const fh = await open(paths.exportFile, "r");
    try {
      while (offset < size) {
        const len = Math.min(8 * 1024 * 1024, size - offset);
        const buf = Buffer.alloc(len);
        const { bytesRead } = await fh.read(buf, 0, len, offset);
        if (bytesRead <= 0) break;
        offset += bytesRead;
        const text = partial + buf.subarray(0, bytesRead).toString("utf8");
        const lines = text.split("\n");
        partial = lines.pop() ?? "";
        const keep: string[] = [];
        for (const raw of lines) {
          const line = raw.replace(/\u0000/g, "");
          if (!line.trim()) continue;
          scanned++;
          if (!line.includes(needle)) continue; // cheap prefilter; exact check below
          let rec: unknown;
          try {
            rec = JSON.parse(line);
          } catch {
            parseErrors++;
            keep.push(line); // preserved; normalizeSlice reports it as raw/invalid
            continue;
          }
          if (containerIdMatches(recordDocker(rec), containerId)) keep.push(line);
        }
        if (keep.length) {
          matched += keep.length;
          await appendFile(sliceFile, keep.join("\n") + "\n");
        }
      }
    } finally {
      await fh.close();
    }
  };
  const tick = () => {
    busy = busy.then(drainOnce).catch(() => {
      parseErrors++;
    });
    return busy;
  };
  const timer = setInterval(() => void tick(), opts.pollMs ?? 250);
  await tick();

  return {
    runId: opts.runId,
    containerId,
    sliceFile,
    matched: () => matched,
    async stop({ settleMs = 1500 } = {}) {
      if (stopped) throw new Error("capture already stopped");
      await new Promise((r) => setTimeout(r, settleMs));
      clearInterval(timer);
      await tick();
      stopped = true;
      const loss1 = await lossSnapshot();
      const bytes = await readFile(sliceFile);
      const digest = sha256(bytes);
      await writeFile(join(runDir, "events.jsonl.sha256"), `${digest}  events.jsonl\n`);
      const fullRegistry = await readEnforcementRegistry(opts);
      // Snapshot only OUR policies (registry entries) whose loaded window overlaps this capture, so re-ingesting
      // later stays correct even if a policy name is reused or the registry is lost.
      const registry: EnforcementRegistry = {};
      for (const [k, v] of Object.entries(fullRegistry)) {
        if (v.loaded_at <= new Date().toISOString() && (v.removed_at === null || v.removed_at >= startedAt)) registry[k] = v;
      }
      const evidenceId = sliceEvidenceId(opts.runId);
      const { events, stats: nstats } = normalizeSlice(bytes.toString("utf8").split("\n"), {
        runId: opts.runId,
        evidenceId,
        enforcementPolicies: registry,
        fallbackTime: startedAt,
      });
      const normalizedFile = join(runDir, "events.normalized.jsonl");
      await writeFile(normalizedFile, events.map((e) => JSON.stringify(e)).join("\n") + (events.length ? "\n" : ""));
      const byType: Record<string, number> = {};
      for (const e of events) byType[`${e.kw_type}:${e.outcome}`] = (byType[`${e.kw_type}:${e.outcome}`] ?? 0) + 1;
      const stoppedAt = new Date().toISOString();
      const stats: CaptureStats = {
        run_id: opts.runId,
        container_id: containerId,
        container_name: info?.name ?? null,
        started_at: startedAt,
        stopped_at: stoppedAt,
        export_lines_scanned: scanned,
        export_parse_errors: parseErrors,
        matched_records: matched,
        export_gaps: gaps,
        kernel_loss: lossDelta(loss0, loss1),
        lossy: false,
        isolation_violations: isolation,
        observation_policies_at_attach: obsAtAttach,
        observation_policies_at_stop: [],
        normalize: nstats,
        by_type: byType,
      };
      let loaded: string[] = [];
      const errors: string[] = [...isolation.map((v) => `isolation violation: ${v}`)];
      try {
        loaded = (await listLoadedPolicies()).filter((p) => p.enabled).map((p) => p.name);
      } catch (e) {
        errors.push(`could not list loaded policies: ${String(e)}`);
      }
      stats.observation_policies_at_stop = loaded.filter((n) => n.startsWith("kw-observe-"));
      const obsBoth = obsAtAttach.filter((n) => stats.observation_policies_at_stop.includes(n));
      for (const n of new Set([...obsAtAttach, ...stats.observation_policies_at_stop])) {
        if (!obsBoth.includes(n)) errors.push(`${n} was not enabled for the whole capture window; its category is reported unavailable`);
      }
      if (gaps) errors.push(`export file rotated/shrank ${gaps}x during capture; events may be missing`);
      if (stats.kernel_loss && Object.values(stats.kernel_loss).some((v) => v > 0)) errors.push(`Tetragon reported lost/missed events (VM-wide): ${JSON.stringify(stats.kernel_loss)}`);
      if (!stats.kernel_loss) errors.push("Tetragon loss metrics unreachable; event loss not measured");
      stats.lossy = isLossy(stats.kernel_loss);
      const count = (pre: string) => events.filter((e) => e.kw_type.startsWith(pre)).length;
      const coverage = coverageFragment({
        active: true,
        errors,
        observationPolicies: obsBoth,
        // ours AND (still loaded at stop OR evidenced by a blocked event in this slice)
        enforcementPolicies: [
          ...new Set([
            ...loaded.filter((n) => registry[n]),
            ...events.filter((e) => e.outcome === "blocked" && e.tetragon.enforcement).map((e) => e.tetragon.enforcement!.policy_name),
          ]),
        ],
        counts: { process: count("process."), file: count("file."), net: count("net.") },
        loss: stats.kernel_loss,
      });
      const evidence: Evidence = {
        id: evidenceId,
        run_id: opts.runId,
        is_fixture: false,
        source_type: "kernel_trace",
        source_reference: `data/observer/tetragon/${opts.runId}/events.jsonl`,
        timestamp: stoppedAt,
        integrity_metadata: {
          algorithm: "sha256",
          sha256: digest,
          size_bytes: bytes.length,
          captured_by: "@kw/observer-tetragon (Tetragon v1.7.0 export, filtered by container id)",
          note: `container ${containerId}; ${matched} records`,
        },
        redaction_status: "not_scanned",
        excerpt: null,
      };
      const manifest = { ...stats, sha256: digest, size_bytes: bytes.length, evidence_id: evidenceId, coverage, enforcement_registry_snapshot: registry };
      await writeFile(join(runDir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
      return { runId: opts.runId, sliceFile, sha256: digest, sizeBytes: bytes.length, normalizedFile, stats, coverage, evidence, events };
    },
  };
}
