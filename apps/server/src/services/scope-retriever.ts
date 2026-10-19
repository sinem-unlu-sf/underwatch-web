/**
 * Ask Witness RUN and WORKSPACE scope retrieval. Deterministic SQL over Underwatch's OWN database only: never
 * repository files, the web, or any query text from the model. Every bundle is capped (SCOPED_BUNDLE_MAX_ITEMS) and
 * sealed by buildScopedBundle (same redaction/sanitization as the finding bundle). Run scope never includes another
 * run's records. Support labels stay honest: rows Underwatch derived (findings, runs, coverage, overview, digest,
 * safeguards, verification) are basis "derived"; events keep their own reported/observed basis; evidence records inherit
 * the basis of the events that reference them (observed wins).
 */
import { buildScopedBundle, type BundleItem, type EvidenceBundle, type ScopedItemInput, SCOPED_BUNDLE_MAX_ITEMS } from "@kw/inference";
import {
  OPEN_FINDING_STATUSES,
  outcomesForRun,
  zonedDayBounds,
  type BundleEvidenceRef,
  type CoverageReport,
  type Event,
  type EventBasis,
  type Evidence,
  type FindingListItem,
  type Outcome,
} from "@kw/schema";
import type { ServerContext } from "../context";
import { stmt } from "../db/codec";
import type { Db } from "../db/connection";
import * as t from "../db/tables";
import { getEvidenceByIds } from "../repo/evidence";
import { listRunFindings, queryFindingList } from "../repo/findings";
import { getCoverage, getEventsByIds, requireRun } from "../repo/runs";
import { recordedOutcomesFromRow } from "../verification/repo";
import { knownSecrets } from "./evidence-retriever";

export const KW_TIME_ZONE = "Asia/Tokyo";

/** A finding plus the distinct outcomes of its linked events, split by basis (reported vs observed). */
export interface WsFinding extends FindingListItem {
  reported_outcomes: Outcome[];
  observed_outcomes: Outcome[];
}

const PREVENTED = new Set<string>(["denied", "blocked"]);
/** Prevented attempt linked and not shown succeeding anyway; observed outcomes take precedence over reported ones. */
export function wasBlocked(f: Pick<WsFinding, "reported_outcomes" | "observed_outcomes">): boolean {
  const basis = f.observed_outcomes.length > 0 ? f.observed_outcomes : f.reported_outcomes;
  return basis.some((o) => PREVENTED.has(o)) && !basis.includes("succeeded");
}

const WS_FINDINGS_SCAN_LIMIT = 500;

function workspaceFindings(db: Db): { items: WsFinding[]; total: number } {
  const { items, total } = queryFindingList(db, { orderBy: "ORDER BY f.severity_rank DESC, julianday(f.created_at) DESC, f.id", limit: WS_FINDINGS_SCAN_LIMIT });
  const events = new Map(getEventsByIds(db, [...new Set(items.flatMap((f) => f.related_event_ids))]).map((e) => [e.id, e]));
  const uniq = (xs: Outcome[]) => [...new Set(xs)].sort();
  return {
    total,
    items: items.map((f) => {
      const linked = f.related_event_ids.flatMap((id) => events.get(id) ?? []);
      return {
        ...f,
        reported_outcomes: uniq(linked.filter((e) => e.basis === "reported").map((e) => e.outcome)),
        observed_outcomes: uniq(linked.filter((e) => e.basis === "observed").map((e) => e.outcome)),
      };
    }),
  };
}

export interface ScopedBundleResult {
  scope: { kind: "run" | "workspace"; id: string | null; label: string };
  bundle: EvidenceBundle;
  bases: Map<string, EventBasis | null>;
  refs: BundleEvidenceRef[];
  /** Why items were chosen (stored with turn metadata; not sent to the model). */
  selection: { strategy: string; matched_terms: string[]; caps: Record<string, number> };
  /** Coverage levels of the runs represented (for app-generated limitations). */
  coverage_levels: string[];
}

const CAPS = { runFindings: 10, runEvents: 18, runEvidence: 6, wsFindings: 10, wsEventsPerFinding: 2, wsRuns: 5, wsSafeguards: 4, wsVerifications: 4 } as const;

function coverageItem(runId: string, r: CoverageReport | null): ScopedItemInput {
  return {
    evidence_id: `${runId}#coverage`,
    kind: "coverage",
    basis: "derived",
    source: "kw_coverage",
    timestamp: r?.generated_at ?? null,
    fields: {
      run_id: runId,
      coverage_level: r?.level ?? "unknown (no coverage report recorded)",
      active_sources: (r?.sources ?? []).filter((x) => x.active).map((x) => `${x.source}: ${x.categories.join(", ")}`).slice(0, 12),
      inactive_sources: (r?.sources ?? []).filter((x) => !x.active).map((x) => x.source).slice(0, 12),
      network_outcomes_observable: r?.network_outcomes_observable ?? null,
      final_state_complete: r?.final_state_complete ?? null,
    },
    lists: {
      category_gaps: (r?.categories ?? []).filter((c) => c.status !== "observed").map((c) => `${c.category}: ${c.status}${c.note ? ` (${c.note})` : ""}`),
      unsupported_capabilities: r?.unsupported_capabilities ?? [],
    },
  };
}

function eventItem(e: Event): ScopedItemInput {
  return {
    evidence_id: e.id,
    kind: "event",
    basis: e.basis,
    source: e.source,
    timestamp: e.timestamp,
    links: e.evidence_id ? [e.evidence_id] : [],
    fields: { run_id: e.run_id, event_type: e.event_type, outcome: e.outcome, attribution_confidence: e.attribution_confidence, collection_status: e.collection_status },
    text: { summary: e.summary, tool_name: e.tool_name, target_resource: e.target_resource, process_name: e.process_name },
    content: e.raw_summary,
  };
}

function evidenceItem(v: Evidence): ScopedItemInput {
  return {
    evidence_id: v.id,
    kind: "evidence",
    basis: null,
    source: v.source_type,
    timestamp: v.timestamp,
    fields: { source_type: v.source_type, upstream_redaction_status: v.redaction_status },
    text: { source_reference: v.source_reference },
    content: v.redaction_status === "withheld" ? null : v.excerpt,
  };
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

function summaryFor(item: BundleItem): string {
  const f = item.fields;
  switch (item.kind) {
    case "event":
      return str(f.summary) ?? `${String(f.event_type)} ${String(f.outcome)}`;
    case "finding":
      return `${str(f.title) ?? item.evidence_id} (${String(f.status)}, ${String(f.severity)})`;
    case "run":
      return `Run ${str(f.label) ?? item.evidence_id}: ${String(f.status)}${str(f.task_description) ? ` - ${String(f.task_description)}` : ""}`;
    case "coverage":
      return `Observation coverage for ${String(f.run_id ?? "run")}: ${String(f.coverage_level)}`;
    case "safeguard":
      return `${String(f.type)}: ${str(f.title) ?? item.evidence_id} (verification ${String(f.verification_status)})`;
    case "verification":
      return `Verification ${item.evidence_id}: security ${String(f.security_outcome)}, task ${String(f.task_outcome)}`;
    case "overview":
      return str(f.label) ?? item.evidence_id;
    case "digest":
      return `Digest ${String(f.date)} (${String(f.tz)}): ${String(f.total_findings)} finding(s) in ${String(f.total_runs)} run(s)`;
    default:
      return str(f.source_reference) ?? str(f.source_type) ?? item.evidence_id;
  }
}

/** Seal the bundle and compute bases (evidence inherits its events' basis) + display refs. */
function seal(ctx: ServerContext, scope: ScopedBundleResult["scope"], inputs: ScopedItemInput[], selection: ScopedBundleResult["selection"], coverage_levels: string[]): ScopedBundleResult {
  const bundle = buildScopedBundle({ scope: { kind: scope.kind, id: scope.id }, items: inputs, maxItems: SCOPED_BUNDLE_MAX_ITEMS, redaction: { knownSecrets: knownSecrets(ctx.env) } });
  const evidenceBasis = new Map<string, EventBasis>();
  for (const item of bundle.items) {
    if (item.kind !== "event" || item.basis === null) continue;
    for (const id of item.links) {
      const prev = evidenceBasis.get(id);
      if (prev !== "observed" && (item.basis === "observed" || prev === undefined || (prev === "derived" && item.basis === "reported"))) evidenceBasis.set(id, item.basis);
    }
  }
  const basisOf = (i: BundleItem): EventBasis | null => (i.kind === "evidence" ? (evidenceBasis.get(i.evidence_id) ?? null) : i.basis);
  const runIdOf = (i: BundleItem): string | null => {
    if (i.kind === "run") return i.evidence_id;
    const r = i.fields.run_id;
    return typeof r === "string" && r.startsWith("run_") ? r : scope.kind === "run" && (i.kind === "event" || i.kind === "evidence" || i.kind === "finding") ? scope.id : null;
  };
  return {
    scope,
    bundle,
    bases: new Map(bundle.items.map((i) => [i.evidence_id, basisOf(i)])),
    refs: bundle.items.map((i) => ({
      evidence_id: i.evidence_id,
      kind: i.kind,
      basis: basisOf(i),
      source: i.source,
      timestamp: i.timestamp,
      summary: summaryFor(i).slice(0, 300),
      run_id: runIdOf(i),
    })),
    selection,
    coverage_levels,
  };
}

function findingItem(f: { id: string; run_id: string; category: string; title: string; status: string; severity: string; confidence: string; created_at: string; is_fixture: boolean; missing_information?: readonly string[]; related_event_ids?: readonly string[]; evidence_ids?: readonly string[] }, extra: ScopedItemInput["fields"] = {}, extraText: ScopedItemInput["text"] = {}): ScopedItemInput {
  return {
    evidence_id: f.id,
    kind: "finding",
    basis: "derived",
    source: "kw_analysis",
    timestamp: f.created_at,
    links: [...(f.related_event_ids ?? []), ...(f.evidence_ids ?? [])].slice(0, 20),
    fields: { run_id: f.run_id, category: f.category, status: f.status, severity: f.severity, confidence: f.confidence, is_fixture: f.is_fixture, ...extra },
    text: { title: f.title, ...extraText },
    lists: { missing_information: f.missing_information ?? [] },
  };
}

function runItem(r: { id: string; label: string | null; agent_type: string; adapter?: string | null; task_description: string; policy_version: string | null; started_at: string; ended_at: string | null; status: string; coverage_status: string; is_fixture: boolean }): ScopedItemInput {
  return {
    evidence_id: r.id,
    kind: "run",
    basis: "derived",
    source: "kw_runs",
    timestamp: r.started_at,
    fields: {
      agent_type: r.agent_type,
      adapter: r.adapter ?? null,
      status: r.status,
      coverage_status: r.coverage_status,
      started_at: r.started_at,
      ended_at: r.ended_at,
      policy_version: r.policy_version,
      is_fixture: r.is_fixture,
    },
    text: { label: r.label, task_description: r.task_description },
  };
}

// ---------------------------------------------------------------------------------------------------------------
// RUN scope
// ---------------------------------------------------------------------------------------------------------------

export function forRun(ctx: ServerContext, runId: string): ScopedBundleResult {
  const run = requireRun(ctx.db, runId);
  const coverage = getCoverage(ctx.db, run.id);
  const findings = listRunFindings(ctx.db, run.id).items.slice(0, CAPS.runFindings);
  const fullFindings = findings.map((f) => f as unknown as { related_event_ids?: string[]; evidence_ids?: string[] });
  const cited = [...new Set(fullFindings.flatMap((f) => f.related_event_ids ?? []))];
  // Priority: events cited by findings, then permission decisions, then blocked/denied/failed outcomes, then the rest.
  const ids = stmt(
    ctx.db,
    `SELECT id FROM events WHERE run_id = ?
     ORDER BY CASE WHEN id IN (SELECT value FROM json_each(?)) THEN 0 WHEN event_type = 'permission_decision' THEN 1
                   WHEN outcome IN ('blocked', 'denied', 'failed') THEN 2 ELSE 3 END, julianday(timestamp), id
     LIMIT ?`,
  )
    .all(run.id, JSON.stringify(cited), CAPS.runEvents)
    .map((r) => r.id as string);
  const events = getEventsByIds(ctx.db, ids).filter((e) => e.run_id === run.id);
  events.sort((a, b) => ids.indexOf(a.id) - ids.indexOf(b.id));
  const citedEvidence = [...new Set([...fullFindings.flatMap((f) => f.evidence_ids ?? []), ...events.flatMap((e) => (e.evidence_id ? [e.evidence_id] : []))])];
  const evidence = getEvidenceByIds(ctx.db, citedEvidence.slice(0, CAPS.runEvidence)).filter((v) => v.run_id === run.id);

  const inputs: ScopedItemInput[] = [
    runItem({ ...run, adapter: (run as { adapter?: string | null }).adapter ?? null }),
    coverageItem(run.id, coverage),
    ...findings.map((f) => findingItem(f as never)),
    ...events.map(eventItem),
    ...evidence.map(evidenceItem),
  ];
  return seal(
    ctx,
    { kind: "run", id: run.id, label: run.label ?? run.id },
    inputs,
    { strategy: "run: summary, coverage, findings, events (cited > permission decisions > blocked/denied/failed > others), evidence", matched_terms: [], caps: { ...CAPS } },
    [coverage?.level ?? "unknown"],
  );
}

// ---------------------------------------------------------------------------------------------------------------
// WORKSPACE scope
// ---------------------------------------------------------------------------------------------------------------

function tokyoDate(d: Date): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: KW_TIME_ZONE, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
}

interface Matcher {
  terms: string[];
  score(f: WsFinding, runStarted: string | undefined): number;
}

/** Deterministic keyword/field matching. No model involvement; unknown words simply do not match. */
export function workspaceMatcher(question: string, now: Date): Matcher {
  const q = question.toLowerCase();
  const terms: string[] = [];
  const checks: Array<(f: WsFinding, started: string | undefined) => boolean> = [];
  const add = (term: string, fn: (f: WsFinding, started: string | undefined) => boolean) => {
    terms.push(term);
    checks.push(fn);
  };
  if (/\b(block|blocked|deny|denied|prevent|prevented|stopped)\b/.test(q)) add("blocked", (f) => wasBlocked(f) || f.reported_outcomes.includes("denied") || f.observed_outcomes.includes("blocked"));
  if (/\b(succeed|succeeded|success|successful|went through|got through|bypass)/.test(q)) add("succeeded", (f) => f.observed_outcomes.includes("succeeded") || f.reported_outcomes.includes("succeeded"));
  if (/\b(uncertain|unknown|unclear|unsure|ambiguous|still open|uncertainty)\b/.test(q))
    add("uncertain", (f) => f.category === "uncertain_correlation" || f.confidence === "low" || f.observed_outcomes.includes("unknown") || f.reported_outcomes.includes("unknown"));
  if (/\b(open|unresolved|attention|pending|new)\b/.test(q)) add("open", (f) => (OPEN_FINDING_STATUSES as readonly string[]).includes(f.status));
  for (const sev of ["critical", "high", "medium", "low"]) if (new RegExp(`\\b${sev}\\b`).test(q)) add(sev, (f) => f.severity === sev);
  if (/\b(severe|serious|worst|dangerous)\b/.test(q)) add("severe", (f) => f.severity === "critical" || f.severity === "high");
  const cats: Array<[RegExp, string]> = [
    [/\bunreported\b/, "unreported_observed_action"],
    [/\b(mismatch|differ|disagree|discrepan|contradict|lie|lied|lying)/, "outcome_mismatch"],
    [/\bchange|diff|modif/, "change_mismatch"],
    [/\bpermission|policy|violat/, "permission_violation"],
    [/\bcorrelat/, "uncertain_correlation"],
  ];
  for (const [re, cat] of cats) if (re.test(q)) add(cat, (f) => f.category === cat);
  if (/\bfixture|demo\b/.test(q)) add("fixture", (f) => f.is_fixture);
  if (/\blive|real\b/.test(q)) add("live", (f) => !f.is_fixture);
  const day = (offset: number) => zonedDayBounds(tokyoDate(new Date(now.getTime() - offset * 86_400_000)), KW_TIME_ZONE);
  const within = (s: string | undefined, b: { start: string; end: string }) => s !== undefined && Date.parse(s) >= Date.parse(b.start) && Date.parse(s) < Date.parse(b.end);
  if (/\btoday\b/.test(q)) {
    const b = day(0);
    add("today", (_f, s) => within(s, b));
  }
  if (/\byesterday\b/.test(q)) {
    const b = day(1);
    add("yesterday", (_f, s) => within(s, b));
  }
  // Resource-ish tokens (".env", "secrets.json", "src/app.ts") matched against finding titles.
  for (const tok of new Set(q.match(/[a-z0-9_~-]*[./][a-z0-9_./-]+/g) ?? [])) {
    if (tok.length < 3 || tok.length > 80) continue;
    add(`resource:${tok}`, (f) => f.title.toLowerCase().includes(tok));
  }
  return { terms, score: (f, s) => checks.reduce((n, c) => n + (c(f, s) ? 1 : 0), 0) };
}

const SEV_RANK: Record<string, number> = { critical: 4, high: 3, medium: 2, low: 1, info: 0 };

export function forWorkspace(ctx: ServerContext, question: string): ScopedBundleResult {
  const now = ctx.now();
  const snap = workspaceFindings(ctx.db);
  const runRows = stmt(ctx.db, `SELECT ${t.runs.selectColumns} FROM runs ORDER BY julianday(started_at) DESC, id`).all();
  const runs = runRows.map((r) => t.runs.fromRow(r));
  const started = new Map(runs.map((r) => [r.id, r.started_at]));
  const m = workspaceMatcher(question, now);

  // 1. overview counts (KW analysis)
  const countBy = (key: (f: WsFinding) => string) => {
    const out: Record<string, number> = {};
    for (const f of snap.items) out[key(f)] = (out[key(f)] ?? 0) + 1;
    return Object.entries(out).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}: ${v}`);
  };
  const blocked = snap.items.filter((f) => wasBlocked(f));
  const overview: ScopedItemInput = {
    evidence_id: "kw#findings_overview",
    kind: "overview",
    basis: "derived",
    source: "kw_analysis",
    timestamp: null,
    fields: {
      label: `Findings overview: ${snap.total} finding(s) across ${runs.length} run(s)`,
      total_findings: snap.total,
      findings_truncated: snap.total > snap.items.length,
      by_status: countBy((f) => f.status),
      by_severity: countBy((f) => f.severity),
      by_category: countBy((f) => f.category),
      fixture_findings: snap.items.filter((f) => f.is_fixture).length,
      live_findings: snap.items.filter((f) => !f.is_fixture).length,
      blocked_finding_ids: blocked.map((f) => f.id).slice(0, 20),
      open_finding_count: snap.items.filter((f) => (OPEN_FINDING_STATUSES as readonly string[]).includes(f.status)).length,
    },
  };

  // 2. relevant findings: matched (score desc), else newest open findings; ties by severity then recency.
  const scored = snap.items.map((f) => ({ f, s: m.score(f, started.get(f.run_id)) }));
  const isOpen = (f: WsFinding) => (OPEN_FINDING_STATUSES as readonly string[]).includes(f.status);
  // Matched findings first (score desc), then the rest with open findings before closed ones; then severity, recency, id.
  const ranked = scored
    .sort(
      (a, b) =>
        b.s - a.s ||
        Number(isOpen(b.f)) - Number(isOpen(a.f)) ||
        (SEV_RANK[b.f.severity] ?? 0) - (SEV_RANK[a.f.severity] ?? 0) ||
        Date.parse(b.f.created_at) - Date.parse(a.f.created_at) ||
        a.f.id.localeCompare(b.f.id),
    )
    .slice(0, CAPS.wsFindings)
    .map((x) => x.f);
  const findingItems = ranked.map((f) =>
    findingItem(f, { reported_outcomes: f.reported_outcomes, observed_outcomes: f.observed_outcomes, blocked: wasBlocked(f) }, { run_label: f.run_label }),
  );

  // 3. key events for the top findings (observed first, then reported) so claims can rest on their real basis.
  const keyEventIds: string[] = [];
  for (const f of ranked.slice(0, 6)) {
    const evs = getEventsByIds(ctx.db, f.related_event_ids).filter((e) => e.run_id === f.run_id);
    const order = (b: EventBasis) => (b === "observed" ? 0 : b === "reported" ? 1 : 2);
    evs.sort((a, b) => order(a.basis) - order(b.basis) || a.id.localeCompare(b.id));
    keyEventIds.push(...evs.slice(0, CAPS.wsEventsPerFinding).map((e) => e.id));
  }
  const keyEvents = getEventsByIds(ctx.db, keyEventIds);
  keyEvents.sort((a, b) => keyEventIds.indexOf(a.id) - keyEventIds.indexOf(b.id));

  // 4. runs summary + recent runs
  const runCount = (key: (r: (typeof runs)[number]) => string) => {
    const out: Record<string, number> = {};
    for (const r of runs) out[key(r)] = (out[key(r)] ?? 0) + 1;
    return Object.entries(out).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}: ${v}`);
  };
  const runsSummary: ScopedItemInput = {
    evidence_id: "kw#runs_summary",
    kind: "overview",
    basis: "derived",
    source: "kw_runs",
    timestamp: null,
    fields: {
      label: `Runs summary: ${runs.length} run(s)`,
      total_runs: runs.length,
      by_status: runCount((r) => r.status),
      by_coverage: runCount((r) => r.coverage_status),
      fixture_runs: runs.filter((r) => r.is_fixture).length,
      live_runs: runs.filter((r) => !r.is_fixture).length,
    },
  };
  const relevantRunIds = [...new Set(ranked.map((f) => f.run_id))];
  const recentRuns = [...relevantRunIds.flatMap((id) => runs.filter((r) => r.id === id)), ...runs].filter((r, i, a) => a.findIndex((x) => x.id === r.id) === i).slice(0, CAPS.wsRuns);

  // 5. coverage caveats (KW analysis)
  const caveatLines = runs.flatMap((r) => {
    const out: string[] = [];
    if (r.coverage_status !== "complete") out.push(`${r.id}: observation coverage ${r.coverage_status}`);
    if (r.status === "running" || r.status === "pending") out.push(`${r.id}: run still ${r.status} (more findings may come)`);
    if (r.status === "failed" || r.status === "aborted") out.push(`${r.id}: run ended ${r.status}`);
    return out;
  });
  const caveats: ScopedItemInput = {
    evidence_id: "kw#coverage_caveats",
    kind: "coverage",
    basis: "derived",
    source: "kw_coverage",
    timestamp: null,
    fields: { completeness_status: runs.length === 0 ? "no_runs" : caveatLines.length > 0 ? "has_gaps" : "no_known_gaps", caveat_count: caveatLines.length },
    lists: { caveats: caveatLines.slice(0, 10) },
  };

  // 6. safeguards + verification results (security and task outcome kept separate)
  const sgRows = stmt(
    ctx.db,
    `SELECT ${t.safeguards.selectColumns} FROM safeguards
     ORDER BY CASE WHEN finding_id IN (SELECT value FROM json_each(?)) THEN 0 ELSE 1 END,
              CASE WHEN last_verification_run_id IS NOT NULL OR verification_status <> 'not_tested' THEN 0 ELSE 1 END,
              julianday(created_at) DESC, id LIMIT ?`,
  ).all(JSON.stringify(ranked.map((f) => f.id)), CAPS.wsSafeguards);
  const safeguards = sgRows.map((r) => t.safeguards.fromRow(r));
  const verRows = stmt(
    ctx.db,
    `SELECT ${t.verificationRuns.selectColumns}, security_outcome, task_outcome, reported_task_claim FROM verification_runs
     ORDER BY CASE WHEN id IN (SELECT value FROM json_each(?)) THEN 0 WHEN safeguard_id IN (SELECT value FROM json_each(?)) THEN 1 ELSE 2 END,
              julianday(started_at) DESC, id LIMIT ?`,
  ).all(
    // Audit 4: each bundled safeguard's own latest verification first, so verification items describe bundled safeguards.
    JSON.stringify(safeguards.flatMap((s) => (s.last_verification_run_id ? [s.last_verification_run_id] : []))),
    JSON.stringify(safeguards.map((s) => s.id)),
    CAPS.wsVerifications,
  );
  const verifications = verRows.map((r) => ({ ...t.verificationRuns.fromRow(r), ...recordedOutcomesFromRow(r) }));
  const sgItems: ScopedItemInput[] = safeguards.map((sg) => ({
    evidence_id: sg.id,
    kind: "safeguard",
    basis: "derived",
    source: "kw_safeguards",
    timestamp: sg.created_at,
    links: sg.last_verification_run_id ? [sg.last_verification_run_id] : [],
    fields: { finding_id: sg.finding_id, type: sg.type, approval_status: sg.approval_status, application_status: sg.application_status, verification_status: sg.verification_status, is_fixture: sg.is_fixture },
    text: { title: sg.title },
  }));
  const verItems: ScopedItemInput[] = verifications.map((v) => {
    const o = outcomesForRun(v);
    return {
      evidence_id: v.id,
      kind: "verification",
      basis: "derived",
      source: "kw_verification",
      timestamp: v.started_at,
      links: [v.safeguard_id],
      fields: {
        safeguard_id: v.safeguard_id,
        finding_id: v.finding_id,
        status: v.status,
        security_outcome: o.security_outcome.value,
        security_outcome_basis: o.security_outcome.basis,
        task_outcome: o.task_outcome.value,
        task_outcome_basis: o.task_outcome.basis,
        is_fixture: v.is_fixture,
      },
      text: { scenario: v.scenario_description },
    };
  });

  // 7. today's summary (Asia/Tokyo), computed live from the same rows (read-only; no stored digest is created)
  const items: ScopedItemInput[] = [overview, runsSummary, caveats];
  const today = tokyoDate(now);
  try {
    const b = zonedDayBounds(today, KW_TIME_ZONE);
    const inDay = (s: string | undefined) => s !== undefined && Date.parse(s) >= Date.parse(b.start) && Date.parse(s) < Date.parse(b.end);
    const dayRuns = runs.filter((r) => inDay(r.started_at));
    const dayFindings = snap.items.filter((f) => inDay(started.get(f.run_id)));
    const d = {
      summary: {
        total_findings: dayFindings.length,
        total_runs: dayRuns.length,
        needs_attention: dayFindings.filter((f) => isOpen(f)).map((f) => f.id),
        blocked: dayFindings.filter((f) => wasBlocked(f)).map((f) => f.id),
        uncertain: dayFindings
          .filter((f) => f.category === "uncertain_correlation" || f.confidence === "low" || f.observed_outcomes.includes("unknown") || f.reported_outcomes.includes("unknown"))
          .map((f) => f.id),
        coverage_gaps: dayRuns.filter((r) => r.coverage_status !== "complete").map((r) => ({ kind: "coverage", detail: `${r.id}: ${r.coverage_status}` })),
      },
      completeness: { status: dayRuns.length === 0 ? "no_runs" : dayRuns.some((r) => r.coverage_status !== "complete") ? "has_gaps" : "no_known_gaps" },
    };
    items.push({
      evidence_id: `digest#${today}`,
      kind: "digest",
      basis: "derived",
      source: "kw_digest_live",
      timestamp: null,
      fields: {
        date: today,
        tz: KW_TIME_ZONE,
        total_findings: d.summary.total_findings,
        total_runs: d.summary.total_runs,
        needs_attention: d.summary.needs_attention.slice(0, 20),
        blocked: d.summary.blocked.slice(0, 20),
        uncertain: d.summary.uncertain.slice(0, 20),
        completeness_status: d.completeness.status,
      },
      lists: { coverage_gaps: d.summary.coverage_gaps.map((c) => `${c.kind}: ${c.detail}`) },
    });
  } catch {
    /* digest unavailable: omitted (the overview still carries the counts) */
  }
  items.push(...findingItems, ...keyEvents.map(eventItem), ...recentRuns.map((r) => runItem(r)), ...sgItems, ...verItems);
  const levels = [...new Set(recentRuns.map((r) => r.coverage_status))];
  return seal(
    ctx,
    { kind: "workspace", id: null, label: "All Underwatch records" },
    items,
    { strategy: m.terms.length > 0 ? "workspace: keyword/field match" : "workspace: newest open findings (no matching terms)", matched_terms: m.terms, caps: { ...CAPS, total: SCOPED_BUNDLE_MAX_ITEMS } },
    levels,
  );
}
