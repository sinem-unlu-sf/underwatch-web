import { mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import {
  KW_LABEL,
  TETRAGON_CONTAINER,
  TETRAGON_EXPECTED_VERSION,
  TETRAGON_EXPORT_MAX_MB,
  TETRAGON_IMAGE,
  TETRAGON_METRICS_ADDR,
  observerPaths,
  type ObserverPaths,
} from "./config";
import { docker, dockerOk } from "./docker";

export interface LoadedPolicy {
  id: string;
  name: string;
  enabled: boolean;
  state: string;
  mode: string;
  sensors: string[];
}

export interface TetragonHealth {
  docker_reachable: boolean;
  docker_server_version: string | null;
  tetragon_container: string;
  tetragon_running: boolean;
  tetragon_healthy: boolean;
  tetragon_server_version: string | null;
  image: string;
  btf_present: boolean | null;
  kernel_version: string | null;
  /** From Tetragon's startup log ("BPF detected features"). null = log line not found. */
  bpf_lsm_supported: boolean | null;
  override_return_supported: boolean | null;
  policies_loaded: LoadedPolicy[];
  export_file: string;
  export_file_present: boolean;
  metrics_url: string;
  errors: string[];
}

export interface EnsureOptions {
  dataDir?: string;
  /** Max seconds to wait for "Health Status: running". */
  waitSeconds?: number;
}

function runArgs(paths: ObserverPaths): string[] {
  return [
    "run",
    "-d",
    "--name",
    TETRAGON_CONTAINER,
    "--label",
    KW_LABEL,
    "--label",
    "kw-role=observer",
    // Exactly the spike's working shape: host pid ns, host cgroup ns, privileged, BTF mount.
    "--pid=host",
    "--cgroupns=host",
    "--privileged",
    // No network at all: agent containers cannot reach Tetragon's metrics or gRPC (on the default bridge, or via
    // host.docker.internal -> a published port). Metrics are read with `docker exec kw-tetragon wget` instead.
    "--network",
    "none",
    "-v",
    "/sys/kernel/btf/vmlinux:/var/lib/tetragon/btf:ro",
    // Host-only evidence directory. Agent containers never get this mount.
    "-v",
    `${paths.exportDir}:/var/log/tetragon`,
    TETRAGON_IMAGE,
    "--export-filename",
    "/var/log/tetragon/tetragon.log",
    "--export-file-max-size-mb",
    String(TETRAGON_EXPORT_MAX_MB),
    "--export-file-perm",
    "640",
    "--metrics-server",
    TETRAGON_METRICS_ADDR,
    "--server-address",
    "localhost:54321",
  ];
}

async function tetraHealthy(): Promise<boolean> {
  const r = await docker(["exec", TETRAGON_CONTAINER, "tetra", "status"], { timeoutMs: 10_000 });
  return r.code === 0 && /Health Status:\s*running/i.test(r.stdout);
}

async function waitHealthy(seconds: number): Promise<boolean> {
  for (let i = 0; i < seconds * 2; i++) {
    if (await tetraHealthy()) return true;
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

interface ExistingState {
  exists: boolean;
  running: boolean;
  image: string | null;
  exportMountOk: boolean;
  /** --network none and metrics bound to the container's loopback (current hardened shape). */
  isolatedOk: boolean;
  ownedByKw: boolean;
}

async function existing(paths: ObserverPaths): Promise<ExistingState> {
  const r = await docker(["inspect", "--type", "container", "-f", "{{json .}}", TETRAGON_CONTAINER], { timeoutMs: 15_000 });
  if (r.code !== 0) return { exists: false, running: false, image: null, exportMountOk: false, isolatedOk: false, ownedByKw: false };
  const j = JSON.parse(r.stdout) as {
    State: { Running: boolean };
    Args?: string[] | null;
    HostConfig?: { NetworkMode?: string; PortBindings?: Record<string, unknown> | null };
    Config: { Image: string; Labels: Record<string, string> | null };
    Mounts: Array<{ Source: string; Destination: string }>;
  };
  const exportMountOk = j.Mounts.some(
    (m) => m.Destination === "/var/log/tetragon" && (m.Source === paths.exportDir || m.Source.endsWith(paths.exportDir)),
  );
  return {
    exists: true,
    running: j.State.Running,
    image: j.Config.Image,
    exportMountOk,
    isolatedOk:
      j.HostConfig?.NetworkMode === "none" &&
      Object.keys(j.HostConfig?.PortBindings ?? {}).length === 0 &&
      (j.Args ?? []).includes(TETRAGON_METRICS_ADDR),
    ownedByKw: j.Config.Labels?.["kw-dev"] === "1",
  };
}

/**
 * Start (or reuse) the single long-running kw-tetragon observer. Idempotent.
 * Recreates the container only when it carries our kw-dev label but has the wrong image / export mount.
 */
export async function ensureTetragon(opts: EnsureOptions = {}): Promise<TetragonHealth> {
  const paths = observerPaths(opts);
  await mkdir(paths.exportDir, { recursive: true });
  const ver = await docker(["version", "--format", "{{.Server.Version}}"], { timeoutMs: 15_000 });
  if (ver.code !== 0) throw new Error(`docker daemon not reachable: ${ver.stderr.trim()}`);

  const st = await existing(paths);
  if (st.exists && (st.image !== TETRAGON_IMAGE || !st.exportMountOk || !st.isolatedOk)) {
    if (!st.ownedByKw) {
      throw new Error(`a container named ${TETRAGON_CONTAINER} exists without label ${KW_LABEL}; refusing to touch it`);
    }
    await dockerOk(["rm", "-f", TETRAGON_CONTAINER], "remove misconfigured kw-tetragon");
    st.exists = false;
  }
  if (!st.exists) {
    await dockerOk(runArgs(paths), "start kw-tetragon", { timeoutMs: 120_000 });
  } else if (!st.running) {
    await dockerOk(["start", TETRAGON_CONTAINER], "restart kw-tetragon");
  }
  const ok = await waitHealthy(opts.waitSeconds ?? 60);
  const h = await health(opts);
  if (!ok) h.errors.push("tetra status did not report 'Health Status: running' in time");
  return h;
}

/** Stop and remove kw-tetragon (all loaded policies, including enforcement, are unloaded with it). */
export async function stopTetragon(): Promise<void> {
  await docker(["rm", "-f", TETRAGON_CONTAINER], { timeoutMs: 60_000 });
}

export async function listLoadedPolicies(): Promise<LoadedPolicy[]> {
  const out = await dockerOk(["exec", TETRAGON_CONTAINER, "tetra", "tracingpolicy", "list", "-o", "json"], "list tracing policies", {
    timeoutMs: 20_000,
  });
  const j = JSON.parse(out || "{}") as {
    policies?: Array<{ id: string; name: string; enabled?: boolean; state?: string; mode?: string; sensors?: string[] }>;
  };
  return (j.policies ?? []).map((p) => ({
    id: p.id,
    name: p.name,
    enabled: p.enabled === true,
    state: p.state ?? "unknown",
    mode: p.mode ?? "unknown",
    sensors: p.sensors ?? [],
  }));
}

export async function health(opts: { dataDir?: string } = {}): Promise<TetragonHealth> {
  const paths = observerPaths(opts);
  const h: TetragonHealth = {
    docker_reachable: false,
    docker_server_version: null,
    tetragon_container: TETRAGON_CONTAINER,
    tetragon_running: false,
    tetragon_healthy: false,
    tetragon_server_version: null,
    image: TETRAGON_IMAGE,
    btf_present: null,
    kernel_version: null,
    bpf_lsm_supported: null,
    override_return_supported: null,
    policies_loaded: [],
    export_file: paths.exportFile,
    export_file_present: existsSync(paths.exportFile),
    metrics_url: `container-local http://${TETRAGON_METRICS_ADDR}/metrics (read via docker exec; kw-tetragon has --network none)`,
    errors: [],
  };
  const ver = await docker(["version", "--format", "{{.Server.Version}}"], { timeoutMs: 15_000 });
  if (ver.code !== 0) {
    h.errors.push(`docker not reachable: ${ver.stderr.trim()}`);
    return h;
  }
  h.docker_reachable = true;
  h.docker_server_version = ver.stdout.trim();
  const st = await existing(paths);
  h.tetragon_running = st.running;
  if (st.exists && !st.isolatedOk) h.errors.push("kw-tetragon is not in the hardened shape (--network none, no published ports); call ensureTetragon() to recreate it");
  if (!st.running) {
    h.errors.push(st.exists ? "kw-tetragon exists but is not running" : "kw-tetragon is not running");
    return h;
  }
  h.tetragon_healthy = await tetraHealthy();
  const v = await docker(["exec", TETRAGON_CONTAINER, "tetra", "version", "--server"], { timeoutMs: 15_000 });
  const m = /Server version:\s*(\S+)/.exec(v.stdout);
  h.tetragon_server_version = m?.[1] ?? null;
  if (h.tetragon_server_version && h.tetragon_server_version !== TETRAGON_EXPECTED_VERSION) {
    h.errors.push(`unexpected Tetragon server version ${h.tetragon_server_version} (validated: ${TETRAGON_EXPECTED_VERSION})`);
  }
  const btf = await docker(["exec", TETRAGON_CONTAINER, "test", "-s", "/var/lib/tetragon/btf"], { timeoutMs: 10_000 });
  h.btf_present = btf.code === 0;
  const un = await docker(["exec", TETRAGON_CONTAINER, "uname", "-r"], { timeoutMs: 10_000 });
  h.kernel_version = un.code === 0 ? un.stdout.trim() : null;
  const logs = await docker(["logs", TETRAGON_CONTAINER], { timeoutMs: 15_000 });
  const feat = /BPF detected features:([^"\n]*)/.exec(logs.stdout + logs.stderr)?.[1];
  if (feat) {
    h.bpf_lsm_supported = /\blsm: true/.test(feat);
    h.override_return_supported = /override_return: true/.test(feat);
  }
  try {
    h.policies_loaded = await listLoadedPolicies();
  } catch (e) {
    h.errors.push(String(e));
  }
  return h;
}
