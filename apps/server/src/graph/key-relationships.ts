/**
 * Key relationships for a finding (Addendum C section 5): the 3-6 most important relationship paths, in plain
 * language, computed from an ALREADY BUILT FindingGraphResponse (Neo4j query results, or the relational fallback) plus
 * the Underwatch records those nodes stand for (policy rule text, finding fields, run labels). Nothing here creates
 * nodes, edges or statistics: every step names a node id the graph response (nodes or insights) returned, every hop
 * carries the edge basis the projection stored, and a path is only as strong as its weakest hop. Inferred links say so.
 * Deterministic; no AI involved.
 */
import { EVENT_SOURCE_LABELS, type EventSource } from "@kw/schema";
import type {
  Finding,
  FindingGraphResponse,
  GraphBasis,
  GraphEdge,
  GraphNode,
  GraphNodeLabel,
  KeyRelationship,
  KeyRelationshipKind,
  KeyRelationshipLink,
  KeyRelationshipStep,
  KeyRelationshipsSummary,
} from "@kw/schema";
import type { Db } from "../db/connection";
import { getPolicyVersion, getRun } from "../repo/runs";

const MAX_ITEMS = 6;
const MAX_TEXT = 140;
/** Per-kind caps, in priority order (most important first). */
const PRIORITY: ReadonlyArray<[KeyRelationshipKind, number]> = [
  ["contradiction", 1],
  ["origin_chain", 1],
  ["policy", 1],
  ["cross_run", 1],
  ["verification", 2],
  ["safeguard", 1],
  ["recurrence", 1],
  ["supporting_evidence", 2],
  ["investigation", 1],
];
const RANK: Record<GraphBasis, number> = { inferred: 0, reported: 1, ai: 2, user: 3, derived: 4, observed: 5 };

export const KEY_RELATIONSHIPS_NOTE =
  "Relationships are leads for investigation, not proof on their own. Check the cited events and evidence; inferred links are heuristic and agent reports are claims.";

const clip = (s: string, n = MAX_TEXT) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const q = (s: string) => `"${clip(s.replace(/\s+/g, " ").trim(), 90)}"`;
const enc = encodeURIComponent;

/** Weakest basis among the hops (null hops ignored; no known basis at all => inferred, the conservative choice). */
export function weakestBasis(bases: ReadonlyArray<GraphBasis | null | undefined>): GraphBasis {
  const known = bases.filter((b): b is GraphBasis => !!b);
  if (known.length === 0) return "inferred";
  return known.reduce((a, b) => (RANK[b] < RANK[a] ? b : a));
}

function str(n: GraphNode | undefined, k: string): string | null {
  const v = n?.props[k];
  return typeof v === "string" && v !== "" ? v : null;
}

function sourceLabel(n: GraphNode | undefined): string | null {
  const src = str(n, "source");
  if (!src) return null;
  return (EVENT_SOURCE_LABELS as Record<string, string>)[src as EventSource] ?? src;
}

export function buildKeyRelationships(db: Db, finding: Finding, g: Omit<FindingGraphResponse, "key_relationships">): KeyRelationshipsSummary {
  const byId = new Map(g.nodes.map((n) => [n.id, n]));
  const fromNeo4j = g.source === "neo4j";
  const itemSource: KeyRelationship["source"] = fromNeo4j ? "neo4j" : "kw_records";
  const fBasis: GraphBasis = finding.confidence === "high" ? "derived" : "inferred";
  const runLabelCache = new Map<string, string>();
  const runLabel = (runId: string) => {
    if (!runLabelCache.has(runId)) runLabelCache.set(runId, getRun(db, runId)?.label ?? runId);
    return runLabelCache.get(runId)!;
  };
  const edge = (type: string, from: string, to: string): GraphEdge | undefined => g.edges.find((e) => e.type === type && e.from === from && e.to === to);
  const edgesOf = (type: string, pred: (e: GraphEdge) => boolean) => g.edges.filter((e) => e.type === type && pred(e));

  const step = (id: string, label: GraphNodeLabel, title: string | null, via: string | null, viaBasis: GraphBasis | null): KeyRelationshipStep => {
    const n = byId.get(id);
    return { node_id: id, label: n?.label ?? label, title: clip(title ?? n?.title ?? id, 160), via, via_basis: viaBasis, in_graph: !!n };
  };
  const eventLink = (id: string, label: string): KeyRelationshipLink => {
    const runId = str(byId.get(id), "run_id") ?? finding.run_id;
    return { kind: "run_event", id, href: `/runs/${enc(runId)}?event=${enc(id)}`, label };
  };
  const findingLink = (id: string, label: string): KeyRelationshipLink => ({ kind: "finding", id, href: `/findings/${enc(id)}`, label });
  const runLink = (id: string, label: string): KeyRelationshipLink => ({ kind: "run", id, href: `/runs/${enc(id)}`, label });
  const sgLink = (id: string, label: string): KeyRelationshipLink => ({ kind: "safeguard", id, href: `/safeguards/${enc(id)}`, label });
  const verLink = (id: string, sgId: string, label: string): KeyRelationshipLink => ({
    kind: "verification",
    id,
    href: `/safeguards/${enc(sgId)}?verification=${enc(id)}`,
    label,
  });

  const candidates = new Map<KeyRelationshipKind, KeyRelationship[]>();
  const push = (r: Omit<KeyRelationship, "source"> & { source?: KeyRelationship["source"] }) => {
    const list = candidates.get(r.kind) ?? [];
    // Every inferred path says so up front, whatever produced it (never presented as proof).
    const note = r.basis === "inferred" && !/^Inferred/.test(r.basis_note) ? `Inferred (heuristic or below high confidence), a lead to check, not proof. ${r.basis_note}` : r.basis_note;
    list.push({ ...r, basis_note: note, text: clip(r.text, 320), source: r.source ?? itemSource });
    candidates.set(r.kind, list);
  };
  const covered = new Set<string>();
  const fid = finding.id;
  const cited = new Set(finding.related_event_ids);

  // Contradiction: observed event CONTRADICTS agent report, both cited by this finding (Neo4j projection only).
  for (const e of edgesOf("CONTRADICTS", (x) => cited.has(x.from) && cited.has(x.to))) {
    const obs = byId.get(e.from);
    const rep = byId.get(e.to);
    if (!obs || !rep) continue;
    const basis = weakestBasis([e.basis]);
    covered.add(obs.id).add(rep.id);
    push({
      id: `kr:contradiction:${e.id}`,
      kind: "contradiction",
      text: `Agent reported ${q(str(rep, "summary") ?? rep.title)}, but ${sourceLabel(obs) ?? "an independent observer"} recorded ${q(str(obs, "summary") ?? obs.title)}.`,
      basis,
      basis_note:
        basis === "inferred"
          ? "Inferred: the finding is below high confidence, so this pairing is a lead to check, not proof of a discrepancy."
          : "Derived by Underwatch analysis from a high-confidence finding. The agent report is a claim; the observed event is the independent record.",
      steps: [step(rep.id, "AgentAction", null, null, null), step(obs.id, "ObservedEvent", null, "CONTRADICTS", e.basis)],
      links: [eventLink(rep.id, "Agent report"), eventLink(obs.id, "Observed event")],
    });
  }

  // Origin chain: agent tool call -SPAWNED-> process -SPAWNED-> ... -> observed event (insights.ancestry, Neo4j only).
  // One path per originating tool call: prefer resolved origins, then non-exec events (file/network access says more
  // than the exec itself), then the longest chain.
  const isExec = (id: string) => str(byId.get(id), "event_type") === "process_exec";
  const seenOrigins = new Set<string>();
  const ancestry = [...(g.insights?.ancestry ?? [])].sort(
    (x, y) =>
      Number(!!y.origin_tool_call) - Number(!!x.origin_tool_call) ||
      Number(isExec(x.event_id)) - Number(isExec(y.event_id)) ||
      y.chain.length - x.chain.length ||
      x.event_id.localeCompare(y.event_id),
  );
  for (const a of ancestry) {
    if (a.origin_tool_call) {
      if (seenOrigins.has(a.origin_tool_call.event_id)) continue;
      seenOrigins.add(a.origin_tool_call.event_id);
    }
    const ev = byId.get(a.event_id);
    const evSummary = str(ev, "summary") ?? a.event_summary;
    const observer = sourceLabel(ev);
    const perf = g.edges.find((e) => e.type === "PERFORMED_BY" && e.from === a.event_id);
    const lastProc = a.chain.at(-1);
    const otc = a.origin_tool_call;
    const startIdx = otc ? Math.max(0, a.chain.length - 1 - otc.hops_to_event_process) : 0;
    const procs = a.chain.slice(startIdx);
    const steps: KeyRelationshipStep[] = [];
    if (otc) steps.push(step(otc.event_id, "AgentAction", `${otc.tool_name ?? "tool"} call: ${otc.summary}`, null, null));
    procs.forEach((h, i) => {
      const via = i === 0 ? (otc ? "SPAWNED" : null) : "SPAWNED";
      const viaBasis = i === 0 ? (otc ? otc.relation_basis : null) : h.spawned_basis;
      steps.push(step(h.process_id, "Process", `${h.name ?? "process"} (pid ${h.pid ?? "?"})`, via, viaBasis));
    });
    steps.push(step(a.event_id, "ObservedEvent", evSummary, lastProc ? "PERFORMED_BY" : null, lastProc ? (perf?.basis ?? null) : null));
    const basis = weakestBasis(steps.slice(1).map((s) => s.via_basis));
    const names = procs.map((h) => h.name ?? `pid ${h.pid ?? "?"}`).join(" -> ");
    covered.add(a.event_id);
    if (otc) covered.add(otc.event_id);
    push({
      id: `kr:origin:${a.event_id}`,
      kind: "origin_chain",
      text: otc
        ? `Agent's ${otc.tool_name ?? "tool"} tool call ${q(otc.summary)} -> ${names || "process"} -> ${clip(evSummary, 90)}${observer ? ` (observed by ${observer})` : ""}.`
        : `${names ? `Process chain ${names}` : "No attributed process"} -> ${clip(evSummary, 90)}; the agent tool call that started it is not resolved${a.unresolved_reason ? ` (${a.unresolved_reason})` : ""}.`,
      basis,
      basis_note:
        basis === "inferred"
          ? "Inferred: at least one hop is heuristic (uncertain correlation or low-confidence process attribution), so treat the chain as a hypothesis, not proof."
          : `Weakest hop is ${basis}. Process spawns come from the tracer; the tool-call link comes from Underwatch correlation.`,
      steps,
      links: [...(otc ? [eventLink(otc.event_id, "Tool call")] : []), eventLink(a.event_id, "Observed event")],
    });
  }

  // Policy in effect / violated rule (Finding -VIOLATES-> PolicyVersion; rule text from the stored policy version).
  if (finding.policy_id) {
    const pv = getPolicyVersion(db, finding.policy_id);
    const violates = edge("VIOLATES", fid, finding.policy_id);
    const run = getRun(db, finding.run_id);
    if (pv) {
      const rule = finding.policy_rule_id ? (pv.rules.find((r) => r.id === finding.policy_rule_id) ?? null) : null;
      const verb = rule ? ({ deny: "denies", allow: "allows", ask: "requires approval for" } as const)[rule.effect] : null;
      const inEffect = run?.policy_version === pv.id;
      const basis = violates ? weakestBasis([violates.basis]) : fBasis;
      push({
        id: `kr:policy:${pv.id}:${finding.policy_rule_id ?? "none"}`,
        kind: "policy",
        text: rule
          ? `Policy ${pv.name} (version ${pv.version}), rule ${rule.id}, ${verb} ${rule.action} ${rule.resource_pattern} (${inEffect ? "policy in effect for this run" : "policy cited by the finding"}).`
          : `Finding cites policy ${pv.name} (version ${pv.version})${finding.policy_rule_id ? ` (rule ${finding.policy_rule_id} is not in that version)` : " (no specific rule recorded)"}${inEffect ? ", the policy in effect for this run" : ""}.`,
        basis,
        basis_note: `${violates ? "VIOLATES link from the graph projection" : "Link from the finding record"}; rule text from the stored policy version. A rule says what is allowed; it does not by itself show the action was blocked.`,
        steps: [step(fid, "Finding", null, null, null), step(pv.id, "PolicyVersion", `${pv.name} v${pv.version}`, violates ? "VIOLATES" : null, violates?.basis ?? null)],
        links: [runLink(finding.run_id, "Run under this policy")],
      });
    }
  }

  // Safeguards addressing the finding, and verification runs that tested them.
  const sgIds = new Set<string>([
    ...edgesOf("ADDRESSES", (e) => e.to === fid).map((e) => e.from),
    ...edgesOf("PROPOSED_AS", (e) => e.from === fid).map((e) => e.to),
  ]);
  for (const sgId of [...sgIds].sort()) {
    const sg = byId.get(sgId);
    if (!sg || sg.label !== "Safeguard") continue;
    const sgTitle = str(sg, "title") ?? sg.title;
    const vrIds = new Set<string>([
      ...edgesOf("TESTS", (e) => e.to === sgId).map((e) => e.from),
      ...edgesOf("VERIFIED_BY", (e) => e.from === sgId).map((e) => e.to),
    ]);
    const vrs = [...vrIds]
      .map((id) => byId.get(id))
      .filter((n): n is GraphNode => !!n && n.label === "VerificationRun")
      .sort((x, y) => (str(y, "started_at") ?? "").localeCompare(str(x, "started_at") ?? "") || x.id.localeCompare(y.id));
    for (const vr of vrs) {
      const so = str(vr, "security_outcome");
      const to = str(vr, "task_outcome");
      const status = str(vr, "verification_status") ?? str(vr, "status");
      const tested = edge("TESTS", vr.id, sgId) ?? edge("VERIFIED_BY", sgId, vr.id);
      const outcome = so || to ? `security ${so ?? "not recorded"}, task ${to ?? "not recorded"}` : `result ${str(vr, "result") ?? "not recorded"}`;
      push({
        id: `kr:verification:${vr.id}`,
        kind: "verification",
        text: `Verification ${vr.id} tested safeguard ${sgId} ${q(sgTitle)}: ${outcome}${status ? ` (status ${status})` : ""}.`,
        basis: weakestBasis([tested?.basis]),
        basis_note: `Stored verification record (security outcome basis: ${str(vr, "security_outcome_basis") ?? "not recorded"}; task outcome basis: ${str(vr, "task_outcome_basis") ?? "not recorded"}). Security and task outcomes are separate: blocking an action does not show the task succeeded.`,
        steps: [
          step(fid, "Finding", null, null, null),
          step(sgId, "Safeguard", sgTitle, edge("ADDRESSES", sgId, fid) ? "ADDRESSES" : "PROPOSED_AS", "derived"),
          step(vr.id, "VerificationRun", null, tested ? tested.type : null, tested?.basis ?? null),
        ],
        links: [verLink(vr.id, sgId, "Verification run"), sgLink(sgId, "Safeguard")],
      });
    }
    if (vrs.length === 0) {
      push({
        id: `kr:safeguard:${sgId}`,
        kind: "safeguard",
        text: `Safeguard ${sgId} ${q(sgTitle)} addresses this finding: approval ${str(sg, "approval_status") ?? "unknown"}, application ${str(sg, "application_status") ?? "unknown"}, verification ${str(sg, "verification_status") ?? "unknown"}. No verification run is linked in this graph.`,
        basis: "derived",
        basis_note: "Stored safeguard status. A proposed or written safeguard is not evidence that it is enforced or effective.",
        steps: [step(fid, "Finding", null, null, null), step(sgId, "Safeguard", sgTitle, edge("ADDRESSES", sgId, fid) ? "ADDRESSES" : "PROPOSED_AS", "derived")],
        links: [sgLink(sgId, "Safeguard")],
      });
    }
  }

  // Same resource in other runs (insights.cross_run, Neo4j only), one item per resource.
  const byRes = new Map<string, NonNullable<FindingGraphResponse["insights"]>["cross_run"]>();
  for (const m of g.insights?.cross_run ?? []) byRes.set(m.resource_id, [...(byRes.get(m.resource_id) ?? []), m]);
  for (const [resId, ms] of byRes) {
    const runs = [...new Set(ms.map((m) => m.run_id))];
    const bases = [...new Set(ms.flatMap((m) => m.event_bases))].sort();
    const onlyReported = bases.length > 0 && bases.every((b) => b === "reported");
    const linked = ms.some((m) => m.linked_by_recurrence);
    const shown = runs.slice(0, 3).map(runLabel);
    push({
      id: `kr:cross_run:${resId}`,
      kind: "cross_run",
      text: `Same resource ${ms[0]!.resource_key} appears in ${runs.length} other run${runs.length === 1 ? "" : "s"}: ${shown.join(", ")}${runs.length > 3 ? ` and ${runs.length - 3} more` : ""}.`,
      basis: onlyReported ? "reported" : "derived",
      basis_note: `Matched on the normalized resource key (other runs' events: ${bases.join(", ") || "unknown"}). A shared resource is a lead for recurrence, not proof the same behavior happened.${linked ? " A recorded recurrence also links these findings." : ""}`,
      steps: [
        step(fid, "Finding", null, null, null),
        step(resId, "Resource", ms[0]!.resource_key, "SUPPORTED_BY/TARGETS", null),
        ...ms.slice(0, 3).map((m) => step(m.finding_id, "Finding", m.finding_title, "TARGETS/SUPPORTED_BY", null)),
      ],
      links: ms.slice(0, 3).flatMap((m) => [findingLink(m.finding_id, m.finding_title), runLink(m.run_id, runLabel(m.run_id))]),
    });
  }

  // Recurrence recorded on the finding (both directions present in the graph response).
  if (finding.recurrence_of_finding_id) {
    const prev = finding.recurrence_of_finding_id;
    const e = edge("RECURRED_AS", prev, fid);
    push({
      id: `kr:recurrence:${prev}`,
      kind: "recurrence",
      text: `This finding is recorded as a possible recurrence of ${prev}${byId.get(prev) ? ` ${q(byId.get(prev)!.title)}` : ""}.`,
      basis: weakestBasis([e?.basis ?? "derived"]),
      basis_note: "Recorded by Underwatch recurrence detection: a potential regression to review, not a confirmed repeat.",
      steps: [step(prev, "Finding", null, null, null), step(fid, "Finding", null, "RECURRED_AS", e?.basis ?? "derived")],
      links: [findingLink(prev, "Earlier finding")],
    });
  }

  // Supporting evidence: events the finding cites (observed first), with the resource they target or report.
  const supported = edgesOf("SUPPORTED_BY", (e) => e.from === fid)
    .map((e) => ({ e, n: byId.get(e.to) }))
    .filter((x): x is { e: GraphEdge; n: GraphNode } => !!x.n && (x.n.label === "ObservedEvent" || x.n.label === "AgentAction") && !covered.has(x.n.id))
    .sort((x, y) => Number(y.n.label === "ObservedEvent") - Number(x.n.label === "ObservedEvent") || x.n.id.localeCompare(y.n.id));
  for (const { e, n } of supported) {
    const observed = n.label === "ObservedEvent";
    const resEdge = g.edges.find((x) => (x.type === "TARGETS" || x.type === "REPORTS") && x.from === n.id && byId.get(x.to)?.label === "Resource");
    const res = resEdge ? byId.get(resEdge.to) : undefined;
    // The event's own target_resource is the readable form (Resource node ids are hashes).
    const resKey = res ? (str(n, "target_resource") ?? str(res, "display") ?? res.title) : null;
    const steps = [step(fid, "Finding", null, null, null), step(n.id, n.label, str(n, "summary"), "SUPPORTED_BY", e.basis)];
    if (res && resEdge) steps.push(step(res.id, "Resource", resKey, resEdge.type, resEdge.basis));
    const basis = weakestBasis(steps.slice(1).map((s) => s.via_basis));
    push({
      id: `kr:evidence:${n.id}`,
      kind: "supporting_evidence",
      text: observed
        ? `Finding cites observed event ${q(str(n, "summary") ?? n.title)}${resKey ? ` on ${resKey}` : ""}${sourceLabel(n) ? ` (recorded by ${sourceLabel(n)})` : ""}.`
        : `Finding cites the agent's own report ${q(str(n, "summary") ?? n.title)}${resKey ? ` about ${resKey}` : ""}: an agent claim, not an observation.`,
      basis,
      basis_note: observed
        ? `Weakest hop is ${basis}. The event is an independent record; what it does not establish is listed on the event itself.`
        : "Reported by the agent: the edge records what the agent claimed, not that it happened.",
      steps,
      links: [eventLink(n.id, observed ? "Observed event" : "Agent report"), ...(str(n, "evidence_id") ? [{ kind: "evidence" as const, id: str(n, "evidence_id")!, href: null, label: "Evidence" }] : [])],
    });
  }

  // Ask Witness investigations (AI explanations; never evidence).
  for (const inv of edgesOf("INVESTIGATES", (e) => e.to === fid).map((e) => byId.get(e.from)).filter((n): n is GraphNode => !!n)) {
    const uses = edgesOf("USES_EVIDENCE", (e) => e.from === inv.id);
    push({
      id: `kr:investigation:${inv.id}`,
      kind: "investigation",
      text: `Ask Witness investigation ${inv.id} cites ${uses.length} record${uses.length === 1 ? "" : "s"} from this finding's evidence.`,
      basis: "ai",
      basis_note: "AI explanation of the evidence. It is not evidence itself and does not decide what happened.",
      steps: [step(inv.id, "Investigation", null, null, null), step(fid, "Finding", null, "INVESTIGATES", "derived")],
      links: [findingLink(fid, "Ask Witness on this finding")],
    });
  }

  const items: KeyRelationship[] = [];
  let total = 0;
  for (const [kind, cap] of PRIORITY) {
    const list = candidates.get(kind) ?? [];
    total += list.length;
    for (const r of list.slice(0, cap)) if (items.length < MAX_ITEMS) items.push(r);
  }

  const unavailable = fromNeo4j
    ? []
    : [
        "origin_chain: process ancestry back to the agent tool call needs Neo4j",
        "cross_run: the same resource across other runs needs Neo4j",
        "contradiction: CONTRADICTS links are part of the Neo4j projection",
      ];
  return {
    finding_id: fid,
    source: g.source,
    detail: fromNeo4j
      ? `From Neo4j query results (finding neighborhood, process ancestry, cross-run resource matches)${g.truncated ? "; the graph was truncated, so some relationships may be missing" : ""}.`
      : `From Underwatch records, Neo4j unavailable. ${g.detail}`,
    items,
    omitted: total - items.length,
    unavailable,
    note: KEY_RELATIONSHIPS_NOTE,
  };
}
