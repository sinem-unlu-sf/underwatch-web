import { cmpStr, uniqSorted } from "./canonical";
import type { AnalysisContext } from "./context";
import { basename } from "./paths";
import { commandForms } from "./policy";
import { FILE_READ_TOOLS, FILE_WRITE_TOOLS, NET_TOOLS, SEARCH_TOOLS, SHELL_TOOLS } from "./reported";
import type { Attribution, Candidate, Diagnostic, LogicalObservation, MatchState, ReportedCall } from "./types";

// ---------------------------------------------------------------------------------------------------------------
// Process tree (observed edges only; fork parent as reported by the collector's process_exec record)

export interface ProcNode {
  pid: number;
  ppid: number | null;
  name: string | null;
  argv: string[] | null;
  command: string | null;
  firstT: number;
  execObservationId: string | null;
  edge: "observed" | "inferred" | "none";
}

export interface ProcTree {
  nodes: Map<number, ProcNode>;
  agentRoots: Set<number>;
  kwPids: Set<number>;
}

export function buildProcTree(observations: LogicalObservation[], ctx: AnalysisContext, diagnostics: Diagnostic[]): ProcTree {
  const nodes = new Map<number, ProcNode>();
  const execs = observations.filter((o) => o.kind === "proc.exec" && o.pid !== null).sort((a, b) => a.t - b.t || cmpStr(a.id, b.id));
  for (const o of execs) {
    const existing = nodes.get(o.pid!);
    if (!existing) {
      nodes.set(o.pid!, { pid: o.pid!, ppid: o.ppid, name: o.processName, argv: o.argv, command: o.command, firstT: o.t, execObservationId: o.id, edge: o.ppid !== null ? "observed" : "none" });
    } else if (existing.execObservationId !== null && existing.ppid !== null && o.ppid !== null && o.ppid !== existing.ppid) {
      diagnostics.push({ code: "agent_record_conflict", message: `pid ${o.pid} exec'd with different parents (${existing.ppid}, ${o.ppid}); possible pid reuse. First parent kept.`, event_ids: o.constituents });
    }
  }
  for (const o of [...observations].sort((a, b) => a.t - b.t || cmpStr(a.id, b.id))) {
    if (o.pid === null) continue;
    const n = nodes.get(o.pid);
    if (!n) nodes.set(o.pid, { pid: o.pid, ppid: o.ppid, name: o.processName, argv: null, command: null, firstT: o.t, execObservationId: null, edge: o.ppid !== null ? "inferred" : "none" });
    else if (n.ppid === null && o.ppid !== null) {
      n.ppid = o.ppid;
      n.edge = "inferred";
    }
  }
  const isAgentName = (n: ProcNode) => {
    const names = [n.name, n.argv?.[0], n.argv?.[1]].filter((x): x is string => !!x).map((x) => basename(x));
    return names.some((x) => ctx.agentProcessNames.includes(x));
  };
  let roots: number[];
  if (ctx.agentPids && ctx.agentPids.length) roots = [...ctx.agentPids];
  else roots = [...nodes.values()].filter(isAgentName).map((n) => n.pid);
  const rootSet = new Set(roots);
  // keep only top-most agent processes (an agent's own child named "claude" is not a new root)
  for (const r of [...rootSet]) {
    let p = nodes.get(r)?.ppid ?? null;
    const seen = new Set<number>([r]);
    while (p !== null && !seen.has(p)) {
      if (rootSet.has(p)) {
        rootSet.delete(r);
        break;
      }
      seen.add(p);
      p = nodes.get(p)?.ppid ?? null;
    }
  }
  if (rootSet.size === 0 && nodes.size > 0) {
    diagnostics.push({ code: "agent_root_unknown", message: "No agent root process identified (no exec of an agent process name and no launcher-provided pid). Process ancestry cannot be used for attribution.", event_ids: [] });
  }
  const kwPids = new Set([...nodes.values()].filter((n) => n.name && ctx.kwProcessNames.includes(basename(n.name))).map((n) => n.pid));
  // Registered hook commands: exact command line, spawned by the agent root (or by such a hook shell). Parents first.
  if (ctx.kwInstrumentationCommands.length > 0) {
    const want = new Set(ctx.kwInstrumentationCommands.map((c) => c.replace(/\s+/g, " ").trim()));
    const isHookCmd = (n: ProcNode) => {
      const argv = n.argv ?? [];
      const exe = basename(argv[0] ?? n.name ?? "");
      const line = [exe, ...argv.slice(1)].join(" ").replace(/\s+/g, " ").trim();
      if (want.has(line)) return true;
      return ctx.shellNames.includes(exe) && argv.length === 3 && argv[1] === "-c" && want.has(argv[2]!.replace(/\s+/g, " ").trim());
    };
    for (const n of [...nodes.values()].sort((a, b) => a.firstT - b.firstT || a.pid - b.pid)) {
      if (n.execObservationId === null || n.ppid === null || !isHookCmd(n)) continue;
      if (rootSet.has(n.ppid) || kwPids.has(n.ppid)) kwPids.add(n.pid);
    }
  }
  return { nodes, agentRoots: rootSet, kwPids };
}

/** Child-first chain of pids following observed/inferred parent edges. */
export function ancestry(tree: ProcTree, pid: number): { chain: number[]; broken: boolean; inferred: boolean } {
  const chain: number[] = [pid];
  const seen = new Set<number>([pid]);
  let inferred = false;
  let cur = tree.nodes.get(pid);
  while (cur) {
    if (cur.edge === "inferred") inferred = true;
    const p = cur.ppid;
    if (p === null || p === 0 || seen.has(p)) return { chain, broken: p === null, inferred };
    chain.push(p);
    seen.add(p);
    if (tree.agentRoots.has(p)) return { chain, broken: false, inferred };
    cur = tree.nodes.get(p);
    if (!cur) return { chain, broken: p !== 1, inferred };
  }
  return { chain, broken: true, inferred };
}

// ---------------------------------------------------------------------------------------------------------------
// Scoring (integer points; thresholds from the correlation-engine design section 4.4)

function stateFrom(cands: Candidate[], exactAllowed: boolean): MatchState {
  const s1 = cands[0]?.score ?? 0;
  const s2 = cands[1]?.score ?? 0;
  // exact also needs the timing to fall strictly inside the reported window: a match that relies on the skew
  // tolerance is at most probable (stands in for the design's "time domain must be D_K" condition).
  const t = cands[0] ? (cands[0].features.A2_temporal ?? cands[0].features.B2_temporal ?? cands[0].features.P2_temporal ?? 0) : 0;
  if (s1 >= 85 && s1 - s2 >= 30 && exactAllowed && t === 30) return "exact";
  if (s1 >= 60 && s1 - s2 >= 15) return "probable";
  if (s1 >= 60 || s1 >= 40) return "ambiguous";
  return "unmatched_observed";
}

function temporal(t: number, c: ReportedCall, skewUs: number): number {
  if (t >= c.start && t <= c.end) return 30;
  if (t >= c.start - skewUs && t <= c.end + skewUs) return 18;
  return 0;
}

function tokens(s: string): Set<string> {
  return new Set(s.split(/[\s'"`;|&()<>]+/).filter(Boolean));
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return Math.floor((inter * 100) / (a.size + b.size - inter));
}

const norm = (s: string) => s.replace(/\s+/g, " ").trim();

function sortCands(c: Candidate[], calls: Map<string, ReportedCall>): Candidate[] {
  return c.sort((a, b) => b.score - a.score || calls.get(a.toolUseId)!.start - calls.get(b.toolUseId)!.start || cmpStr(a.toolUseId, b.toolUseId));
}

/** Table A: bind a direct child of the agent (process anchor) to a Bash/Grep/Glob call. */
export function scoreProcessAnchor(node: ProcNode, calls: ReportedCall[], ctx: AnalysisContext): Candidate[] {
  const skew = ctx.clockSkewToleranceMs * 1000;
  const forms = commandForms(node.command, node.argv);
  const exe = basename(node.argv?.[0] ?? node.name ?? "");
  const isShell = ctx.shellNames.includes(exe);
  const out: Candidate[] = [];
  for (const c of calls) {
    if (!c.toolName) continue;
    let a3 = -1;
    if (SHELL_TOOLS.has(c.toolName)) a3 = isShell ? 20 : 10; // 10: `bash -c 'cmd'` may exec in place (UNVERIFIED, design A2)
    else if (SEARCH_TOOLS.has(c.toolName) && exe === "rg") a3 = 12;
    if (a3 < 0) continue;
    let a1 = 0;
    const cmd = c.target ? norm(c.target) : "";
    // The schema Event carries no argv; when the collector gave only the executable path, the command line is
    // UNKNOWN. Unknown is scored neutrally (25) instead of as a mismatch (0): absence of evidence is not contrary
    // evidence. A single shell child in the call's window then reaches "probable" (never "exact").
    const argvKnown = node.argv !== null || /\s/.test((node.command ?? "").trim());
    if (!argvKnown) a1 = 25;
    else if (cmd && forms.some((f) => f.includes(cmd))) a1 = 50;
    else if (cmd && forms.some((f) => jaccard(tokens(f), tokens(cmd)) >= 80)) a1 = 30;
    else if (cmd && basename(cmd.split(" ")[0] ?? "") === exe) a1 = 10;
    const a2 = temporal(node.firstT, c, skew);
    if (a2 === 0 && a1 < 50) continue;
    out.push({ toolUseId: c.toolUseId, score: a1 + a2 + a3, features: argvKnown ? { A1_command: a1, A2_temporal: a2, A3_type: a3 } : { A1_command: a1, A1_argv_unavailable: 1, A2_temporal: a2, A3_type: a3 } });
  }
  return out;
}

function resourceScore(o: LogicalObservation, c: ReportedCall): number {
  if (c.toolName && NET_TOOLS.has(c.toolName)) return o.host && c.host && o.host === c.host ? 50 : 0;
  if (!o.path || !c.path) return 0;
  if (c.toolName && SEARCH_TOOLS.has(c.toolName)) {
    const root = c.path.key;
    return root && o.path.key && (o.path.key === root || o.path.key.startsWith(root.replace(/\/$/, "") + "/")) ? 25 : 0;
  }
  if (o.path.key && o.path.key === c.path.key) return 50;
  const of = [o.path.absolute, o.path.resolved].filter(Boolean).map((x) => x!.toLowerCase());
  const cf = [c.path.absolute, c.path.resolved].filter(Boolean).map((x) => x!.toLowerCase());
  if (of.some((x) => cf.includes(x))) return 40;
  // Atomic-write sibling: Claude Code's Edit/Write write "<file>.tmp.<pid>.<hex>" and rename it over <file> (observed
  // with Tetragon, kw-agent:2.1.302). Only for write tools and write/delete footprints, and only the exact pattern.
  if (c.toolName && FILE_WRITE_TOOLS.has(c.toolName) && (o.kind === "file.write" || o.kind === "file.delete")) {
    const sib = of.map((x) => /^(.*)\.tmp\.\d+\.[0-9a-f]{6,}$/.exec(x)?.[1]).filter((x): x is string => !!x);
    if (sib.some((x) => cf.includes(x))) return 40;
  }
  return 0;
}

function opScore(o: LogicalObservation, c: ReportedCall): number {
  const t = c.toolName ?? "";
  if (FILE_READ_TOOLS.has(t)) return o.kind === "file.read" ? 20 : -1;
  if (FILE_WRITE_TOOLS.has(t)) return o.kind === "file.write" || o.kind === "file.delete" ? 20 : o.kind === "file.read" ? 10 : -1;
  if (SEARCH_TOOLS.has(t)) return o.kind === "file.read" ? 20 : -1;
  if (NET_TOOLS.has(t)) return o.kind === "net.connect" || o.kind === "net.dns" ? 20 : -1;
  return -1;
}

/** Table B: actions performed by the agent process itself (in-process file tools, WebFetch). */
export function scoreInProcess(o: LogicalObservation, calls: ReportedCall[], ctx: AnalysisContext): Candidate[] {
  const skew = ctx.clockSkewToleranceMs * 1000;
  const out: Candidate[] = [];
  for (const c of calls) {
    const b1 = resourceScore(o, c);
    if (b1 === 0) continue;
    const b2 = temporal(o.t, c, skew);
    if (b2 === 0) continue;
    const b3 = opScore(o, c);
    if (b3 < 0) continue;
    out.push({ toolUseId: c.toolUseId, score: b1 + b2 + b3, features: { B1_resource: b1, B2_temporal: b2, B3_op: b3 } });
  }
  return out;
}

function mentions(command: string, o: LogicalObservation): boolean {
  const toks = tokens(command);
  const words: string[] = [];
  if (o.path) {
    for (const p of [o.path.absolute, o.path.resolved, o.path.zoneRel, o.path.raw]) if (p) words.push(p);
    if (o.path.absolute) words.push(basename(o.path.absolute));
  }
  if (o.host) words.push(o.host);
  return words.some((w) => toks.has(w) || [...toks].some((t) => t.endsWith("/" + w) || t.includes(w + ":") || t.includes("//" + w)));
}

/**
 * Table P (no process identity: file watcher, proxy without a socket join, records whose lineage is unknown).
 * Never exact: without process identity the action cannot be tied to the agent tree with certainty. Capped at 84
 * (probable) with a resource link and at 59 (below probable) when only time links it. DEVIATION: the design caps every
 * un-joined proxy record at 59; here a resource link (same path/host as the call's target) can reach probable.
 */
export function scoreNoIdentity(o: LogicalObservation, calls: ReportedCall[], ctx: AnalysisContext): Candidate[] {
  const skew = ctx.clockSkewToleranceMs * 1000;
  const out: Candidate[] = [];
  for (const c of calls) {
    if (!c.toolName) continue;
    const t = temporal(o.t, c, skew);
    if (t === 0) continue;
    let r = 0;
    let op = 0;
    if (SHELL_TOOLS.has(c.toolName)) {
      r = c.target && mentions(c.target, o) ? 25 : 0;
      op = 10;
    } else {
      r = resourceScore(o, c);
      op = opScore(o, c);
      if (op < 0) continue;
    }
    const raw = r + t + op;
    const score = Math.min(raw, r > 0 ? 84 : 59);
    out.push({ toolUseId: c.toolUseId, score, features: { P1_resource: r, P2_temporal: t, P3_op: op, cap: r > 0 ? 84 : 59 } });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------

export interface AttributionOutput {
  attributions: Map<string, Attribution>;
  /** pid of process anchors -> binding */
  anchorBindings: Map<number, { candidates: Candidate[]; state: MatchState }>;
}

export function attributeAll(
  observations: LogicalObservation[],
  calls: ReportedCall[],
  tree: ProcTree,
  ctx: AnalysisContext,
  diagnostics: Diagnostic[],
): AttributionOutput {
  const callsById = new Map(calls.map((c) => [c.toolUseId, c]));
  const anchorBindings = new Map<number, { candidates: Candidate[]; state: MatchState }>();
  const bind = (pid: number) => {
    const hit = anchorBindings.get(pid);
    if (hit) return hit;
    const node = tree.nodes.get(pid)!;
    const cands = sortCands(scoreProcessAnchor(node, calls, ctx), callsById);
    const b = { candidates: cands, state: stateFrom(cands, true) };
    anchorBindings.set(pid, b);
    return b;
  };
  const out = new Map<string, Attribution>();
  const unknownIds = new Set<string>();
  for (const o of observations) {
    if (o.kind === "fs.change") continue; // final-state records are attributed by the change-mismatch rule
    const base = { observationId: o.id, candidates: [] as Candidate[], chain: [] as number[], note: null as string | null, anchorPid: null as number | null };
    if (o.toolUseId && callsById.has(o.toolUseId)) {
      out.set(o.id, { ...base, scope: "tool_call", toolUseId: o.toolUseId, state: "exact", method: "tool_use_id", score: 100, lineageToAgent: null, candidates: [{ toolUseId: o.toolUseId, score: 100, features: { tool_use_id: 100 } }] });
      continue;
    }
    if (o.toolUseId && !callsById.has(o.toolUseId)) unknownIds.add(o.toolUseId);
    const hasTree = tree.agentRoots.size > 0;
    if (o.pid !== null && hasTree) {
      const { chain, broken, inferred } = ancestry(tree, o.pid);
      const agentIdx = chain.findIndex((p) => tree.agentRoots.has(p));
      if (chain.some((p) => tree.kwPids.has(p))) {
        out.set(o.id, { ...base, chain, scope: "kw_instrumentation", toolUseId: null, state: "unmatched_observed", method: "identity", score: 0, lineageToAgent: agentIdx >= 0, note: "Underwatch instrumentation process" });
        continue;
      }
      if (agentIdx === 0) {
        const cands = sortCands(scoreInProcess(o, calls, ctx), callsById);
        const state = stateFrom(cands, true);
        if (state === "unmatched_observed") {
          out.set(o.id, { ...base, chain, candidates: cands, scope: "agent_runtime", toolUseId: null, state, method: "none", score: cands[0]?.score ?? 0, lineageToAgent: true, note: "performed by the agent process itself; no reported call explains it" });
        } else {
          out.set(o.id, { ...base, chain, candidates: cands, scope: "tool_call", toolUseId: cands[0]!.toolUseId, state, method: "resource_time", score: cands[0]!.score, lineageToAgent: true });
        }
        continue;
      }
      if (agentIdx >= 1) {
        const anchor = chain[agentIdx - 1]!;
        base.anchorPid = anchor;
        const b = bind(anchor);
        let state = b.state;
        if (inferred && state === "exact") state = "probable"; // lineage relies on an inferred edge: one level down
        const method = anchor === o.pid ? "command_binding" : "process_ancestry";
        if (state === "unmatched_observed") {
          out.set(o.id, { ...base, chain, candidates: b.candidates, scope: "agent_runtime", toolUseId: null, state, method: "process_ancestry", score: b.candidates[0]?.score ?? 0, lineageToAgent: true, note: `descendant of agent child pid ${anchor}, which no reported call explains` });
        } else {
          out.set(o.id, { ...base, chain, candidates: b.candidates, scope: "tool_call", toolUseId: b.candidates[0]!.toolUseId, state, method, score: b.candidates[0]!.score, lineageToAgent: true, note: inferred ? "lineage includes an inferred parent edge" : null });
        }
        continue;
      }
      if (!broken) {
        out.set(o.id, { ...base, chain, scope: "external", toolUseId: null, state: "unmatched_observed", method: "process_ancestry", score: 0, lineageToAgent: false, note: "process does not descend from the agent root" });
        diagnostics.push({ code: "external_process", message: `pid ${o.pid} does not descend from the agent root but was observed in the run.`, event_ids: o.constituents });
        continue;
      }
      // lineage broken: fall through to identity-free scoring
      base.chain = chain;
      base.note = "process lineage incomplete (parent not observed)";
    }
    const cands = sortCands(scoreNoIdentity(o, calls, ctx), callsById);
    const state = stateFrom(cands, false);
    if (state === "unmatched_observed") {
      out.set(o.id, { ...base, candidates: cands, scope: "unattributed", toolUseId: null, state, method: "none", score: cands[0]?.score ?? 0, lineageToAgent: null });
    } else {
      const method = (cands[0]!.features.P1_resource ?? 0) > 0 ? "resource_time" : "time_window";
      out.set(o.id, { ...base, candidates: cands, scope: "tool_call", toolUseId: cands[0]!.toolUseId, state, method, score: cands[0]!.score, lineageToAgent: null });
    }
  }
  for (const id of [...unknownIds].sort(cmpStr)) {
    diagnostics.push({ code: "unknown_tool_use_id", message: `Observed records carry tool_use_id ${id}, which no agent-reported record contains.`, event_ids: uniqSorted(observations.filter((o) => o.toolUseId === id).flatMap((o) => o.constituents)) });
  }
  return { attributions: out, anchorBindings };
}

/** Required (primary) footprint kind of a reported call. null = no observable footprint expected. */
export function primaryKind(toolName: string | null): "file.read" | "file.write" | "proc.exec" | "net.connect" | null {
  if (!toolName) return null;
  if (FILE_READ_TOOLS.has(toolName)) return "file.read";
  if (FILE_WRITE_TOOLS.has(toolName)) return "file.write";
  if (SHELL_TOOLS.has(toolName)) return "proc.exec";
  if (NET_TOOLS.has(toolName)) return "net.connect";
  return null;
}
