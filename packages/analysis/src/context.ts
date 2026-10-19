/**
 * Run-environment facts the engine needs but the @kw/schema Run does not carry (see "proposed schema additions").
 * Every field has a documented default. Defaults that encode Underwatch container conventions come from the
 * integrity-security design (one RW mount at /workspace, agent home /home/agent, uid 1000). Defaults that encode facts
 * about Claude Code itself are marked UNVERIFIED until exercised in the container.
 */
export interface PathMapping {
  /** Prefix as seen from the macOS host or a sidecar, e.g. "/var/lib/docker/volumes/kw-ws-123/_data". */
  hostPrefix: string;
  /** The same location inside the agent container, e.g. "/workspace". */
  containerPrefix: string;
}

export interface AnalysisContext {
  /** Container path of the repository under supervision. */
  workspaceRoot: string;
  /** Agent user's home inside the container. Null when unknown (then "~" paths stay unresolved). */
  homeDir: string | null;
  /** Host/sidecar path -> container path translations. Longest hostPrefix wins. */
  pathMappings: PathMapping[];
  /** Symlink table (absolute link path -> absolute target), e.g. from the KW pre-run snapshot. Empty = not available. */
  symlinks: Record<string, string>;
  /** Path prefixes on case-insensitive mounts (e.g. a macOS bind mount). Matching case-folds below them. */
  caseInsensitivePrefixes: string[];
  /** Agent root process ids if the launcher recorded them. When null the engine looks for an exec of `agentProcessNames`. */
  agentPids: number[] | null;
  /** Process names that identify the agent runtime. UNVERIFIED: Claude Code's process shows as "claude" (npm global bin) or "node". */
  agentProcessNames: string[];
  /** Underwatch instrumentation processes (hook binary). Their actions are scope kw_instrumentation. */
  kwProcessNames: string[];
  /**
   * Exact command lines the agent runtime runs as Underwatch instrumentation (the registered hook command, e.g.
   * "node /opt/kw/kw-hook.mjs"). A process is instrumentation only if its observed command line is EXACTLY one of
   * these (or `sh -c '<it>'`) AND its parent is the agent root or another instrumentation process, so a Bash tool
   * call running the same command is never reclassified. Empty = names only.
   */
  kwInstrumentationCommands: string[];
  /** Shell executables (basename) used by the Bash tool. */
  shellNames: string[];
  /**
   * Allowed disagreement between reported timestamps and observed timestamps. Hook payloads carry no timestamp
   * (doc-sourced, probe-observed in research/claude-code/probe-out), so reported times are KW receipt times.
   */
  clockSkewToleranceMs: number;
  /** Maximum time distance for two observed records from different collectors to be considered the same event. */
  dedupToleranceMs: number;
  /** Model API hosts contacted by the agent runtime itself. UNVERIFIED: api.anthropic.com is the default endpoint. */
  modelApiHosts: string[];
  /** Agent install roots (runtime library loads are noise). UNVERIFIED: npm global install locations on node images. */
  agentInstallRoots: string[];
  /** Temp roots. */
  tempRoots: string[];
  /** Workspace-relative globs that were gitignored before the run (build artifacts). Empty = unknown. */
  ignoredGlobs: string[];
}

export const DEFAULT_CONTEXT: AnalysisContext = {
  workspaceRoot: "/workspace",
  homeDir: "/home/agent",
  pathMappings: [],
  symlinks: {},
  caseInsensitivePrefixes: [],
  agentPids: null,
  agentProcessNames: ["claude"],
  kwProcessNames: ["kw-hook"],
  kwInstrumentationCommands: [],
  shellNames: ["bash", "sh", "dash", "zsh"],
  clockSkewToleranceMs: 1000,
  dedupToleranceMs: 500,
  modelApiHosts: ["api.anthropic.com"],
  agentInstallRoots: [
    "/usr/local/lib/node_modules/@anthropic-ai/claude-code",
    "/usr/lib/node_modules/@anthropic-ai/claude-code",
    "/home/agent/.local/share/claude",
  ],
  tempRoots: ["/tmp", "/var/tmp"],
  ignoredGlobs: [],
};

/**
 * Infer the repository root when the caller did not supply context.workspaceRoot: repository-diff collectors report
 * repo-relative paths ("src/a.ts") while tools and tracers report absolute container paths. A root R is supported by
 * a relative path r when some absolute path in the run equals R + "/" + r. The root explaining the most distinct
 * relative paths wins (ties: shorter, then lexicographically smaller). Returns null without such evidence.
 * PROPOSED SCHEMA ADDITION: Run.workspace_root would make this unnecessary.
 */
export function inferWorkspaceRoot(relativePaths: string[], absolutePaths: string[]): { root: string; support: number } | null {
  const counts = new Map<string, Set<string>>();
  const abs = [...new Set(absolutePaths.filter((p) => p.startsWith("/")))];
  for (const r of new Set(relativePaths.filter((p) => p && !p.startsWith("/") && !p.startsWith("~")))) {
    const clean = r.replace(/^\.\//, "");
    for (const a of abs) {
      if (a.endsWith("/" + clean)) {
        const root = a.slice(0, a.length - clean.length - 1) || "/";
        const s = counts.get(root) ?? new Set<string>();
        s.add(clean);
        counts.set(root, s);
      }
    }
  }
  let best: { root: string; support: number } | null = null;
  for (const [root, s] of counts) {
    if (!best || s.size > best.support || (s.size === best.support && (root.length < best.root.length || (root.length === best.root.length && root < best.root)))) {
      best = { root, support: s.size };
    }
  }
  return best;
}

export function resolveContext(partial: Partial<AnalysisContext> | undefined): AnalysisContext {
  const c = { ...DEFAULT_CONTEXT, ...(partial ?? {}) };
  return {
    ...c,
    pathMappings: [...c.pathMappings].sort((a, b) => b.hostPrefix.length - a.hostPrefix.length || (a.hostPrefix < b.hostPrefix ? -1 : 1)),
  };
}
