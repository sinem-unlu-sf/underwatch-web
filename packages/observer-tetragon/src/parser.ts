import { makeEventId, type Event, type EventType, type Outcome } from "@kw/schema";
import { redact } from "@kw/redaction";

/**
 * Tetragon JSON export -> normalized Underwatch events.
 *
 * Every event is basis "observed". @kw/schema's EventSource enum has no "tetragon" literal, so the schema-level
 * source is "kernel_tracer" and `observer: "tetragon"` names the concrete collector.
 */
export const SCHEMA_SOURCE = "kernel_tracer" as const;
export const OBSERVER_ID = "tetragon" as const;

export type KwType = "process.exec" | "process.exit" | "file.open" | "file.read" | "file.write" | "file.rename" | "file.link" | "net.connect" | "raw";

export interface ProcInfo {
  exec_id: string | null;
  parent_exec_id: string | null;
  pid: number | null;
  tid: number | null;
  uid: number | null;
  binary: string | null;
  /** Redacted (secret detectors from @kw/redaction) and truncated to 2000 chars. Raw args stay in the slice file. */
  args: string | null;
  cwd: string | null;
  start_time: string | null;
  /** Tetragon's docker field: the container id TRUNCATED to 31 hex chars. null = not in a container. */
  docker: string | null;
  flags: string | null;
}

export interface EnforcementRef {
  policy_name: string;
  policy_sha256: string;
  mechanism: string;
  action: string;
  errno: "EPERM";
}

export interface TetragonDetail {
  record_type: string;
  function_name: string | null;
  policy_name: string | null;
  action: string | null;
  /** Tetragon's nanosecond event time (string, kept verbatim). */
  time: string;
  node_name: string | null;
  process: ProcInfo;
  parent: ProcInfo | null;
  file: {
    path: string;
    permission: string | null;
    /** security_file_permission mask: 4 MAY_READ, 2 MAY_WRITE (others kept numerically). */
    mask: number | null;
    return_code: number | null;
  } | null;
  net: {
    family: string | null;
    protocol: string | null;
    saddr: string | null;
    sport: number | null;
    daddr: string | null;
    dport: number | null;
    state: string | null;
  } | null;
  exit: { status: number | null; signal: string | null } | null;
  enforcement: EnforcementRef | null;
  /** Set on file.open kprobe events that failed because one of OUR enforcement policies fired (process_lsm twin). */
  linked_enforcement_event_id: string | null;
  /** Number of adjacent identical file.open records collapsed into this one (overlayfs fires the hook twice). */
  overlay_duplicates: number;
  /** Ancestors inside the container, nearest first (filled by normalizeSlice). */
  ancestry: Array<{ exec_id: string; pid: number | null; binary: string | null; args: string | null }>;
  /** 1-based line number in the per-run slice file. */
  line_no: number;
  /**
   * For kw_type "raw": the unparsed record as JSON text, passed through @kw/redaction and truncated to 4000 chars
   * (null for lines that were not valid JSON). The unredacted line stays in the host-only slice at line_no.
   */
  raw: string | null;
}

export type TetragonObservedEvent = Event & {
  observer: typeof OBSERVER_ID;
  kw_type: KwType;
  tetragon: TetragonDetail;
};

export interface ParseContext {
  runId: string;
  /** Slice evidence record id, if the caller has one. */
  evidenceId?: string | null;
  /** OUR enforcement policies by name (see readEnforcementRegistry). Anything else is not "blocked". */
  enforcementPolicies?: Record<string, { policy_sha256: string; mechanism?: string }>;
  /** Capture time used for records that carry no timestamp (invalid JSON). */
  fallbackTime?: string;
}

type J = Record<string, unknown>;
const isObj = (v: unknown): v is J => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && /^-?\d+$/.test(v) ? Number(v) : null);

export function redactText(s: string | null, max = 2000): string | null {
  if (s === null) return null;
  const r = redact(s).text;
  return r.length > max ? r.slice(0, max) + "…[truncated]" : r;
}

function proc(p: unknown): ProcInfo {
  const o = isObj(p) ? p : {};
  return {
    exec_id: str(o.exec_id),
    parent_exec_id: str(o.parent_exec_id),
    pid: num(o.pid),
    tid: num(o.tid),
    uid: num(o.uid),
    binary: str(o.binary),
    args: redactText(str(o.arguments)),
    cwd: str(o.cwd),
    start_time: str(o.start_time),
    docker: str(o.docker),
    flags: str(o.flags),
  };
}

/** Tetragon truncates container ids (31 hex chars observed). Match by prefix in either direction, minimum 12 chars. */
export function containerIdMatches(tetragonDocker: string | null | undefined, containerId: string): boolean {
  if (!tetragonDocker || tetragonDocker.length < 12) return false;
  const a = tetragonDocker.toLowerCase();
  const b = containerId.toLowerCase();
  return b.startsWith(a) || (b.length >= 12 && a.startsWith(b));
}

const RECORD_TYPES = ["process_exec", "process_exit", "process_kprobe", "process_lsm"] as const;

function recordType(rec: J): string | null {
  for (const k of Object.keys(rec)) if (k !== "time" && k !== "node_name" && isObj(rec[k])) return k;
  return null;
}

/** Container id of a raw Tetragon record (process.docker), or null. Cheap enough for per-line filtering. */
export function recordDocker(rec: unknown): string | null {
  if (!isObj(rec)) return null;
  const t = recordType(rec);
  if (!t) return null;
  const body = rec[t] as J;
  return isObj(body.process) ? str(body.process.docker) : null;
}

/** Tetragon nanosecond ISO time -> millisecond ISO accepted everywhere (the ns string is kept in tetragon.time). */
function msTime(t: string): string {
  const d = new Date(t);
  return Number.isNaN(d.getTime()) ? t : d.toISOString();
}

const ERRNO: Record<number, string> = { 1: "EPERM", 2: "ENOENT", 13: "EACCES", 30: "EROFS" };
const errnoName = (rc: number) => ERRNO[-rc] ?? `errno ${-rc}`;

interface Draft {
  kw_type: KwType;
  event_type: EventType;
  outcome: Outcome;
  target: string | null;
  summary: string;
  limitations: string[];
  unavailable: string[];
  collection: Event["collection_status"];
  detail: Omit<TetragonDetail, "line_no" | "ancestry" | "overlay_duplicates" | "linked_enforcement_event_id" | "raw">;
  keyTail: string;
}

const L_OPEN = "A successful open does not establish that file contents were read.";
const L_RW =
  "security_file_permission fires when read()/write() is called, before data moves: it does not establish bytes read/written. mmap() access is not observed by this hook. On overlayfs each call is reported twice.";
const L_NET = "tcp_connect fires when the SYN is sent: it does not establish that the handshake completed or that any data was transferred.";
const L_SCOPE = "Only paths selected by the kw-observe-files policy are observed; absence of a file event is not proof of no access.";

function draft(rec: J, t: string, ctx: ParseContext): Draft | null {
  const body = rec[t] as J;
  const p = proc(body.process);
  const parent = isObj(body.parent) ? proc(body.parent) : null;
  const time = str(rec.time) ?? str(p.start_time) ?? ctx.fallbackTime ?? new Date(0).toISOString();
  const base = {
    record_type: t,
    function_name: str(body.function_name),
    policy_name: str(body.policy_name),
    action: str(body.action),
    time,
    node_name: str(rec.node_name),
    process: p,
    parent,
    file: null,
    net: null,
    exit: null,
    enforcement: null,
  } satisfies Draft["detail"];
  const who = `${p.binary ?? "?"}[${p.pid ?? "?"}]`;
  const unavailable: string[] = [];
  if (p.pid === null) unavailable.push("process_id");
  if (!parent || parent.pid === null) unavailable.push("parent_process_id");
  if (p.binary === null) unavailable.push("process_name");

  if (t === "process_exec") {
    return {
      kw_type: "process.exec",
      event_type: "process_exec",
      outcome: "succeeded",
      target: p.binary,
      summary: `exec ${p.binary ?? "?"} ${p.args ?? ""}`.trim() + ` (pid ${p.pid ?? "?"}, parent ${parent?.binary ?? "?"})`,
      limitations: [],
      unavailable,
      collection: unavailable.length ? "partial" : "complete",
      detail: base,
      keyTail: "",
    };
  }
  if (t === "process_exit") {
    const status = num(body.status);
    const signal = str(body.signal);
    return {
      kw_type: "process.exit",
      event_type: "process_exit",
      outcome: signal ? "failed" : status === 0 || status === null ? "succeeded" : "failed",
      target: p.binary,
      summary: `exit ${who}` + (signal ? ` signal ${signal}` : ` status ${status ?? 0}`),
      limitations: [],
      unavailable,
      collection: unavailable.length ? "partial" : "complete",
      detail: { ...base, exit: { status: status ?? 0, signal } },
      keyTail: "",
    };
  }
  if (t !== "process_kprobe" && t !== "process_lsm") return null;

  const args = Array.isArray(body.args) ? (body.args as unknown[]) : [];
  const fileArg = args.map((a) => (isObj(a) && isObj(a.file_arg) ? a.file_arg : null)).find((x) => x) ?? null;
  const pathArg = args.map((a) => (isObj(a) && isObj(a.path_arg) ? a.path_arg : null)).find((x) => x) ?? null;
  const sockArg = args.map((a) => (isObj(a) && isObj(a.sock_arg) ? a.sock_arg : null)).find((x) => x) ?? null;
  const intArgs = args.map((a) => (isObj(a) ? num(a.int_arg) : null)).filter((x): x is number => x !== null);
  const ret = isObj(body.return) ? num(body.return.int_arg) : null;
  const fn = base.function_name ?? "";
  const action = base.action ?? "";
  const ours = base.policy_name ? ctx.enforcementPolicies?.[base.policy_name] : undefined;
  const enforcing = action === "KPROBE_ACTION_OVERRIDE" || action === "KPROBE_ACTION_SIGKILL";

  if (fileArg && (fn === "security_file_open" || fn === "file_open" || fn === "security_file_permission")) {
    const path = str(fileArg.path) ?? "?";
    const mask = fn === "security_file_permission" ? (intArgs[0] ?? null) : null;
    const kw: KwType = fn === "security_file_permission" ? (mask === 2 ? "file.write" : mask === 4 ? "file.read" : "file.read") : "file.open";
    const limitations = [kw === "file.open" ? L_OPEN : L_RW, L_SCOPE];
    let outcome: Outcome;
    let enforcement: EnforcementRef | null = null;
    let verdict: string;
    // "blocked" requires: a BPF-LSM record, the Override action, and a policy in OUR enforcement registry.
    if (ours && t === "process_lsm" && action === "KPROBE_ACTION_OVERRIDE") {
      outcome = "blocked";
      enforcement = {
        policy_name: base.policy_name!,
        policy_sha256: ours.policy_sha256,
        mechanism: ours.mechanism ?? "tetragon.lsm.file_open.override",
        action,
        errno: "EPERM",
      };
      verdict = `BLOCKED by ${base.policy_name} (EPERM)`;
    } else if (enforcing) {
      outcome = "failed";
      limitations.push(`Action ${action} came from policy ${base.policy_name ?? "?"}, which is not a Underwatch enforcement policy.`);
      verdict = `failed (${action} by non-KW policy ${base.policy_name ?? "?"})`;
    } else if (ret === null) {
      outcome = "attempted";
      verdict = "attempted (no return value)";
    } else if (ret < 0) {
      outcome = "failed";
      verdict = `failed ${errnoName(ret)}`;
    } else {
      outcome = kw === "file.open" ? "succeeded" : "allowed";
      verdict = kw === "file.open" ? "succeeded" : "permission check passed";
    }
    if (mask !== null && mask !== 2 && mask !== 4) limitations.push(`Permission mask ${mask} is neither MAY_READ(4) nor MAY_WRITE(2); classified as file.read.`);
    const verb = kw === "file.open" ? "open" : kw === "file.write" ? "write()" : "read()";
    const unavail = [...unavailable];
    if (kw === "file.open") unavail.push("open_flags");
    return {
      kw_type: kw,
      event_type: kw === "file.open" ? "file_open" : kw === "file.write" ? "file_write" : "file_read",
      outcome,
      target: path,
      summary: `${who} ${verb} ${path}: ${verdict}`,
      limitations,
      unavailable: unavail,
      collection: "partial",
      detail: { ...base, file: { path, permission: str(fileArg.permission), mask, return_code: ret }, enforcement },
      keyTail: `${fn}:${path}:${mask ?? ""}`,
    };
  }
  if (pathArg && (fn === "inode_rename" || fn === "inode_link")) {
    // Only emitted by our enforcement policy's rename/link guard (dentry path, relative to the mount root).
    const path = str(pathArg.path) ?? "?";
    const kw: KwType = fn === "inode_rename" ? "file.rename" : "file.link";
    const isBlocked = !!ours && t === "process_lsm" && action === "KPROBE_ACTION_OVERRIDE";
    const limitations = [
      "Path is the dentry path relative to its mount root (for bind mounts it lacks the mount point prefix).",
      "Only renames/links of protected names are hooked (enforcement rename guard); other renames are not observed.",
    ];
    if (!isBlocked && enforcing) limitations.push(`Action ${action} came from policy ${base.policy_name ?? "?"}, which is not a Underwatch enforcement policy.`);
    return {
      kw_type: kw,
      event_type: fn === "inode_rename" ? "file_rename" : "file_create",
      outcome: isBlocked ? "blocked" : enforcing ? "failed" : "attempted",
      target: path,
      summary: `${who} ${fn === "inode_rename" ? "rename" : "hard link"} ${path}: ${isBlocked ? `BLOCKED by ${base.policy_name} (EPERM)` : enforcing ? "failed" : "attempted"}`,
      limitations,
      unavailable: [...unavailable, "destination_path"],
      collection: "partial",
      detail: {
        ...base,
        file: { path, permission: str(pathArg.permission), mask: null, return_code: null },
        enforcement: isBlocked
          ? { policy_name: base.policy_name!, policy_sha256: ours!.policy_sha256, mechanism: ours!.mechanism ?? "tetragon.lsm.override", action, errno: "EPERM" }
          : null,
      },
      keyTail: `${fn}:${path}`,
    };
  }
  if (sockArg && fn === "tcp_connect") {
    const net = {
      family: str(sockArg.family),
      protocol: str(sockArg.protocol),
      saddr: str(sockArg.saddr),
      sport: num(sockArg.sport),
      daddr: str(sockArg.daddr),
      dport: num(sockArg.dport),
      state: str(sockArg.state),
    };
    const target = `${net.daddr ?? "?"}:${net.dport ?? "?"}`;
    const limitations = [L_NET, "Destination is an IP address; the hostname (if any) is not established by this event."];
    let outcome: Outcome = "attempted";
    if (enforcing) {
      outcome = "failed";
      limitations.push(`Action ${action} by policy ${base.policy_name ?? "?"} (not a Underwatch file enforcement policy).`);
    }
    return {
      kw_type: "net.connect",
      event_type: "network_connect",
      outcome,
      target,
      summary: `${who} tcp connect -> ${target} (${net.state ?? "?"}): ${outcome}`,
      limitations,
      unavailable: [...unavailable, "bytes_transferred", "connection_result"],
      collection: "partial",
      detail: { ...base, net },
      keyTail: `${fn}:${net.saddr}:${net.sport}:${target}`,
    };
  }
  return null;
}

function finish(d: Draft, ctx: ParseContext, lineNo: number): TetragonObservedEvent {
  const p = d.detail.process;
  const key = `tetragon:${p.exec_id ?? "noexec"}:${d.kw_type}:${d.detail.time}:${d.keyTail}`;
  return {
    id: makeEventId({ run_id: ctx.runId, basis: "observed", source: SCHEMA_SOURCE, source_native_key: key }),
    run_id: ctx.runId,
    is_fixture: false,
    basis: "observed",
    source: SCHEMA_SOURCE,
    source_native_key: key,
    source_sequence: lineNo,
    event_type: d.event_type,
    timestamp: msTime(d.detail.time),
    process_id: p.pid !== null && p.pid >= 0 ? p.pid : null,
    parent_process_id: d.detail.parent?.pid ?? null,
    process_name: p.binary,
    tool_name: null,
    tool_use_id: null,
    target_resource: d.target,
    outcome: d.outcome,
    evidence_id: ctx.evidenceId ?? null,
    attribution_confidence: p.docker && p.exec_id ? "high" : "low",
    collection_status: d.collection,
    unavailable_fields: d.unavailable,
    limitations: [...d.limitations, "Tool-call attribution is not in the kernel record; derive it from process ancestry (tetragon.ancestry)."],
    summary: d.summary,
    raw_summary: redactText(`${d.detail.record_type} ${d.detail.function_name ?? ""} ${d.detail.policy_name ?? ""} ${d.detail.action ?? ""}`.replace(/\s+/g, " ").trim(), 300),
    observer: OBSERVER_ID,
    kw_type: d.kw_type,
    tetragon: { ...d.detail, line_no: lineNo, ancestry: [], overlay_duplicates: 0, linked_enforcement_event_id: null, raw: null },
  };
}

function redactedRaw(raw: unknown): string | null {
  if (raw === null || raw === undefined) return null;
  try {
    return redactText(JSON.stringify(raw), 4000);
  } catch {
    return null;
  }
}

function rawEvent(ctx: ParseContext, lineNo: number, raw: unknown, why: string, time: string | null, status: Event["collection_status"]): TetragonObservedEvent {
  const t = time ?? ctx.fallbackTime ?? new Date(0).toISOString();
  const key = `tetragon:raw:${lineNo}:${t}`;
  const rt = isObj(raw) ? recordType(raw) : null;
  return {
    id: makeEventId({ run_id: ctx.runId, basis: "observed", source: SCHEMA_SOURCE, source_native_key: key }),
    run_id: ctx.runId,
    is_fixture: false,
    basis: "observed",
    source: SCHEMA_SOURCE,
    source_native_key: key,
    source_sequence: lineNo,
    event_type: "collector_status",
    timestamp: msTime(t),
    process_id: null,
    parent_process_id: null,
    process_name: null,
    tool_name: null,
    tool_use_id: null,
    target_resource: null,
    outcome: "unknown",
    evidence_id: ctx.evidenceId ?? null,
    attribution_confidence: null,
    collection_status: status,
    unavailable_fields: ["process_id", "parent_process_id", "process_name", "target_resource"],
    limitations: [`Unparsed Tetragon record preserved as raw: ${why}`],
    summary: `unparsed tetragon record (${rt ?? "invalid"}): ${why}`,
    raw_summary: null,
    observer: OBSERVER_ID,
    kw_type: "raw",
    tetragon: {
      record_type: rt ?? "invalid",
      function_name: null,
      policy_name: null,
      action: null,
      time: t,
      node_name: null,
      process: proc(null),
      parent: null,
      file: null,
      net: null,
      exit: null,
      enforcement: null,
      linked_enforcement_event_id: null,
      overlay_duplicates: 0,
      ancestry: [],
      line_no: lineNo,
      raw: redactedRaw(raw),
    },
  };
}

/** Parse ONE Tetragon export record (a JSON line or an already-parsed object). Never throws. */
export function parseTetragonRecord(input: string | unknown, ctx: ParseContext, lineNo = 0): TetragonObservedEvent {
  let rec: unknown = input;
  if (typeof input === "string") {
    const s = input.replace(/\u0000/g, "").trim();
    try {
      rec = JSON.parse(s);
    } catch {
      return rawEvent(ctx, lineNo, null, "line is not valid JSON", null, "error");
    }
  }
  if (!isObj(rec)) return rawEvent(ctx, lineNo, rec, "record is not an object", null, "error");
  const t = recordType(rec);
  if (!t) return rawEvent(ctx, lineNo, rec, "no event body", str(rec.time), "error");
  if (!(RECORD_TYPES as readonly string[]).includes(t)) return rawEvent(ctx, lineNo, rec, `unsupported record type ${t}`, str(rec.time), "partial");
  const d = draft(rec, t, ctx);
  if (!d) {
    const fn = isObj(rec[t]) ? str((rec[t] as J).function_name) : null;
    return rawEvent(ctx, lineNo, rec, `unsupported hook ${fn ?? "?"} in ${t}`, str(rec.time), "partial");
  }
  return finish(d, ctx, lineNo);
}

export interface ProcessNode {
  exec_id: string;
  parent_exec_id: string | null;
  pid: number | null;
  binary: string | null;
  args: string | null;
  cwd: string | null;
  start_time: string | null;
  docker: string | null;
}

/** exec_id -> process, from every process/parent object seen (parents appear even when their exec predates capture). */
export function buildProcessTable(events: TetragonObservedEvent[]): Map<string, ProcessNode> {
  const m = new Map<string, ProcessNode>();
  const put = (p: ProcInfo | null) => {
    if (!p?.exec_id) return;
    const prev = m.get(p.exec_id);
    if (prev && prev.args !== null) return;
    m.set(p.exec_id, {
      exec_id: p.exec_id,
      parent_exec_id: p.parent_exec_id,
      pid: p.pid,
      binary: p.binary,
      args: p.args,
      cwd: p.cwd,
      start_time: p.start_time,
      docker: p.docker,
    });
  };
  for (const e of events) {
    put(e.tetragon.process);
    put(e.tetragon.parent);
  }
  return m;
}

/** Ancestors of exec_id inside the same container, nearest first (stops at the container boundary / unknown / loops). */
export function ancestry(table: Map<string, ProcessNode>, execId: string | null, maxDepth = 16): ProcessNode[] {
  const out: ProcessNode[] = [];
  const seen = new Set<string>();
  let cur = execId ? table.get(execId) : undefined;
  while (cur?.parent_exec_id && out.length < maxDepth) {
    if (seen.has(cur.exec_id)) break;
    seen.add(cur.exec_id);
    const par = table.get(cur.parent_exec_id);
    if (!par || !par.docker) break;
    out.push(par);
    cur = par;
  }
  return out;
}

/**
 * Nearest ancestor-or-self that looks like an agent tool shell: a sh/bash whose parent is node/claude.
 * Claude Code runs each Bash tool call as a shell spawned by the node process; a correlator matches this shell's
 * args/start_time against the reported tool call to attribute descendants (cat, python, curl...).
 */
export function findToolShell(table: Map<string, ProcessNode>, execId: string | null): ProcessNode | null {
  if (!execId) return null;
  const self = table.get(execId);
  const chain = self ? [self, ...ancestry(table, execId)] : ancestry(table, execId);
  for (let i = 0; i < chain.length; i++) {
    const n = chain[i]!;
    const par = n.parent_exec_id ? table.get(n.parent_exec_id) : undefined;
    if (/\/(ba|z|da)?sh$/.test(n.binary ?? "") && par && /(\/node|\/claude)$/.test(par.binary ?? "")) return n;
  }
  return null;
}

export interface NormalizeStats {
  records: number;
  events: number;
  raw_unparsed: number;
  invalid_json: number;
  overlay_duplicates_collapsed: number;
  blocked: number;
  linked_enforcement: number;
}

/**
 * Normalize a whole per-run slice: parse, collapse overlayfs duplicate file.open pairs, link failed opens to our
 * enforcement events, attach in-container ancestry, and make ids unique (stable occurrence suffix).
 */
export function normalizeSlice(lines: string[], ctx: ParseContext): { events: TetragonObservedEvent[]; stats: NormalizeStats } {
  const stats: NormalizeStats = { records: 0, events: 0, raw_unparsed: 0, invalid_json: 0, overlay_duplicates_collapsed: 0, blocked: 0, linked_enforcement: 0 };
  const parsed: TetragonObservedEvent[] = [];
  lines.forEach((line, i) => {
    if (!line.replace(/\u0000/g, "").trim()) return;
    stats.records++;
    const e = parseTetragonRecord(line, ctx, i + 1);
    if (e.kw_type === "raw") {
      stats.raw_unparsed++;
      if (e.tetragon.record_type === "invalid") stats.invalid_json++;
    }
    parsed.push(e);
  });

  // 1) overlayfs: the same open is reported twice, ~10-40us apart. Collapse adjacent pairs (per exec_id) only.
  const out: TetragonObservedEvent[] = [];
  const lastOpenByExec = new Map<string, TetragonObservedEvent>();
  for (const e of parsed) {
    if (e.kw_type === "file.open" && e.tetragon.record_type === "process_kprobe" && e.tetragon.process.exec_id) {
      const prev = lastOpenByExec.get(e.tetragon.process.exec_id);
      const dt = prev ? Math.abs(Date.parse(e.tetragon.time) - Date.parse(prev.tetragon.time)) : Infinity;
      if (
        prev &&
        prev.tetragon.overlay_duplicates === 0 &&
        prev.target_resource === e.target_resource &&
        prev.tetragon.file?.return_code === e.tetragon.file?.return_code &&
        dt <= 1
      ) {
        prev.tetragon.overlay_duplicates++;
        stats.overlay_duplicates_collapsed++;
        continue;
      }
      lastOpenByExec.set(e.tetragon.process.exec_id, e);
    } else if (e.tetragon.process.exec_id && e.kw_type !== "file.open") {
      // any other event from the same process breaks adjacency
      lastOpenByExec.delete(e.tetragon.process.exec_id);
    }
    out.push(e);
  }

  // 2) unique ids: identical native keys get a stable "#n" suffix in slice order.
  const seen = new Map<string, number>();
  for (const e of out) {
    const n = seen.get(e.source_native_key) ?? 0;
    seen.set(e.source_native_key, n + 1);
    if (n > 0) {
      e.source_native_key = `${e.source_native_key}#${n}`;
      e.id = makeEventId({ run_id: ctx.runId, basis: "observed", source: SCHEMA_SOURCE, source_native_key: e.source_native_key });
    }
  }

  // 3) link failed security_file_open records to the process_lsm event from OUR policy for the same exec + path.
  const blocked = out.filter((e) => e.outcome === "blocked" && e.tetragon.enforcement);
  stats.blocked = blocked.length;
  for (const e of out) {
    if (e.kw_type !== "file.open" || e.tetragon.record_type !== "process_kprobe" || e.outcome !== "failed") continue;
    const rc = e.tetragon.file?.return_code;
    if (rc !== -1) continue;
    const twin = blocked.find(
      (b) =>
        b.tetragon.process.exec_id === e.tetragon.process.exec_id &&
        b.target_resource === e.target_resource &&
        Math.abs(Date.parse(b.tetragon.time) - Date.parse(e.tetragon.time)) <= 50,
    );
    if (twin) {
      e.outcome = "blocked";
      e.tetragon.enforcement = twin.tetragon.enforcement;
      e.tetragon.linked_enforcement_event_id = twin.id;
      e.summary = e.summary.replace(/failed EPERM$/, `BLOCKED by ${twin.tetragon.enforcement!.policy_name} (EPERM)`);
      stats.linked_enforcement++;
    }
  }

  // 4) ancestry (inside the container only).
  const table = buildProcessTable(out);
  for (const e of out) {
    e.tetragon.ancestry = ancestry(table, e.tetragon.process.exec_id).map((a) => ({
      exec_id: a.exec_id,
      pid: a.pid,
      binary: a.binary,
      args: a.args && a.args.length > 300 ? a.args.slice(0, 300) + "…" : a.args,
    }));
  }
  stats.events = out.length;
  return { events: out, stats };
}
