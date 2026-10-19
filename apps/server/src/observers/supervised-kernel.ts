/**
 * Kernel observer (Tetragon) for LIVE SUPERVISED runs: turns one KernelObservation of the agent container into
 *  - schema Event rows for EVERY normalized Tetragon event (basis observed, source kernel_tracer, lineage in summary),
 *  - the analysis input subset: only events of the agent runtime and its descendants (by Tetragon exec_id lineage),
 *  - EventDetails (argv, cwd, errno, resolved path, process start time) for @kw/analysis,
 *  - the agent root pid(s) for process-tree attribution,
 *  - a CoverageReport fragment that says exactly what was and was not observed.
 *
 * Harness processes in the same container (the start-gate shell and its `sleep`s, the `docker exec touch` that opens
 * the gate, the per-run isolation self-test, the image entrypoint's `claude --version` probe) are stored like every
 * other observed event but are NOT given to the analysis as agent actions: none of them descends from the agent
 * runtime's exec. Pure: no I/O.
 */
import type { CoverageCategoryEntry, CoverageSourceEntry, Event, Evidence } from "@kw/schema";
import type { EventDetails } from "@kw/analysis";
import type { CaptureResult } from "@kw/observer-tetragon";
import { toEventRow } from "./ingest";
import type { KernelObservation } from "./tetragon-run";

type KEvent = CaptureResult["events"][number];

const base = (b: string | null | undefined) => (b ? b.split("/").pop() || b : "");

/**
 * Tetragon's process.args is ONE string (arguments joined by spaces; arguments containing spaces are wrapped in
 * double quotes, inner quotes are NOT escaped). Best-effort split: whitespace outside quotes; a quote opens a group
 * only at the start of a token and closes at a quote followed by whitespace or the end (for a shell's trailing
 * `-c "<script>"`: at the last quote). Lossy for other args that contain `" ` sequences; the raw string stays in the
 * event summary and the host-side slice.
 */
export function splitTetragonArgs(args: string | null): string[] {
  if (!args) return [];
  const out: string[] = [];
  let i = 0;
  const s = args;
  while (i < s.length) {
    while (i < s.length && /\s/.test(s[i]!)) i++;
    if (i >= s.length) break;
    if (s[i] === '"') {
      let j = i + 1;
      // A shell's `-c "<script>"` is the last argument and its script may contain `" ` itself: take it to the last quote.
      const prev = out[out.length - 1];
      if ((prev === "-c" || (prev === "-l" && out[out.length - 2] === "-c")) && s.trimEnd().endsWith('"')) j = s.trimEnd().length - 1;
      else while (j < s.length && !(s[j] === '"' && (j + 1 === s.length || /\s/.test(s[j + 1]!)))) j++;
      out.push(s.slice(i + 1, j));
      i = j + 1;
    } else {
      let j = i;
      while (j < s.length && !/\s/.test(s[j]!)) j++;
      out.push(s.slice(i, j));
      i = j;
    }
  }
  return out;
}

const ERRNO: Record<number, string> = { 1: "EPERM", 2: "ENOENT", 13: "EACCES", 20: "ENOTDIR", 21: "EISDIR", 30: "EROFS" };

/** Exec ids of the agent runtime root(s): `claude` execs that do not descend from another claude and are not a `--version` probe. */
export function agentRootExecIds(events: readonly KEvent[]): Set<string> {
  const roots = new Set<string>();
  for (const e of events) {
    if (e.kw_type !== "process.exec") continue;
    const p = e.tetragon.process;
    if (base(p.binary) !== "claude" || !p.exec_id) continue;
    if (/^\s*--version\b/.test(p.args ?? "")) continue;
    if (e.tetragon.ancestry.some((a) => base(a.binary) === "claude")) continue;
    roots.add(p.exec_id);
  }
  return roots;
}

export interface SupervisedKernelOutput {
  /** Every normalized Tetragon event as a schema row (stored). */
  rows: Event[];
  /** Subset handed to @kw/analysis (agent runtime + descendants). */
  analysisEvents: Event[];
  details: Record<string, EventDetails>;
  agentPids: number[];
  evidence: Evidence;
  harnessEvents: number;
  lossy: boolean;
}

export function kernelForSupervised(obs: KernelObservation | null | undefined): SupervisedKernelOutput | null {
  const cap = obs?.status === "captured" ? obs.capture : null;
  if (!cap) return null;
  const roots = agentRootExecIds(cap.events);
  const rows: Event[] = [];
  const analysisEvents: Event[] = [];
  const details: Record<string, EventDetails> = {};
  const agentPids = new Set<number>();
  let harness = 0;
  for (const e of cap.events) {
    const row = toEventRow(e);
    rows.push(row);
    const p = e.tetragon.process;
    const own = p.exec_id !== null && roots.has(p.exec_id);
    const agentTree = own || e.tetragon.ancestry.some((a) => roots.has(a.exec_id));
    if (!agentTree) {
      harness++;
      continue;
    }
    if (own && e.kw_type === "process.exec" && p.pid !== null) agentPids.add(p.pid);
    analysisEvents.push(row);
    const d: EventDetails = { cwd: p.cwd, process_start_time: p.start_time };
    if (e.kw_type === "process.exec") d.argv = [p.binary ?? "?", ...splitTetragonArgs(p.args)];
    if (e.tetragon.file) {
      d.resolved_path = e.tetragon.file.path;
      const rc = e.tetragon.file.return_code;
      if (rc !== null && rc < 0) d.errno = ERRNO[-rc] ?? `errno ${-rc}`;
    }
    if (e.tetragon.enforcement) {
      d.enforcement_rule_id = e.tetragon.enforcement.policy_name;
      d.errno = e.tetragon.enforcement.errno;
    }
    if (e.tetragon.exit) {
      d.exit_code = e.tetragon.exit.status;
      d.signal = e.tetragon.exit.signal;
    }
    if (e.tetragon.net) {
      d.host = e.tetragon.net.daddr;
      d.port = e.tetragon.net.dport;
    }
    details[row.id] = d;
  }
  return { rows, analysisEvents, details, agentPids: [...agentPids].sort((a, b) => a - b), evidence: cap.evidence, harnessEvents: harness, lossy: cap.stats.lossy === true };
}

/**
 * Coverage entries for the supervised CoverageReport: kernel_tracer source + process_execution / file_access /
 * file_modification / network categories from the Tetragon fragment (LOSSY-labeled by the fragment when loss
 * counters rose), or explicit "unavailable" entries naming why there is no kernel observation.
 */
export function supervisedKernelCoverage(obs: KernelObservation | null | undefined): {
  source: CoverageSourceEntry;
  categories: CoverageCategoryEntry[];
  unsupported: string[];
  limitations: string[];
} {
  const cap = obs?.status === "captured" ? obs.capture : null;
  if (!cap) {
    const why = !obs ? "kernel observer not attached to this run" : obs.reason ?? (obs.errors.join("; ") || obs.status);
    return {
      source: { source: "kernel_tracer", active: false, categories: [], attribution_available: false, errors: [`Kernel observation unavailable: ${why}`] },
      categories: [
        { category: "process_execution", status: "unavailable", note: `Kernel observation unavailable (${why}). Commands are known only from the agent's own Bash tool records.` },
        { category: "file_access", status: "unavailable", note: `Kernel observation unavailable (${why}). File reads are known only from agent tool records and the host-side canary scan.` },
      ],
      unsupported: ["Process execution and file-open syscalls were NOT observed in this run (kernel observer unavailable)."],
      limitations: [`Kernel observer (Tetragon) unavailable for this run: ${why}. Process execution and file access are not independently observed (coverage marked unavailable).`],
    };
  }
  const frag = cap.coverage.report;
  const src = frag.sources.find((s) => s.source === "kernel_tracer") ?? { source: "kernel_tracer" as const, active: true, categories: [], attribution_available: true, errors: [] };
  const errs = [...src.errors, ...(obs!.errors ?? [])];
  const gate = obs!.gate;
  const s = cap.stats;
  return {
    source: { ...src, errors: errs },
    categories: frag.categories.filter((c) => c.category !== "network"),
    unsupported: frag.unsupported_capabilities ?? [],
    limitations: [
      `Kernel observer (Tetragon ${obs!.health?.tetragon_server_version ?? "?"}, kernel ${obs!.health?.kernel_version ?? "?"}) attached to the agent container before it started: ${cap.events.length} observed events (${Object.entries(s.by_type).map(([k, v]) => `${k} ${v}`).join(", ")}); raw slice sha256 ${cap.sha256} kept host-side.`,
      `Start gate: ${gate.held ? `the agent entrypoint was held until attach() returned${gate.released_at ? ` (released ${gate.released_at})` : ""}` : "not held"}. The gate shell, its sleeps and the release exec are harness processes; they are stored but not attributed to the agent.`,
      "Kernel evidence establishes process exec/lineage, file opens and read()/write() permission checks on policy-selected paths, and TCP connect attempts. It does NOT establish file content read, bytes sent, or mmap-only reads.",
      ...(s.lossy ? [`LOSSY capture: Tetragon loss counters rose during the run (VM-wide): ${JSON.stringify(s.kernel_loss)}. Events may be missing; absence of an event proves nothing.`] : []),
      ...(s.kernel_loss === null ? ["Tetragon loss counters could not be read for this capture: completeness is unknown."] : []),
      ...(s.isolation_violations.length ? [`Observer isolation violations at attach: ${s.isolation_violations.join("; ")}.`] : []),
      ...obs!.errors.map((e) => `Kernel observer error: ${e}`),
    ],
  };
}
