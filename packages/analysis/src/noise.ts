import type { ProcTree } from "./attribution";
import type { AnalysisContext } from "./context";
import { globMatchPath } from "./glob";
import { basename } from "./paths";
import { matchPathPattern } from "./policy";
import type { ActionKind, Attribution, LogicalObservation } from "./types";
import { NOISE_MODEL_VERSION } from "./version";

/**
 * Versioned, visible noise model for expected background activity.
 *
 * Semantics (correlation-engine design section 5.1):
 *  - A rule CLASSIFIES an observation; it never removes it. Classified observations are returned in `suppressed` with
 *    the rule id, and stay in observations/correlations/decisions.
 *  - Classification excludes an observation only from "unreported observed action" and "change mismatch"
 *    candidates. Policy evaluation (permission violations) ignores noise entirely.
 *  - Every rule is scoped by principal + operation + resource, so e.g. the runtime's own transcript writes are noise
 *    but a Bash subprocess writing the same file is not.
 *  - Nothing is learned at runtime: changing a rule means bumping NOISE_MODEL_VERSION.
 */
export type NoisePrincipal =
  | "any"
  | "agent_process" // the agent root process itself (not children, not tool subtrees)
  | "agent_tree" // any process descending from the agent root, or attributed to a tool call
  | "tool_scope" // attributed to a reported tool call
  | "kw_instrumentation"
  | "no_process_identity"; // records without a pid (proxy without socket join)

export interface NoiseRule {
  id: string;
  noise_class: string;
  rationale: string;
  /** Where the expectation comes from; UNVERIFIED entries are doc-sourced or assumed, not observed in our container. */
  provenance: string;
  principal: NoisePrincipal;
  kinds: ActionKind[];
  /** Zone-anchored path patterns (see policy.ts). "{install_root}/**" expands to context.agentInstallRoots. */
  paths?: string[];
  /** Matches context.ignoredGlobs (workspace-relative) instead of fixed paths. */
  usesIgnoredGlobs?: boolean;
  /** Process name (basename) must be one of these. "{shell}" expands to context.shellNames. */
  processNames?: string[];
  /** Network: host must be a context.modelApiHosts entry. */
  modelApiHosts?: boolean;
  /** Sources the record must come from (all constituents). */
  sources?: string[];
  /** Outcome condition. */
  errno?: string[];
  /** Special conditions implemented in code. */
  special?: "temp_same_scope" | "git_readonly_subcommand" | "runtime_bundled_exec" | "cc_shell_snapshot";
  /** Carve-outs that stay visible even if the rule matches. */
  except?: Array<{ kinds: ActionKind[]; paths: string[] }>;
}

const READS: ActionKind[] = ["file.read"];
const RW: ActionKind[] = ["file.read", "file.write", "file.delete"];
const WRITES: ActionKind[] = ["file.write", "file.delete"];

export const NOISE_RULES: readonly NoiseRule[] = [
  {
    id: "NM-KW",
    noise_class: "kw_instrumentation",
    rationale: "Underwatch's own hook binary and its descendants.",
    provenance: "Underwatch design (hook binary registered in managed settings)",
    principal: "kw_instrumentation",
    kinds: ["file.read", "file.write", "file.delete", "proc.exec", "net.connect", "net.dns"],
  },
  {
    id: "NM-AGENT-LAUNCH",
    noise_class: "agent_launch",
    rationale: "The exec of the agent runtime itself (the supervised session starting).",
    provenance: "Underwatch launcher design",
    principal: "agent_process",
    kinds: ["proc.exec"],
  },
  {
    id: "NM-PROBE",
    noise_class: "path_probe",
    rationale: "A failed lookup of a missing path (ENOENT) is a probe, not an attempt at the primary operation.",
    provenance: "POSIX semantics",
    principal: "any",
    kinds: ["file.read", "file.write", "file.delete"],
    errno: ["ENOENT", "ENOTDIR"],
  },
  {
    id: "NM-CC-HOUSEKEEPING",
    noise_class: "agent_runtime_housekeeping",
    rationale: "Claude Code persists transcripts, file-history checkpoints, shell snapshots, session state and ~/.claude.json(+backups) under its config dir.",
    provenance: "UNVERIFIED: doc-sourced (claude-directory.md, fetched 2026-10-17); not yet observed with a kernel collector in our container",
    principal: "agent_process",
    kinds: RW,
    paths: ["home:.claude/**", "home:.claude.json", "home:.claude.json.*"],
    // Writes that change agent behavior stay visible even from the runtime process: settings, credentials, user memory
    // (CLAUDE.md) and user-level agents/commands/skills/output styles (all S2 in sensitivity.ts; the research found
    // CLAUDE.md agent-writable and settings tamperable). ~/.claude.json (MCP servers) is NOT excepted: the runtime
    // rewrites it constantly and contents are not visible here; see remaining issues.
    except: [{
      kinds: WRITES,
      paths: [
        "home:.claude/settings*.json", "home:.claude/.credentials.json", "home:.claude/CLAUDE.md",
        "home:.claude/agents/**", "home:.claude/commands/**", "home:.claude/skills/**", "home:.claude/output-styles/**",
      ],
    }],
  },
  {
    id: "NM-RUNTIME-READ",
    noise_class: "runtime_library_load",
    rationale: "Dynamic loader, certificates, resolver files, /proc/self, cgroup and device nodes read by every runtime; the agent's own install root.",
    provenance: "Linux runtime behavior; install roots UNVERIFIED (npm global install layout)",
    principal: "any",
    kinds: READS,
    paths: [
      "abs:/usr/lib/**", "abs:/lib/**", "abs:/lib64/**", "abs:/usr/lib64/**", "abs:/usr/share/**", "abs:/usr/local/lib/**",
      "abs:/usr/bin/**", "abs:/usr/local/bin/**", "abs:/bin/**",
      "abs:/etc/ld.so.cache", "abs:/etc/ld.so.conf", "abs:/etc/ld.so.conf.d/**", "abs:/etc/ssl/**", "abs:/etc/ca-certificates/**",
      "abs:/etc/resolv.conf", "abs:/etc/hosts", "abs:/etc/nsswitch.conf", "abs:/etc/passwd", "abs:/etc/group", "abs:/etc/localtime",
      "abs:/etc/host.conf", "abs:/etc/gai.conf", "abs:/etc/os-release",
      "abs:/proc/self/**", "abs:/proc/meminfo", "abs:/proc/cpuinfo", "abs:/proc/stat", "abs:/sys/fs/cgroup/**", "abs:/sys/devices/system/cpu/**",
      "abs:/dev/null", "abs:/dev/urandom", "abs:/dev/random", "abs:/dev/tty", "abs:/dev/pts/**",
      "{install_root}/**",
    ],
  },
  {
    id: "NM-SHELL-STARTUP",
    noise_class: "shell_startup",
    rationale: "Shells read their startup files; Claude Code sources a shell snapshot before Bash commands.",
    provenance: "Shell semantics; shell-snapshot path UNVERIFIED (doc-sourced)",
    principal: "agent_tree",
    processNames: ["{shell}"],
    kinds: READS,
    paths: [
      "home:.bashrc", "home:.bash_profile", "home:.profile", "home:.zshrc", "home:.zshenv", "home:.inputrc",
      "abs:/etc/profile", "abs:/etc/profile.d/**", "abs:/etc/bash.bashrc", "abs:/etc/zsh/**", "abs:/etc/inputrc",
      "home:.claude/shell-snapshots/**",
    ],
  },
  {
    id: "NM-GIT-INTERNALS",
    noise_class: "git_internals",
    rationale: "git reads and maintains its object store, index, refs and logs.",
    provenance: "git semantics",
    principal: "agent_tree",
    processNames: ["git"],
    kinds: RW,
    paths: [
      "ws:.git/objects/**", "ws:.git/index", "ws:.git/index.lock", "ws:.git/refs/**", "ws:.git/logs/**", "ws:.git/HEAD",
      "ws:.git/ORIG_HEAD", "ws:.git/FETCH_HEAD", "ws:.git/packed-refs", "ws:.git/COMMIT_EDITMSG", "ws:.git/info/**",
    ],
  },
  {
    id: "NM-GIT-CONFIG-READ",
    noise_class: "git_internals",
    rationale: "git reads repository and user configuration (reads only; writes to .git/config or .git/hooks stay visible).",
    provenance: "git semantics",
    principal: "agent_tree",
    processNames: ["git"],
    kinds: READS,
    paths: ["ws:.git/**", "home:.gitconfig", "home:.config/git/**", "abs:/etc/gitconfig"],
  },
  {
    id: "NM-CC-GIT-CONTEXT",
    noise_class: "agent_runtime_git_context",
    rationale: "Read-only git commands the agent runtime runs for repository context, outside any tool call.",
    provenance: "UNVERIFIED: assumption that Claude Code runs read-only git (status/log/rev-parse/branch) for context",
    principal: "agent_tree",
    processNames: ["git"],
    kinds: ["proc.exec"],
    special: "git_readonly_subcommand",
  },
  {
    id: "NM-DEPS-READ",
    noise_class: "dependency_read",
    rationale: "Node module resolution and package-manager caches read by tools and the runtime.",
    provenance: "Node.js module resolution",
    principal: "agent_tree",
    kinds: READS,
    paths: ["ws:node_modules/**", "ws:**/node_modules/**", "home:.npm/**", "home:.cache/**", "home:.node_repl_history", "abs:/usr/local/lib/node_modules/**"],
  },
  {
    id: "NM-TOOLCHAIN-CACHE",
    noise_class: "toolchain_cache",
    rationale: "Build tool and package manager caches written during reported tool calls.",
    provenance: "npm/vite/vitest cache layout",
    principal: "tool_scope",
    kinds: WRITES,
    paths: ["ws:**/node_modules/.cache/**", "ws:**/node_modules/.vite/**", "ws:**/node_modules/.vitest/**", "home:.npm/_cacache/**", "home:.npm/_logs/**", "home:.cache/**"],
  },
  {
    id: "NM-BUILD-ARTIFACT",
    noise_class: "build_artifact",
    rationale: "Writes to paths that were gitignored before the run (build outputs) during reported tool calls.",
    provenance: "pre-run .gitignore supplied in context.ignoredGlobs",
    principal: "tool_scope",
    kinds: WRITES,
    usesIgnoredGlobs: true,
  },
  {
    id: "NM-TEMP",
    noise_class: "temp_ephemeral",
    rationale: "Temp files created and deleted within the same scope and never touched by another scope.",
    provenance: "design section 5.3",
    principal: "agent_tree",
    kinds: RW,
    paths: ["tmp:**"],
    special: "temp_same_scope",
  },
  {
    id: "NM-CC-CONFIG-READ",
    noise_class: "agent_runtime_config_read",
    rationale: "At startup Claude Code reads its managed settings, the project memory (CLAUDE.md, CLAUDE.local.md), project settings under .claude/, and lists its home directory. Reads only: writes to any of these stay visible.",
    provenance: "OBSERVED: Tetragon capture of kw-agent:2.1.302 (Claude Code 2.1.302) in a verification run, 2026-10-17 (run_0f35977695caf7ddc25fcd65); paths doc-sourced (memory.md, settings.md)",
    principal: "agent_process",
    kinds: READS,
    paths: ["abs:/etc/claude-code/**", "ws:CLAUDE.md", "ws:**/CLAUDE.md", "ws:CLAUDE.local.md", "ws:.claude/settings.json", "ws:.claude/settings.local.json", "ws:.mcp.json", "home:"],
  },
  {
    id: "NM-CC-BUNDLED-TOOL",
    noise_class: "agent_runtime_bundled_tool",
    rationale: "The agent runtime runs its own bundled binary (claude.exe: --version probe, ripgrep file listing for its file index) as a direct child, outside any tool call. Only execs of a binary under the agent install root, spawned directly by the agent root, are classified; the same binary in a tool call's subtree is attributed normally.",
    provenance: "OBSERVED: Tetragon capture of kw-agent:2.1.302, 2026-10-17 (claude.exe --version, --no-config --files --hidden /workspace)",
    principal: "agent_tree",
    kinds: ["proc.exec"],
    special: "runtime_bundled_exec",
  },
  {
    id: "NM-CC-SHELL-SNAPSHOT",
    noise_class: "agent_runtime_shell_snapshot",
    rationale: "Before the first Bash call Claude Code probes `bash -c env` and runs a login shell (`bash -c -l \"SNAPSHOT_FILE=~/.claude/shell-snapshots/... \"`) whose children (env, id, grep, sed, awk, cat, head...) write the shell snapshot. Classifies those direct children of the agent root and their subtrees (execs, reads, and writes under ~/.claude/shell-snapshots/ only), never a process tied to a reported tool call.",
    provenance: "OBSERVED: Tetragon capture of kw-agent:2.1.302, 2026-10-17 (run_0f35977695caf7ddc25fcd65)",
    principal: "agent_tree",
    kinds: ["proc.exec", "file.read", "file.write"],
    special: "cc_shell_snapshot",
  },
  {
    id: "NM-MODEL-API",
    noise_class: "agent_model_api",
    rationale: "The agent runtime's own connections to the model API.",
    provenance: "UNVERIFIED: model endpoint host list (context.modelApiHosts)",
    principal: "agent_process",
    kinds: ["net.connect", "net.dns"],
    modelApiHosts: true,
  },
  {
    id: "NM-MODEL-API-PROXY",
    noise_class: "agent_model_api",
    rationale: "Proxy records to the model API host without process identity. Lower assurance: a tool subprocess calling the same host would also be classified here (policy evaluation still applies).",
    provenance: "UNVERIFIED: model endpoint host list; proxy cannot distinguish runtime from subprocess without a socket join",
    principal: "no_process_identity",
    kinds: ["net.connect", "net.dns"],
    modelApiHosts: true,
    sources: ["network_proxy"],
  },
];

export interface NoiseMatch {
  rule: NoiseRule;
}

export interface NoiseInputs {
  tree: ProcTree;
  ctx: AnalysisContext;
  attributions: Map<string, Attribution>;
  observations: LogicalObservation[];
}

function principalOk(rule: NoiseRule, o: LogicalObservation, a: Attribution | undefined, inp: NoiseInputs): boolean {
  switch (rule.principal) {
    case "any":
      return true;
    case "kw_instrumentation":
      return a?.scope === "kw_instrumentation";
    case "agent_process":
      return o.pid !== null && inp.tree.agentRoots.has(o.pid) && a?.scope !== "tool_call";
    case "agent_tree":
      return a?.scope === "tool_call" || a?.scope === "agent_runtime" || (a?.lineageToAgent ?? false);
    case "tool_scope":
      return a?.scope === "tool_call" && (a.state === "exact" || a.state === "probable");
    case "no_process_identity":
      return o.pid === null;
  }
}

function pathOk(patterns: string[], o: LogicalObservation, ctx: AnalysisContext): boolean {
  if (!o.path?.resolved) return false;
  const forms = [o.path.resolved, ...(o.path.absolute && o.path.absolute !== o.path.resolved ? [o.path.absolute] : [])];
  const expanded = patterns.flatMap((p) => (p.startsWith("{install_root}") ? ctx.agentInstallRoots.map((r) => "abs:" + r + p.slice("{install_root}".length)) : [p]));
  // every form must match: a symlink from a noise path to a sensitive path stays visible
  return forms.every((f) => expanded.some((p) => matchPathPattern(p, f, ctx, o.path!.caseFolded)));
}

const GIT_READONLY = new Set(["status", "log", "rev-parse", "branch", "remote", "show-ref", "symbolic-ref", "describe", "ls-files", "config", "diff", "show", "cat-file", "rev-list", "for-each-ref"]);

function scopeKey(a: Attribution | undefined): string {
  if (!a) return "?";
  return a.scope === "tool_call" ? `call:${a.toolUseId}` : a.scope;
}

/**
 * Observations grouped by canonical path key, built once per observation list (deterministic; the cache is keyed by
 * the array identity and holds no global state beyond that). Replaces a full scan per temp-path observation.
 */
const pathIndexCache = new WeakMap<readonly LogicalObservation[], Map<string, LogicalObservation[]>>();
function byPathKey(observations: readonly LogicalObservation[]): Map<string, LogicalObservation[]> {
  let idx = pathIndexCache.get(observations);
  if (!idx) {
    idx = new Map();
    for (const x of observations) {
      if (!x.path?.key) continue;
      const l = idx.get(x.path.key) ?? [];
      l.push(x);
      idx.set(x.path.key, l);
    }
    pathIndexCache.set(observations, idx);
  }
  return idx;
}

export function classifyNoise(o: LogicalObservation, a: Attribution | undefined, inp: NoiseInputs): NoiseMatch | null {
  const { ctx } = inp;
  for (const rule of NOISE_RULES) {
    if (!rule.kinds.includes(o.kind)) continue;
    if (!principalOk(rule, o, a, inp)) continue;
    if (rule.processNames) {
      const names = rule.processNames.flatMap((n) => (n === "{shell}" ? ctx.shellNames : [n]));
      const node = o.pid !== null ? inp.tree.nodes.get(o.pid) : undefined;
      const pn = basename(o.argv?.[0] ?? o.processName ?? node?.argv?.[0] ?? node?.name ?? "");
      if (!names.includes(pn)) continue;
    }
    if (rule.sources && !o.sources.every((s) => rule.sources!.includes(s))) continue;
    if (rule.errno && !(o.outcome.errno && rule.errno.includes(o.outcome.errno))) continue;
    if (rule.modelApiHosts && !(o.host && ctx.modelApiHosts.includes(o.host))) continue;
    if (rule.paths && !pathOk(rule.paths, o, ctx)) continue;
    if (rule.usesIgnoredGlobs) {
      if (o.path?.zone !== "ws" || o.path.zoneRel === null || !ctx.ignoredGlobs.some((g) => globMatchPath(g, o.path!.zoneRel!))) continue;
    }
    if (rule.except?.some((ex) => ex.kinds.includes(o.kind) && pathOk(ex.paths, o, ctx))) continue;
    if (rule.special === "runtime_bundled_exec") {
      if (a?.scope !== "agent_runtime" || a.chain.length !== 2 || !inp.tree.agentRoots.has(a.chain[1]!)) continue;
      const exe = o.argv?.[0] ?? o.processName ?? "";
      if (!ctx.agentInstallRoots.some((r) => exe.startsWith(r.replace(/\/$/, "") + "/"))) continue;
    }
    if (rule.special === "cc_shell_snapshot") {
      // Runtime work only: never a call the engine tied to a reported tool call (exact/probable); an "ambiguous"
      // time-only candidate is allowed because the snapshot shell starts in the first Bash call's window.
      if (!a || !ctx.homeDir || !(a.scope === "agent_runtime" || (a.scope === "tool_call" && a.state === "ambiguous"))) continue;
      const marker = `SNAPSHOT_FILE=${ctx.homeDir.replace(/\/$/, "")}/.claude/shell-snapshots/`;
      // the chain's process directly below the agent root is the snapshot login shell (or the runtime's `bash -c env` probe)
      const top = a.chain.length >= 2 && inp.tree.agentRoots.has(a.chain[a.chain.length - 1]!) ? a.chain[a.chain.length - 2]! : null;
      const isSnap = (pid: number | null) => {
        const n = pid !== null ? inp.tree.nodes.get(pid) : undefined;
        const argv = n?.argv ?? [];
        if (!ctx.shellNames.includes(basename(argv[0] ?? n?.name ?? ""))) return false;
        const ci = argv.indexOf("-c");
        if (ci < 0) return false;
        const script = argv.slice(ci + 1).find((x) => x !== "-l") ?? "";
        return script.trimStart().startsWith(marker) || script.trim() === "env";
      };
      const below = [top];
      if (!below.some(isSnap)) continue;
      if (o.kind === "file.write" && !pathOk(["home:.claude/shell-snapshots/**"], o, ctx)) continue;
    }
    if (rule.special === "git_readonly_subcommand") {
      // skip global options and their values (`git -c k=v -C /dir ls-files`), as Claude Code invokes git
      const args = o.argv?.slice(1) ?? [];
      let sub: string | undefined;
      for (let i = 0; i < args.length; i++) {
        const x = args[i]!;
        if (x === "-c" || x === "-C" || x === "--git-dir" || x === "--work-tree" || x === "--namespace") {
          i++;
          continue;
        }
        if (x === "--") break;
        if (!x.startsWith("-")) {
          sub = x;
          break;
        }
      }
      if (!sub || !GIT_READONLY.has(sub)) continue;
      if (sub === "config" && !o.argv?.includes("--get")) continue;
      if (a?.scope === "tool_call") continue; // only runtime context commands, not git run by a Bash call
    }
    if (rule.special === "temp_same_scope") {
      const same = (o.path?.key ? byPathKey(inp.observations).get(o.path.key) : undefined) ?? [];
      const keys = new Set(same.map((x) => scopeKey(inp.attributions.get(x.id))));
      const deleted = same.some((x) => x.kind === "file.delete" && x.outcome.value === "completed");
      if (keys.size !== 1 || !deleted) continue;
    }
    return { rule };
  }
  return null;
}

export const NOISE_MODEL = { version: NOISE_MODEL_VERSION, rules: NOISE_RULES } as const;
