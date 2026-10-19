import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { ComponentStatus, CoverageCategory, ObservationCollector, CollectedBatch, CoverageReport, Evidence } from "@kw/schema";
import { observerPaths } from "./config";
import { health } from "./lifecycle";
import { normalizeSlice } from "./parser";
import { readEnforcementRegistry, sha256 } from "./policies";
import { sliceEvidenceId } from "./capture";

/**
 * Re-read a finished per-run slice from disk and normalize it (idempotent: same file -> same event ids).
 * Verifies the slice against its recorded sha256.
 */
export async function readRunEvents(runId: string, opts: { dataDir?: string } = {}) {
  const dir = observerPaths(opts).runDir(runId);
  const slice = join(dir, "events.jsonl");
  if (!existsSync(slice)) throw new Error(`no tetragon slice for ${runId}`);
  const bytes = await readFile(slice);
  const digest = sha256(bytes);
  const recorded = existsSync(join(dir, "events.jsonl.sha256")) ? (await readFile(join(dir, "events.jsonl.sha256"), "utf8")).split(/\s+/)[0] : null;
  const manifest = existsSync(join(dir, "manifest.json")) ? JSON.parse(await readFile(join(dir, "manifest.json"), "utf8")) : null;
  // Prefer the registry snapshot frozen into the manifest at stop() (names can be reused later).
  const registry = manifest?.enforcement_registry_snapshot ?? (await readEnforcementRegistry(opts));
  const { events, stats } = normalizeSlice(bytes.toString("utf8").split("\n"), {
    runId,
    evidenceId: sliceEvidenceId(runId),
    enforcementPolicies: registry,
    fallbackTime: manifest?.started_at,
  });
  return { events, stats, sha256: digest, integrityOk: recorded === null ? null : recorded === digest, manifest, sizeBytes: bytes.length };
}

/** @kw/schema ObservationCollector over finished per-run slices. Capture itself is attach()/stop(). */
export function createTetragonCollector(opts: { dataDir?: string } = {}): ObservationCollector {
  return {
    id: "tetragon",
    async status(): Promise<ComponentStatus> {
      const h = await health(opts);
      const ok = h.tetragon_running && h.tetragon_healthy;
      const obs = h.policies_loaded.filter((p) => p.name.startsWith("kw-observe-")).map((p) => p.name);
      return {
        id: "observer-tetragon",
        name: "Kernel observer (Cilium Tetragon eBPF)",
        status: !h.docker_reachable ? "error" : !h.tetragon_running ? "not_configured" : ok && obs.length === 2 ? "connected" : "degraded",
        detail: !h.docker_reachable
          ? "Docker not reachable"
          : !h.tetragon_running
            ? "kw-tetragon not running (call ensureTetragon())"
            : `Tetragon ${h.tetragon_server_version ?? "?"} on kernel ${h.kernel_version ?? "?"}; BTF ${h.btf_present ? "present" : "missing"}; LSM ${h.bpf_lsm_supported ? "yes" : "unknown"}; policies: ${h.policies_loaded.map((p) => p.name).join(", ") || "none"}${h.errors.length ? "; " + h.errors.join("; ") : ""}`,
        configured_via: "docker container kw-tetragon (packages/observer-tetragon)",
      };
    },
    async capabilities(): Promise<CoverageCategory[]> {
      return ["process_execution", "file_access", "file_modification", "network"];
    },
    async collect(runId: string): Promise<CollectedBatch & { coverage: Partial<CoverageReport> }> {
      const r = await readRunEvents(runId, opts);
      const m = r.manifest as { coverage?: { report?: Partial<CoverageReport> }; stopped_at?: string } | null;
      const evidence: Evidence = {
        id: sliceEvidenceId(runId),
        run_id: runId,
        is_fixture: false,
        source_type: "kernel_trace",
        source_reference: `data/observer/tetragon/${runId}/events.jsonl`,
        timestamp: m?.stopped_at ?? new Date().toISOString(),
        integrity_metadata: {
          algorithm: "sha256",
          sha256: r.sha256,
          size_bytes: r.sizeBytes,
          captured_by: "@kw/observer-tetragon",
          note: r.integrityOk === false ? "WARNING: slice does not match its recorded sha256" : null,
        },
        redaction_status: "not_scanned",
        excerpt: null,
      };
      return { events: r.events, evidence: [evidence], coverage: m?.coverage?.report ?? {} };
    },
  };
}
