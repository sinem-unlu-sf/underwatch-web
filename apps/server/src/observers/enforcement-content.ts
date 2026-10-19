/**
 * Content of a "kernel_enforcement" safeguard version: the container paths whose open() Tetragon must deny.
 * Canonical form: {"deny_open_paths": ["/workspace/.env"]}. Lenient input (proposer output is untrusted):
 * the canonical object, {"paths": [...]}, a JSON string array, or one path per line. Relative paths are taken
 * relative to the agent's /workspace. A trailing "/" means prefix match (directory), otherwise exact match.
 */
export const AGENT_WORKSPACE = "/workspace";
const SAFE = /^\/[A-Za-z0-9._@+/-]+$/;
/** Prefixes that would deny opens the container needs to run (mirrors @kw/observer-tetragon's own refusal list). */
const OVERBROAD = new Set(["/", "/workspace/", "/bin/", "/sbin/", "/lib/", "/lib64/", "/usr/", "/etc/", "/proc/", "/sys/", "/dev/", "/tmp/", "/var/", "/run/", "/home/", "/opt/"]);

export type ParseKernelEnforcementResult = { ok: true; paths: string[] } | { ok: false; reason: string };

export function parseKernelEnforcementContent(content: string): ParseKernelEnforcementResult {
  let raw: unknown;
  try {
    raw = JSON.parse(content);
  } catch {
    raw = content
      .split(/\r?\n/)
      .map((l) => l.replace(/^[\s*\-]+/, "").trim())
      .filter((l) => l && !l.startsWith("#"));
  }
  let items: unknown[] = [];
  if (Array.isArray(raw)) items = raw;
  else if (raw && typeof raw === "object") {
    const o = raw as Record<string, unknown>;
    items = Array.isArray(o.deny_open_paths) ? o.deny_open_paths : Array.isArray(o.paths) ? o.paths : [];
  } else if (typeof raw === "string") items = [raw];
  if (!items.every((x) => typeof x === "string")) return { ok: false, reason: "paths must be strings" };
  const paths: string[] = [];
  for (const s of (items as string[]).map((x) => x.trim()).filter(Boolean)) {
    let p = s.replace(/^\.\//, "");
    if (!p.startsWith("/")) p = `${AGENT_WORKSPACE}/${p}`;
    if (!SAFE.test(p) || p.includes("//") || p.split("/").includes("..")) return { ok: false, reason: `unsupported path ${JSON.stringify(s.slice(0, 120))}` };
    if (OVERBROAD.has(p)) return { ok: false, reason: `over-broad path ${JSON.stringify(p)} would break the agent container` };
    paths.push(p);
  }
  if (paths.length === 0) return { ok: false, reason: "no path to deny" };
  if (paths.length > 32) return { ok: false, reason: "at most 32 paths" };
  return { ok: true, paths: [...new Set(paths)] };
}

export function canonicalKernelEnforcementContent(paths: string[]): string {
  return JSON.stringify({ deny_open_paths: paths }, null, 2);
}

/** Tetragon policy names: ^kw-enf-[a-z0-9-]+$, <= 52 chars, unique per run. */
export function enforcementPolicyName(runId: string): string {
  const s = runId.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(-40).replace(/^-+|-+$/g, "") || "run";
  return `kw-enf-${s}`;
}
