import type { Confidence, Event } from "@kw/schema";
import { cmpStr, hashCanonical, uniqSorted } from "./canonical";
import type { AnalysisContext } from "./context";
import { canonicalizePath } from "./paths";
import { splitHostPort } from "./policy";
import type { ActionKind, BlockedBy, Diagnostic, EventDetails, LogicalObservation, ObservedOutcome, OutcomeClass } from "./types";

export interface TimedEvent {
  e: Event;
  t: number;
  d: EventDetails;
}

export function actionKindOf(e: Event, d: EventDetails): ActionKind {
  switch (e.event_type) {
    case "file_open":
      return d.access_mode === "write" || d.access_mode === "read_write" ? "file.write" : "file.read";
    case "file_read":
      return "file.read";
    case "file_write":
    case "file_create":
    case "file_rename":
      return "file.write";
    case "file_delete":
      return "file.delete";
    case "process_exec":
      return "proc.exec";
    case "process_exit":
      return "proc.exit";
    case "network_connect":
      return "net.connect";
    case "dns_query":
      return "net.dns";
    case "repo_change":
      return "fs.change";
    default:
      return "other";
  }
}

function completionLevel(e: Event, d: EventDetails): string {
  switch (e.event_type) {
    case "file_open":
      return d.access_mode === "write" || d.access_mode === "read_write" ? "opened_for_write" : "opened";
    case "file_read":
      return "read_syscall_observed";
    case "file_write":
      return "written";
    case "file_create":
      return "created";
    case "file_delete":
      return "deleted";
    case "file_rename":
      return "renamed";
    case "process_exec":
      return "executed";
    case "network_connect":
      return "connected";
    case "dns_query":
      return "resolved";
    case "repo_change":
      return d.change_kind ?? "changed";
    default:
      return "completed";
  }
}

const PERMISSION_ERRNOS = new Set(["EACCES", "EPERM"]);

function blockedByFor(e: Event, d: EventDetails): BlockedBy {
  if (d.enforcement_rule_id) return "kw_enforcement";
  if (e.source === "network_proxy") return "proxy";
  if (e.source === "sandbox_runtime") return "sandbox";
  return "environment";
}

/** Per-record outcome. Only what the record establishes: an open is "opened", never "read". */
export function eventOutcome(e: Event, d: EventDetails): ObservedOutcome {
  const errno = d.errno ?? null;
  const basis: ObservedOutcome["basis"] = e.collection_status === "complete" ? "observed_return" : "observed_partial";
  const mk = (value: OutcomeClass, level: string | null, blockedBy: BlockedBy | null, b: ObservedOutcome["basis"] = basis): ObservedOutcome => ({
    value,
    level,
    blockedBy,
    errno,
    disputed: false,
    basis: value === "cannot_determine" ? "none" : b,
  });
  // A kill-based enforcement action (e.g. Tetragon Sigkill) is not a block: the fact-check found the permission check
  // passed and the read ran before the kill (return 0). Without an EACCES/EPERM return the outcome is undetermined.
  if ((e.outcome === "blocked" || e.outcome === "denied") && d.signal === "SIGKILL" && !(errno && PERMISSION_ERRNOS.has(errno))) {
    return mk("cannot_determine", null, null);
  }
  switch (e.outcome) {
    case "blocked":
    case "denied":
      return mk("blocked", null, blockedByFor(e, d));
    case "failed":
      if (errno && PERMISSION_ERRNOS.has(errno)) return mk("blocked", null, d.enforcement_rule_id ? "kw_enforcement" : "environment");
      return mk("failed", null, null);
    case "succeeded":
      return mk("completed", completionLevel(e, d), null);
    case "allowed":
      if (e.source === "network_proxy") return mk("completed", "proxy_forwarded", null);
      return mk("cannot_determine", null, null);
    default:
      return mk("cannot_determine", null, null);
  }
}

const POSITIVE: OutcomeClass[] = ["completed"];
const NEGATIVE: OutcomeClass[] = ["blocked", "failed"];

function contradicts(a: OutcomeClass, b: OutcomeClass): boolean {
  return (POSITIVE.includes(a) && NEGATIVE.includes(b)) || (POSITIVE.includes(b) && NEGATIVE.includes(a));
}

const BLOCK_RANK: Record<BlockedBy, number> = { kw_enforcement: 5, proxy: 4, sandbox: 3, agent_layer: 2, environment: 1 };
const OUTCOME_RANK: Record<OutcomeClass, number> = { blocked: 4, failed: 3, completed: 2, cannot_determine: 1 };

function mergeOutcomes(list: ObservedOutcome[]): ObservedOutcome {
  const sorted = [...list].sort((a, b) => OUTCOME_RANK[b.value] - OUTCOME_RANK[a.value]);
  const top = sorted[0]!;
  const blockers = list.map((o) => o.blockedBy).filter((b): b is BlockedBy => b !== null).sort((a, b) => BLOCK_RANK[b] - BLOCK_RANK[a]);
  const levels = list.filter((o) => o.value === top.value && o.level).map((o) => o.level!);
  const basisRank = { observed_return: 2, observed_partial: 1, none: 0 } as const;
  const basis = list.filter((o) => o.value === top.value).reduce<ObservedOutcome["basis"]>((acc, o) => (basisRank[o.basis] > basisRank[acc] ? o.basis : acc), "none");
  return {
    value: top.value,
    level: levels.length ? levels.sort(cmpStr)[levels.length - 1]! : null,
    blockedBy: blockers[0] ?? null,
    errno: list.map((o) => o.errno).find((x) => x !== null) ?? null,
    disputed: list.some((o) => o.disputed),
    basis,
  };
}

function resourceKey(kind: ActionKind, te: TimedEvent, pathKey: string | null, host: string | null, port: number | null): string {
  if (kind.startsWith("file.") || kind === "fs.change") return `path:${pathKey ?? te.e.target_resource ?? "?"}`;
  if (kind === "net.connect" || kind === "net.dns") return `net:${host ?? "?"}:${port ?? "?"}`;
  if (kind === "proc.exec") return `exec:${te.d.argv ? te.d.argv.join("\u0000") : te.e.target_resource ?? te.e.process_name ?? "?"}`;
  return `other:${te.e.event_type}:${te.e.target_resource ?? "?"}`;
}

interface Group {
  kind: ActionKind;
  rkey: string;
  members: TimedEvent[];
  outcomes: ObservedOutcome[];
  pid: number | null;
  t: number;
}

/**
 * Build logical observations from observed events. Records of the SAME fact from DIFFERENT collectors (same kind,
 * same canonical resource, compatible pid, within dedupToleranceMs) are merged: every raw event stays a constituent
 * with its own id and evidence pointer (link, never delete). Repeated records from the same collector are distinct
 * occurrences. A contradiction on the outcome (one collector says completed, another failed/blocked) prevents the merge,
 * marks both sides disputed and raises a collector_disagreement diagnostic.
 */
export function buildObservations(observed: TimedEvent[], ctx: AnalysisContext, diagnostics: Diagnostic[]): LogicalObservation[] {
  const tol = ctx.dedupToleranceMs * 1000;
  const groups: Group[] = [];
  // Groups per (kind, resource), in creation (= time) order. Only groups with the same kind and resource can merge,
  // and scanning backwards can stop at the first group outside the tolerance (observed is time-sorted), so each
  // event inspects a handful of groups instead of every earlier group (was O(n^2) on large runs).
  const byResource = new Map<string, Group[]>();
  const disputedPairs: Array<[Group, Group]> = [];
  for (const te of observed) {
    const kind = actionKindOf(te.e, te.d);
    const path = (kind.startsWith("file.") || kind === "fs.change") && te.e.target_resource
      ? canonicalizePath(te.e.target_resource, ctx, { cwd: te.d.cwd ?? null, kernelResolved: te.d.resolved_path ?? null })
      : null;
    const hp = kind === "net.connect" || kind === "net.dns" ? netTarget(te) : { host: null, port: null };
    const rkey = resourceKey(kind, te, path?.key ?? null, hp.host, hp.port);
    const out = eventOutcome(te.e, te.d);
    const pid = te.e.process_id;
    let merged = false;
    const bucketKey = `${kind}\u0000${rkey}`;
    const bucket = byResource.get(bucketKey) ?? [];
    byResource.set(bucketKey, bucket);
    for (let gi = bucket.length - 1; gi >= 0; gi--) {
      const g = bucket[gi]!;
      if (te.t - g.t > tol) break;
      if (g.members.some((m) => m.e.source === te.e.source)) continue;
      if (g.pid !== null && pid !== null && g.pid !== pid) continue;
      const gOut = mergeOutcomes(g.outcomes);
      if (contradicts(gOut.value, out.value)) {
        const solo: Group = { kind, rkey, members: [te], outcomes: [out], pid, t: te.t };
        groups.push(solo);
        bucket.push(solo);
        disputedPairs.push([g, solo]);
        merged = true;
        break;
      }
      g.members.push(te);
      g.outcomes.push(out);
      if (g.pid === null) g.pid = pid;
      merged = true;
      break;
    }
    if (!merged) {
      const g: Group = { kind, rkey, members: [te], outcomes: [out], pid, t: te.t };
      groups.push(g);
      bucket.push(g);
    }
  }
  for (const [a, b] of disputedPairs) {
    for (const g of [a, b]) g.outcomes = g.outcomes.map((o) => ({ ...o, disputed: true }));
    diagnostics.push({
      code: "collector_disagreement",
      message: `Collectors disagree on the outcome of ${a.kind} ${a.rkey}: ${mergeOutcomes(a.outcomes.map((o) => ({ ...o, disputed: false }))).value} vs ${mergeOutcomes(b.outcomes.map((o) => ({ ...o, disputed: false }))).value}. Both records kept; outcome treated as undetermined.`,
      event_ids: uniqSorted([...a.members, ...b.members].map((m) => m.e.id)),
    });
  }
  return groups.map((g) => toObservation(g, ctx));
}

function netTarget(te: TimedEvent): { host: string | null; port: number | null } {
  if (te.d.host) return { host: te.d.host.toLowerCase(), port: te.d.port ?? null };
  if (te.e.target_resource) {
    const hp = splitHostPort(te.e.target_resource);
    return { host: hp.host || null, port: te.d.port ?? hp.port };
  }
  return { host: null, port: te.d.port ?? null };
}

function toObservation(g: Group, ctx: AnalysisContext): LogicalObservation {
  const members = [...g.members].sort((a, b) => cmpStr(a.e.id, b.e.id));
  const rep = members[0]!;
  const withPid = members.find((m) => m.e.process_id !== null);
  const pathSrc = members.find((m) => m.d.resolved_path) ?? members.find((m) => m.e.target_resource) ?? rep;
  const kind = g.kind;
  const path = (kind.startsWith("file.") || kind === "fs.change") && pathSrc.e.target_resource
    ? canonicalizePath(pathSrc.e.target_resource, ctx, { cwd: pathSrc.d.cwd ?? null, kernelResolved: pathSrc.d.resolved_path ?? null })
    : null;
  const net = kind === "net.connect" || kind === "net.dns" ? netTarget(members.find((m) => m.d.host) ?? rep) : { host: null, port: null };
  let outcome = mergeOutcomes(g.outcomes);
  if (outcome.disputed) outcome = { ...outcome, value: "cannot_determine", basis: "none" };
  const argv = members.find((m) => m.d.argv)?.d.argv ?? null;
  const caps = members.map((m) => m.e.attribution_confidence).filter((c): c is Confidence => c !== null);
  const limitations = uniqSorted([...members.flatMap((m) => m.e.limitations), ...(path?.limitations ?? [])]);
  return {
    id: "lob_" + hashCanonical(members.map((m) => m.e.id)).slice(0, 20),
    kind,
    representative: rep.e.id,
    constituents: members.map((m) => m.e.id),
    sources: uniqSorted(members.map((m) => m.e.source)),
    t: Math.min(...members.map((m) => m.t)),
    pid: withPid?.e.process_id ?? null,
    ppid: members.find((m) => m.e.parent_process_id !== null)?.e.parent_process_id ?? null,
    processName: members.find((m) => m.e.process_name)?.e.process_name ?? null,
    argv,
    path,
    host: net.host,
    port: net.port,
    command: kind === "proc.exec" ? (argv ? argv.join(" ") : (members.find((m) => m.e.target_resource)?.e.target_resource ?? null)) : null,
    toolUseId: members.find((m) => m.e.tool_use_id)?.e.tool_use_id ?? null,
    outcome,
    evidenceIds: uniqSorted(members.map((m) => m.e.evidence_id).filter((x): x is string => x !== null)),
    attributionCaps: caps,
    collectionPartial: members.some((m) => m.e.collection_status !== "complete"),
    limitations,
  };
}
