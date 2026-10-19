import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { z } from "zod";
import { TETRAGON_CONTAINER, observerPaths } from "./config";
import { docker, dockerOk, inspectContainer } from "./docker";
import { listLoadedPolicies, type LoadedPolicy } from "./lifecycle";

export const OBSERVATION_POLICY_FILES = ["observe-files.yaml", "observe-net.yaml"] as const;
export const OBSERVATION_POLICY_NAMES = ["kw-observe-files", "kw-observe-net"] as const;
/** observe-exec.yaml documents Tetragon's always-on execve sensor; it is not a loadable TracingPolicy. */
export const BUILTIN_SENSOR_FILES = ["observe-exec.yaml"] as const;
export const DENY_FILE_OPEN_TEMPLATE = "deny-file-open.template.yaml";
export const ENFORCEMENT_MECHANISM = "tetragon.lsm.file_open+inode_rename+inode_link.override";

/** Enforcement policy names. The kw-enf- prefix keeps them disjoint from kw-observe-* (never delete/replace those). */
const POLICY_NAME_RE = /^kw-enf-[a-z0-9]([a-z0-9-]{0,44}[a-z0-9])?$/;
/** Prefixes whose denial would break the container itself (and say nothing useful about the agent). */
const OVERBROAD_PREFIXES = new Set(["/", "/bin/", "/sbin/", "/lib/", "/lib64/", "/usr/", "/etc/", "/proc/", "/sys/", "/dev/", "/tmp/", "/var/", "/run/"]);
const SAFE_PATH_RE = /^\/[A-Za-z0-9._@+\/-]{0,250}$/;

export function sha256(text: string | Buffer): string {
  return createHash("sha256").update(text).digest("hex");
}

export const EnforcementRecord = z.object({
  policy_name: z.string(),
  policy_sha256: z.string().regex(/^[0-9a-f]{64}$/),
  mechanism: z.string(),
  errno: z.literal("EPERM"),
  pidns_inode: z.string().regex(/^\d+$/),
  container_id: z.string().nullable(),
  paths: z.array(z.string()),
  loaded_at: z.string(),
  removed_at: z.string().nullable(),
  yaml: z.string(),
});
export type EnforcementRecord = z.infer<typeof EnforcementRecord>;
const Registry = z.record(z.string(), EnforcementRecord);
export type EnforcementRegistry = z.infer<typeof Registry>;

export async function readEnforcementRegistry(opts: { dataDir?: string } = {}): Promise<EnforcementRegistry> {
  const f = observerPaths(opts).enforcementRegistryFile;
  if (!existsSync(f)) return {};
  return Registry.parse(JSON.parse(await readFile(f, "utf8")));
}

async function writeRegistry(reg: EnforcementRegistry, opts: { dataDir?: string }): Promise<void> {
  const f = observerPaths(opts).enforcementRegistryFile;
  await mkdir(dirname(f), { recursive: true });
  await writeFile(f, JSON.stringify(reg, null, 2) + "\n");
}

/** Copy YAML into kw-tetragon (stdin, no host mount) and load it with `tetra tracingpolicy add` - the spike's working method. */
async function addPolicyYaml(name: string, yaml: string): Promise<void> {
  const inContainer = `/tmp/kw-policies/${name}.yaml`;
  await dockerOk(["exec", "-i", TETRAGON_CONTAINER, "sh", "-c", `mkdir -p /tmp/kw-policies && cat > ${inContainer}`], `copy policy ${name}`, {
    input: yaml,
  });
  await dockerOk(["exec", TETRAGON_CONTAINER, "tetra", "tracingpolicy", "add", inContainer], `tetra tracingpolicy add ${name}`, {
    timeoutMs: 60_000,
  });
}

async function deletePolicy(name: string): Promise<boolean> {
  const r = await docker(["exec", TETRAGON_CONTAINER, "tetra", "tracingpolicy", "delete", name], { timeoutMs: 30_000 });
  return r.code === 0;
}

function isEnabled(p: LoadedPolicy | undefined): boolean {
  return !!p && p.enabled && p.state === "TP_STATE_ENABLED";
}

export interface PolicyLoadResult {
  name: string;
  file: string;
  sha256: string;
  action: "added" | "reloaded" | "already_loaded";
  loaded: boolean;
  mode: string;
}

const STATE_FILE = "observation-policies.json";

/**
 * Load kw-observe-files and kw-observe-net (monitor only). Idempotent: a policy already loaded with the same
 * content hash is left alone; a changed file is deleted and re-added. Verifies each is listed as enabled.
 */
export async function loadObservationPolicies(opts: { dataDir?: string; policiesDir?: string } = {}): Promise<PolicyLoadResult[]> {
  const paths = observerPaths(opts);
  const stateFile = join(paths.dataDir, STATE_FILE);
  const state: Record<string, string> = existsSync(stateFile) ? JSON.parse(await readFile(stateFile, "utf8")) : {};
  const out: PolicyLoadResult[] = [];
  for (let i = 0; i < OBSERVATION_POLICY_FILES.length; i++) {
    const file = join(paths.policiesDir, OBSERVATION_POLICY_FILES[i]!);
    const name = OBSERVATION_POLICY_NAMES[i]!;
    const yaml = await readFile(file, "utf8");
    if (!yaml.includes(`name: "${name}"`)) throw new Error(`${file} does not declare metadata.name ${name}`);
    const hash = sha256(yaml);
    const before = (await listLoadedPolicies()).find((p) => p.name === name);
    let action: PolicyLoadResult["action"] = "added";
    if (before) {
      if (state[name] === hash && isEnabled(before)) {
        action = "already_loaded";
      } else {
        await deletePolicy(name);
        action = "reloaded";
      }
    }
    if (action !== "already_loaded") await addPolicyYaml(name, yaml);
    const after = (await listLoadedPolicies()).find((p) => p.name === name);
    state[name] = hash;
    out.push({ name, file, sha256: hash, action, loaded: isEnabled(after), mode: after?.mode ?? "absent" });
  }
  await mkdir(paths.dataDir, { recursive: true });
  await writeFile(stateFile, JSON.stringify(state, null, 2) + "\n");
  return out;
}

async function readPidns(pid: number): Promise<string> {
  const out = await dockerOk(["exec", TETRAGON_CONTAINER, "readlink", `/proc/${pid}/ns/pid`], "read pid namespace");
  const m = /^pid:\[(\d+)\]$/.exec(out.trim());
  if (!m) throw new Error(`unexpected pid ns link: ${out.trim()}`);
  return m[1]!;
}

/** Pid-namespace inode of the Docker Desktop VM (pid 1 as seen from kw-tetragon, which runs in the host pid ns). */
export async function hostPidnsInode(): Promise<string> {
  return readPidns(1);
}

/** Pid-namespace inode of a running container, read from /proc/<vm pid>/ns/pid inside kw-tetragon (host pid ns). */
export async function getPidnsInode(containerRef: string): Promise<{ containerId: string; pidnsInode: string }> {
  const info = await inspectContainer(containerRef);
  if (!info) throw new Error(`container not found: ${containerRef}`);
  if (!info.running || info.pid <= 0) throw new Error(`container ${info.name} is not running; its pid namespace does not exist yet`);
  if (info.pidMode === "host" || info.pidMode.startsWith("container:")) {
    throw new Error(`container ${info.name} shares a pid namespace (${info.pidMode}); refusing to scope enforcement to it`);
  }
  const inode = await readPidns(info.pid);
  const hostInode = await hostPidnsInode();
  if (inode === hostInode) {
    // A --pid=host container shares the VM's pid namespace: scoping by it would enforce VM-wide.
    throw new Error(`container ${info.name} shares the host pid namespace; refusing to scope enforcement to it`);
  }
  return { containerId: info.id, pidnsInode: inode };
}

/**
 * Names that must not be renamed/hard-linked away for the open-time deny to hold: each protected path (prefix
 * entries also as their directory itself), every ancestor directory, plus mount-relative variants for paths under
 * the given mount destinations (dentry paths are relative to the mount root).
 */
export function renameGuardPaths(paths: string[], mountDestinations: string[] = []): { exact: string[]; prefix: string[] } {
  const exact = new Set<string>();
  const prefix = new Set<string>();
  const add = (p: string) => {
    if (p.endsWith("/")) {
      prefix.add(p);
      if (p.length > 1) exact.add(p.slice(0, -1));
    } else exact.add(p);
    const parts = p.replace(/\/$/, "").split("/").filter(Boolean);
    for (let i = 1; i < parts.length; i++) exact.add("/" + parts.slice(0, i).join("/"));
  };
  for (const p of paths) {
    add(p);
    for (const d of mountDestinations) {
      const dd = d.replace(/\/+$/, "");
      if (!dd || dd === "/" || !p.startsWith(dd + "/")) continue;
      const rel = p.slice(dd.length);
      // The mount root itself cannot be renamed (EBUSY) and "/" would guard every rename in the container.
      if (rel !== "/") add(rel);
    }
  }
  return { exact: [...exact].sort(), prefix: [...prefix].sort() };
}

export function renderDenyFileOpen(
  template: string,
  input: { policyName: string; pidnsInode: string; paths: string[]; mountDestinations?: string[] },
): string {
  if (!POLICY_NAME_RE.test(input.policyName)) throw new Error(`invalid policy name ${input.policyName} (want ${POLICY_NAME_RE})`);
  if (!/^\d+$/.test(input.pidnsInode)) throw new Error(`invalid pid namespace inode ${input.pidnsInode}`);
  if (input.paths.length === 0) throw new Error("applyEnforcement needs at least one path");
  for (const p of input.paths) {
    if (OVERBROAD_PREFIXES.has(p)) throw new Error(`refusing over-broad enforcement prefix ${JSON.stringify(p)} (would deny opens the container needs to run)`);
    if (!SAFE_PATH_RE.test(p) || p.includes("//") || p.split("/").includes("..")) throw new Error(`refusing unsafe/unsupported path ${JSON.stringify(p)}`);
  }
  const exact = input.paths.filter((p) => !p.endsWith("/"));
  const prefix = input.paths.filter((p) => p.endsWith("/"));
  const fmt = (list: string[]) => list.map((p) => `        - "${p}"`).join("\n");
  let y = template.replaceAll("__POLICY_NAME__", input.policyName).replaceAll("__PIDNS_INODE__", input.pidnsInode);
  const block = (tag: string, list: string[], placeholder: string) => {
    const re = new RegExp(`    #BEGIN_${tag}\\n([\\s\\S]*?)    #END_${tag}\\n`);
    y = y.replace(re, (_m, body: string) => (list.length ? body.replaceAll(placeholder, fmt(list)) : ""));
  };
  block("EXACT", exact, "__EXACT_PATHS__");
  block("PREFIX", prefix, "__PREFIX_PATHS__");
  const guard = renameGuardPaths(input.paths, input.mountDestinations ?? []);
  for (const p of [...guard.exact, ...guard.prefix]) {
    if (!SAFE_PATH_RE.test(p)) throw new Error(`refusing unsafe rename-guard path ${JSON.stringify(p)}`);
  }
  for (const n of ["1", "2"]) {
    block(`R${n}EXACT`, guard.exact, "__RENAME_EXACT__");
    block(`R${n}PREFIX`, guard.prefix, "__RENAME_PREFIX__");
  }
  // Drop the template's leading comment block; keep a provenance header.
  const body = y.slice(y.indexOf("apiVersion:"));
  return `# Rendered by @kw/observer-tetragon applyEnforcement() from ${DENY_FILE_OPEN_TEMPLATE}\n${body}`;
}

export interface ApplyEnforcementInput {
  /** Container to scope to (name or id). Its pid-namespace inode is resolved at apply time. */
  scopeContainerId?: string;
  /** Alternative: an already-known pid-namespace inode. */
  pidnsInode?: string;
  /** Absolute container paths. A trailing "/" means prefix match; otherwise exact match. */
  paths: string[];
  /** Must match /^kw-enf-[a-z0-9-]+$/ (<= 52 chars); make it unique per verification run (e.g. "kw-enf-<run suffix>"). */
  policyName: string;
  dataDir?: string;
  policiesDir?: string;
}

export interface ApplyEnforcementResult {
  policyName: string;
  policyHash: string;
  loaded: boolean;
  mode: string;
  pidnsInode: string;
  containerId: string | null;
  yaml: string;
}

/** Load a deny-file-open (BPF-LSM file_open Override -> EPERM) policy scoped to ONE container's pid namespace. */
export async function applyEnforcement(input: ApplyEnforcementInput): Promise<ApplyEnforcementResult> {
  if (!!input.scopeContainerId === !!input.pidnsInode) throw new Error("pass exactly one of scopeContainerId or pidnsInode");
  const paths = observerPaths(input);
  let containerId: string | null = null;
  let pidnsInode = input.pidnsInode ?? "";
  let mountDestinations: string[] = [];
  if (input.scopeContainerId) {
    const r = await getPidnsInode(input.scopeContainerId);
    containerId = r.containerId;
    pidnsInode = r.pidnsInode;
    mountDestinations = ((await inspectContainer(r.containerId))?.mountSources ?? []).map((m) => m.destination);
  } else if (pidnsInode === (await hostPidnsInode())) {
    throw new Error(`pid namespace ${pidnsInode} is the Docker VM's host pid namespace; refusing to enforce VM-wide`);
  }
  // Drop stale enforcement first: pid-namespace inode numbers are recycled, so a policy left behind for an exited
  // container could start matching an unrelated new container.
  await sweepStaleEnforcement(input).catch(() => undefined);
  const template = await readFile(join(paths.policiesDir, DENY_FILE_OPEN_TEMPLATE), "utf8");
  const yaml = renderDenyFileOpen(template, { policyName: input.policyName, pidnsInode, paths: input.paths, mountDestinations });
  const policyHash = sha256(yaml);
  if ((await listLoadedPolicies()).some((p) => p.name === input.policyName)) await deletePolicy(input.policyName);
  await addPolicyYaml(input.policyName, yaml);
  const after = (await listLoadedPolicies()).find((p) => p.name === input.policyName);
  const loaded = isEnabled(after);
  if (!loaded) {
    // Never leave a half-loaded, unregistered enforcement policy behind.
    await deletePolicy(input.policyName);
  } else {
    const reg = await readEnforcementRegistry(input);
    reg[input.policyName] = {
      policy_name: input.policyName,
      policy_sha256: policyHash,
      mechanism: ENFORCEMENT_MECHANISM,
      errno: "EPERM",
      pidns_inode: pidnsInode,
      container_id: containerId,
      paths: input.paths,
      loaded_at: new Date().toISOString(),
      removed_at: null,
      yaml,
    };
    await writeRegistry(reg, input);
  }
  return { policyName: input.policyName, policyHash, loaded, mode: after?.mode ?? "absent", pidnsInode, containerId, yaml };
}

/** Unload an enforcement policy. The registry entry is kept (with removed_at) so past blocked events stay attributable. */
export async function removeEnforcement(policyName: string, opts: { dataDir?: string } = {}): Promise<{ removed: boolean; stillLoaded: boolean }> {
  if (!POLICY_NAME_RE.test(policyName)) throw new Error(`invalid policy name ${policyName}`);
  const removed = await deletePolicy(policyName);
  const stillLoaded = (await listLoadedPolicies()).some((p) => p.name === policyName);
  const reg = await readEnforcementRegistry(opts);
  const rec = reg[policyName];
  if (rec && !stillLoaded && rec.removed_at === null) {
    rec.removed_at = new Date().toISOString();
    await writeRegistry(reg, opts);
  }
  return { removed, stillLoaded };
}

/**
 * Unload kw-enf-* policies that no longer have a live target: unregistered ones (unknown scope), ones whose
 * registered container is gone / stopped, or whose container now has a different pid namespace. Safe to call at
 * server startup and before every applyEnforcement (it never touches kw-observe-*).
 */
export async function sweepStaleEnforcement(opts: { dataDir?: string } = {}): Promise<Array<{ policyName: string; reason: string }>> {
  const loaded = (await listLoadedPolicies()).filter((p) => p.name.startsWith("kw-enf-"));
  if (!loaded.length) return [];
  const reg = await readEnforcementRegistry(opts);
  const swept: Array<{ policyName: string; reason: string }> = [];
  for (const p of loaded) {
    const rec = reg[p.name];
    let reason: string | null = null;
    if (!rec) reason = "not in the enforcement registry (unknown scope)";
    else if (rec.container_id) {
      const info = await inspectContainer(rec.container_id);
      if (!info || !info.running || info.pid <= 0) reason = "scoped container is no longer running";
      else {
        const cur = await readPidns(info.pid).catch(() => null);
        if (cur !== rec.pidns_inode) reason = `scoped container's pid namespace changed (${rec.pidns_inode} -> ${cur ?? "?"})`;
      }
    }
    if (reason) {
      await removeEnforcement(p.name, opts);
      swept.push({ policyName: p.name, reason });
    }
  }
  return swept;
}
