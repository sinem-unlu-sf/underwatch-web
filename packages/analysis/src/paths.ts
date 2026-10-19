import type { AnalysisContext } from "./context";

export type Zone = "ws" | "agent_config" | "home" | "tmp" | "kw" | "system" | "proc_dev" | "other";

export interface CanonicalPath {
  /** As the source reported it. */
  raw: string;
  /** Lexically normalized absolute path in the container's view. Null when it cannot be made absolute. */
  absolute: string | null;
  /** After symlink resolution (kernel-resolved path or symlink table). Equals `absolute` when nothing resolved. */
  resolved: string | null;
  method: "kernel_resolved" | "symlink_table" | "lexical_only" | "unresolved";
  zone: Zone;
  /** Path relative to the zone root, e.g. "src/a.ts" for /workspace/src/a.ts. */
  zoneRel: string | null;
  /** Comparison key (resolved, case-folded on case-insensitive mounts). Null when unresolved. */
  key: string | null;
  caseFolded: boolean;
  mappedFromHost: boolean;
  limitations: string[];
}

export function lexicalNormalize(p: string): string {
  const abs = p.startsWith("/");
  const out: string[] = [];
  for (const seg of p.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      if (out.length > 0 && out[out.length - 1] !== "..") out.pop();
      else if (!abs) out.push("..");
      continue;
    }
    out.push(seg);
  }
  return (abs ? "/" : "") + out.join("/");
}

function under(path: string, root: string): boolean {
  const r = root.endsWith("/") && root.length > 1 ? root.slice(0, -1) : root;
  return path === r || path.startsWith(r + "/");
}

function rel(path: string, root: string): string {
  const r = root.endsWith("/") && root.length > 1 ? root.slice(0, -1) : root;
  return path === r ? "" : path.slice(r.length + 1);
}

function mapHost(p: string, ctx: AnalysisContext): { path: string; mapped: boolean } {
  for (const m of ctx.pathMappings) {
    if (under(p, m.hostPrefix)) {
      const tail = rel(p, m.hostPrefix);
      return { path: lexicalNormalize(m.containerPrefix + (tail ? "/" + tail : "")), mapped: true };
    }
  }
  return { path: p, mapped: false };
}

function resolveSymlinks(p: string, table: Record<string, string>): { path: string; changed: boolean; loop: boolean } {
  let cur = p;
  let changed = false;
  for (let iter = 0; iter < 40; iter++) {
    const segs = cur.split("/").filter(Boolean);
    let hit = false;
    for (let i = 1; i <= segs.length; i++) {
      const prefix = "/" + segs.slice(0, i).join("/");
      const target = table[prefix];
      if (target !== undefined) {
        const rest = segs.slice(i).join("/");
        const base = target.startsWith("/") ? target : "/" + segs.slice(0, i - 1).join("/") + "/" + target;
        cur = lexicalNormalize(base + (rest ? "/" + rest : ""));
        changed = true;
        hit = true;
        break;
      }
    }
    if (!hit) return { path: cur, changed, loop: false };
  }
  return { path: cur, changed, loop: true };
}

export function zoneOf(abs: string, ctx: AnalysisContext): { zone: Zone; zoneRel: string } {
  if (under(abs, ctx.workspaceRoot)) return { zone: "ws", zoneRel: rel(abs, ctx.workspaceRoot) };
  if (ctx.homeDir) {
    const cfg = ctx.homeDir.replace(/\/$/, "") + "/.claude";
    if (under(abs, cfg)) return { zone: "agent_config", zoneRel: rel(abs, ctx.homeDir) };
    const base = rel(abs, ctx.homeDir);
    if (under(abs, ctx.homeDir) && /^\.claude\.json(\..*)?$/.test(base)) return { zone: "agent_config", zoneRel: base };
    if (under(abs, ctx.homeDir)) return { zone: "home", zoneRel: base };
  }
  for (const t of ctx.tempRoots) if (under(abs, t)) return { zone: "tmp", zoneRel: rel(abs, t) };
  if (under(abs, "/opt/kw")) return { zone: "kw", zoneRel: rel(abs, "/opt/kw") };
  for (const r of ["/proc", "/sys", "/dev"]) if (under(abs, r)) return { zone: "proc_dev", zoneRel: abs.slice(1) };
  for (const r of ["/usr", "/lib", "/lib64", "/etc", "/bin", "/sbin", "/opt", "/var/lib", "/var/cache"]) {
    if (under(abs, r)) return { zone: "system", zoneRel: abs.slice(1) };
  }
  return { zone: "other", zoneRel: abs.slice(1) };
}

/**
 * Canonicalize a file path into the agent container's view.
 * Order: "~" expansion, host->container mapping, relative->absolute (event cwd, else workspace root), lexical
 * normalization, symlink resolution (kernel-resolved path > symlink table > none), zone mapping, case folding.
 * Never touches the filesystem; everything it could not do is recorded in `limitations`.
 */
export function canonicalizePath(
  raw: string,
  ctx: AnalysisContext,
  opts: { cwd?: string | null; kernelResolved?: string | null } = {},
): CanonicalPath {
  const limitations: string[] = [];
  let p = raw.trim();
  let mapped = false;
  if (p === "") {
    return { raw, absolute: null, resolved: null, method: "unresolved", zone: "other", zoneRel: null, key: null, caseFolded: false, mappedFromHost: false, limitations: ["empty path"] };
  }
  if (p === "~" || p.startsWith("~/")) {
    if (ctx.homeDir) p = ctx.homeDir + p.slice(1);
    else {
      limitations.push("home directory unknown; '~' path not resolved");
      return { raw, absolute: null, resolved: null, method: "unresolved", zone: "home", zoneRel: p.slice(2), key: null, caseFolded: false, mappedFromHost: false, limitations };
    }
  }
  if (p.startsWith("/")) {
    const m = mapHost(lexicalNormalize(p), ctx);
    p = m.path;
    mapped = m.mapped;
  } else {
    const cwd = opts.cwd ?? null;
    if (cwd) p = mapHost(lexicalNormalize(cwd), ctx).path + "/" + p;
    else {
      p = ctx.workspaceRoot + "/" + p;
      limitations.push("relative path resolved against the workspace root (event cwd unavailable)");
    }
  }
  const absolute = lexicalNormalize(p);
  let resolved = absolute;
  let method: CanonicalPath["method"] = "lexical_only";
  if (opts.kernelResolved) {
    const k = opts.kernelResolved.startsWith("/") ? mapHost(lexicalNormalize(opts.kernelResolved), ctx).path : null;
    if (k) {
      resolved = k;
      method = "kernel_resolved";
    }
  }
  if (method === "lexical_only") {
    if (Object.keys(ctx.symlinks).length === 0) {
      limitations.push("symlinks not resolved: no symlink table or kernel-resolved path available");
    } else {
      const r = resolveSymlinks(absolute, ctx.symlinks);
      if (r.loop) limitations.push("symlink resolution exceeded 40 hops");
      if (r.changed) {
        resolved = r.path;
        method = "symlink_table";
      }
    }
  }
  const caseFolded = ctx.caseInsensitivePrefixes.some((pre) => under(resolved.toLowerCase(), pre.toLowerCase()));
  const { zone, zoneRel } = zoneOf(resolved, ctx);
  return {
    raw,
    absolute,
    resolved,
    method,
    zone,
    zoneRel,
    key: caseFolded ? resolved.toLowerCase() : resolved,
    caseFolded,
    mappedFromHost: mapped,
    limitations,
  };
}

/** Both the requested (absolute) and resolved forms, deduplicated; used for deny (either) / allow (both) matching. */
export function pathForms(p: CanonicalPath): string[] {
  const out: string[] = [];
  if (p.absolute) out.push(p.absolute);
  if (p.resolved && p.resolved !== p.absolute) out.push(p.resolved);
  return out;
}

export function basename(p: string): string {
  const i = p.lastIndexOf("/");
  return i >= 0 ? p.slice(i + 1) : p;
}
