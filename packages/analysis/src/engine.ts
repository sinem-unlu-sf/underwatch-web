import {
  EVENT_SOURCE_BASIS,
  FINDING_CATEGORY_LABELS,
  SEVERITY_ORDER,
  makeStableId,
  type CoverageCategory,
  type Event,
  type EventCorrelation,
  type Finding,
  type FindingCategory,
} from "@kw/schema";
import { attributeAll, buildProcTree, primaryKind } from "./attribution";
import { cmpStr, hashCanonical, uniqSorted } from "./canonical";
import { inferWorkspaceRoot, resolveContext } from "./context";
import { categoryState } from "./coverage";
import { classifyNoise, type NoiseMatch } from "./noise";
import { buildObservations, type TimedEvent } from "./observations";
import { classify, evaluatePolicy, normalizePolicy, type PolicyAction, type PolicyDecisionRecord, type PolicyEvaluation } from "./policy";
import { buildReportedCalls, SHELL_TOOLS } from "./reported";
import { confidenceFromClaims, minConfidence } from "./rubric/confidence";
import { computeSeverity } from "./rubric/severity";
import { reportTextFor, runNarrativeRules, type ReportText } from "./narrative";
import { RULES, runRules, type CandidateFinding, type RuleInputs } from "./rules";
import { parseIsoMicros } from "./time";
import type {
  AnalysisResult,
  AnalyzeRunInput,
  Attribution,
  CorrelationRecord,
  Diagnostic,
  FindingAnnotation,
  LogicalObservation,
  MatchState,
  ReportedCall,
  SuppressedEvent,
  UnprocessedEvent,
} from "./types";
import { DEFAULT_RULESET_VERSION, ENGINE_VERSION, NOISE_MODEL_VERSION } from "./version";

const PRECEDENCE: FindingCategory[] = ["permission_violation", "outcome_mismatch", "change_mismatch", "unreported_observed_action", "uncertain_correlation"];
const SOURCE_ORDER: Record<string, number> = {
  kernel_tracer: 0, process_tracer: 1, sandbox_runtime: 2, file_watcher: 3, network_proxy: 4, git_observer: 5,
  claude_code_hooks: 6, claude_code_otel: 7, claude_code_transcript: 8, kw_correlator: 9, kw_policy_engine: 10,
};

function eventOrder(a: TimedEvent, b: TimedEvent): number {
  return a.t - b.t || (SOURCE_ORDER[a.e.source] ?? 99) - (SOURCE_ORDER[b.e.source] ?? 99) || (a.e.source_sequence ?? -1) - (b.e.source_sequence ?? -1) || cmpStr(a.e.id, b.e.id);
}

function toPolicyAction(o: LogicalObservation): PolicyAction | null {
  const base = { path: o.path, command: o.command, argv: o.argv, processName: o.processName, host: o.host, port: o.port };
  switch (o.kind) {
    case "file.read":
      return { kind: "file_read", ...base };
    case "file.write":
    case "file.delete":
      return { kind: "file_write", ...base };
    case "proc.exec":
      return { kind: "command", ...base };
    case "net.connect":
      return { kind: "network", ...base };
    default:
      return null;
  }
}

function intentAction(c: ReportedCall): PolicyAction | null {
  const k = primaryKind(c.toolName);
  const base = { path: c.path, command: null as string | null, argv: null, processName: null, host: c.host, port: null };
  if (k === "file.read") return c.path ? { ...base, kind: "file_read" } : null;
  if (k === "file.write") return c.path ? { ...base, kind: "file_write" } : null;
  if (k === "proc.exec") return c.target ? { ...base, kind: "command", command: c.target } : null;
  if (k === "net.connect") return c.host ? { ...base, kind: "network" } : null;
  return null;
}

function intentCoverage(c: ReportedCall): CoverageCategory {
  const k = primaryKind(c.toolName);
  return k === "file.read" ? "file_access" : k === "file.write" ? "file_modification" : k === "proc.exec" ? "process_execution" : "network";
}

function resourceLabel(o: { path: LogicalObservation["path"]; host: string | null; command: string | null }): string {
  return o.path?.resolved ?? o.path?.raw ?? o.host ?? o.command ?? "?";
}

function schemaMatch(state: MatchState): EventCorrelation["match"] {
  return state === "exact" || state === "probable" ? "matched" : state === "ambiguous" ? "uncertain" : state === "unmatched_observed" ? "observed_only" : "reported_only";
}

/**
 * Deterministic analysis of one run. Pure: no I/O, no clock, no randomness, no inference. The same input (in any
 * event order) yields byte-identical output under canonical JSON.
 */
export function analyzeRun(input: AnalyzeRunInput): AnalysisResult {
  let inferredRoot: { root: string; support: number } | null = null;
  if (input.context?.workspaceRoot === undefined) {
    inferredRoot = inferWorkspaceRoot(
      input.events.filter((e) => e.event_type === "repo_change" && e.target_resource).map((e) => e.target_resource!),
      input.events.map((e) => e.target_resource ?? "").filter((t) => t.startsWith("/")),
    );
  }
  const ctx = resolveContext(inferredRoot ? { ...(input.context ?? {}), workspaceRoot: inferredRoot.root } : input.context);
  const rulesetVersion = input.rulesetVersion ?? DEFAULT_RULESET_VERSION;
  const run = input.run;
  const diagnostics: Diagnostic[] = [];
  // Out-of-band details come from collectors; a malformed numeric field (float, NaN) must not crash analysis
  // (canonicalJson only admits finite integers). Such fields are dropped (treated as not provided) with a diagnostic.
  const details: NonNullable<AnalyzeRunInput["details"]> = {};
  for (const [id, d] of Object.entries(input.details ?? {})) {
    const clean: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(d ?? {})) {
      if (typeof v === "number" && !Number.isSafeInteger(v)) {
        diagnostics.push({ code: "invalid_detail", message: `Event ${id}: detail ${k} is not an integer; ignored.`, event_ids: [id] });
        continue;
      }
      clean[k] = v;
    }
    details[id] = clean as (typeof details)[string];
  }
  const unprocessed: UnprocessedEvent[] = [];
  const { policy, issues } = normalizePolicy(input.policy);
  for (const i of issues) diagnostics.push({ code: "policy_rule_unrecognized", message: `Policy rule ${i.rule_id}: ${i.message}`, event_ids: [] });
  if (!policy) diagnostics.push({ code: "policy_missing", message: "No policy supplied: permission violations cannot be evaluated for this run.", event_ids: [] });

  // ---- S0: validate, deduplicate identical ids, sort
  const seen = new Map<string, Event>();
  const timed: TimedEvent[] = [];
  const sortedInput = [...input.events].sort((a, b) => cmpStr(a.id, b.id) || cmpStr(hashCanonical(a), hashCanonical(b)));
  for (const e of sortedInput) {
    if (seen.has(e.id)) {
      unprocessed.push({ event_id: e.id, reason: "duplicate event id (re-ingested record); the first copy is analyzed" });
      diagnostics.push({ code: "duplicate_event_id", message: `Event id ${e.id} appears more than once in the input.`, event_ids: [e.id] });
      continue;
    }
    seen.set(e.id, e);
    if (e.run_id !== run.id) {
      unprocessed.push({ event_id: e.id, reason: `belongs to run ${e.run_id}, not ${run.id}` });
      diagnostics.push({ code: "run_mismatch", message: `Event ${e.id} belongs to a different run.`, event_ids: [e.id] });
      continue;
    }
    // Provenance: basis is fixed by the source (EVENT_SOURCE_BASIS). A record whose basis disagrees with its source
    // (e.g. a transcript entry labelled "observed") is never used as evidence: otherwise an agent-side channel could
    // inject records the engine would treat as independent observation.
    if (EVENT_SOURCE_BASIS[e.source] !== e.basis) {
      unprocessed.push({ event_id: e.id, reason: `basis ${e.basis} does not match source ${e.source} (expected ${EVENT_SOURCE_BASIS[e.source]})` });
      diagnostics.push({ code: "basis_source_mismatch", message: `Event ${e.id} claims basis ${e.basis} but source ${e.source} implies ${EVENT_SOURCE_BASIS[e.source]}; excluded from analysis.`, event_ids: [e.id] });
      continue;
    }
    const t = parseIsoMicros(e.timestamp);
    if (t === null) {
      unprocessed.push({ event_id: e.id, reason: "unparseable timestamp" });
      diagnostics.push({ code: "invalid_timestamp", message: `Event ${e.id} has an unparseable timestamp.`, event_ids: [e.id] });
      continue;
    }
    timed.push({ e, t, d: details[e.id] ?? {} });
  }
  timed.sort(eventOrder);
  const observedEvents = timed.filter((x) => x.e.basis === "observed" && x.e.event_type !== "collector_status");
  const collectorStatus = timed.filter((x) => x.e.basis === "observed" && x.e.event_type === "collector_status");
  const reportedEvents = timed.filter((x) => x.e.basis === "reported");
  for (const x of timed.filter((x) => x.e.basis === "derived")) unprocessed.push({ event_id: x.e.id, reason: "derived records are analysis outputs, not inputs" });

  const runStart = parseIsoMicros(run.started_at) ?? (timed[0]?.t ?? 0);
  // reduce, not Math.max(...spread): spreading 100k+ events overflows the call stack (RangeError) on real runs
  const runEnd = (run.ended_at ? parseIsoMicros(run.ended_at) : null) ?? timed.reduce((m, x) => (x.t > m ? x.t : m), runStart);

  // ---- S1..S4
  const observations = buildObservations(observedEvents, ctx, diagnostics).sort((a, b) => a.t - b.t || cmpStr(a.id, b.id));
  const { calls, contextEventIds } = buildReportedCalls(reportedEvents, ctx, runEnd, diagnostics);
  const tree = buildProcTree(observations, ctx, diagnostics);
  const { attributions } = attributeAll(observations, calls, tree, ctx, diagnostics);
  const callsById = new Map(calls.map((c) => [c.toolUseId, c]));
  const obsById = new Map(observations.map((o) => [o.id, o]));

  // ---- S5: noise classification (visible)
  const noise = new Map<string, NoiseMatch>();
  for (const o of observations) {
    const m = classifyNoise(o, attributions.get(o.id), { tree, ctx, attributions, observations });
    if (m) noise.set(o.id, m);
  }
  const suppressed: SuppressedEvent[] = [];
  for (const [oid, m] of noise) {
    for (const eid of obsById.get(oid)!.constituents) {
      suppressed.push({ event_id: eid, logical_observation_id: oid, rule_id: m.rule.id, noise_class: m.rule.noise_class, noise_model_version: NOISE_MODEL_VERSION, rationale: m.rule.rationale });
    }
  }
  suppressed.sort((a, b) => cmpStr(a.event_id, b.event_id));

  // ---- S6: footprint correlation (level B)
  const footprints = new Map<string, { obs: LogicalObservation | null; state: MatchState; reason: string | null }>();
  const rank: Record<MatchState, number> = { exact: 3, probable: 2, ambiguous: 1, unmatched_observed: 0, unmatched_reported: 0 };
  // Index observations by the calls they could belong to (attributed call, or any candidate of an ambiguous
  // attribution) so each call scans only its own candidates instead of every observation (was O(calls x observations)).
  const obsByCall = new Map<string, Set<LogicalObservation>>();
  for (const o of observations) {
    const a = attributions.get(o.id);
    if (!a) continue;
    const ids = new Set<string>();
    if (a.toolUseId) ids.add(a.toolUseId);
    if (a.state === "ambiguous") for (const x of a.candidates) ids.add(x.toolUseId);
    for (const id of ids) {
      const s = obsByCall.get(id) ?? new Set<LogicalObservation>();
      s.add(o);
      obsByCall.set(id, s);
    }
  }
  for (const c of calls) {
    const kind = primaryKind(c.toolName);
    if (!kind) continue;
    const attributed = [...(obsByCall.get(c.toolUseId) ?? [])].filter((o) => {
      const a = attributions.get(o.id);
      if (!a || o.kind !== kind) return false;
      const isCand = a.toolUseId === c.toolUseId || (a.state === "ambiguous" && a.candidates.some((x) => x.toolUseId === c.toolUseId));
      if (!isCand) return false;
      if (kind === "proc.exec") return a.method === "command_binding" || a.method === "tool_use_id";
      if (kind === "net.connect") return !!o.host && o.host === c.host;
      return !!o.path?.key && o.path.key === c.path?.key;
    });
    // best match state first; within it the LAST attempt counts (internal retries)
    attributed.sort((x, y) => rank[attributions.get(y.id)!.state] - rank[attributions.get(x.id)!.state] || y.t - x.t || cmpStr(x.id, y.id));
    const best = attributed[0];
    if (best) {
      const a = attributions.get(best.id)!;
      footprints.set(c.toolUseId, { obs: best, state: a.toolUseId === c.toolUseId ? a.state : "ambiguous", reason: null });
    } else {
      const st = categoryState(input.coverage, intentCoverage(c));
      const reason = c.outcome === "denied" ? "denied_by_agent_layer (no footprint expected)" : st === "observed" ? "not_found" : `coverage_gap (${intentCoverage(c)} ${st})`;
      footprints.set(c.toolUseId, { obs: null, state: "unmatched_reported", reason });
    }
  }

  // ---- S7: policy evaluation (every observed action; reported intents without an observed footprint)
  const decisions: PolicyDecisionRecord[] = [];
  const decisionsByObs = new Map<string, { record: PolicyDecisionRecord; evaluation: PolicyEvaluation }>();
  const intentDecisions = new Map<string, { record: PolicyDecisionRecord; evaluation: PolicyEvaluation }>();
  if (policy) {
    for (const o of observations) {
      const act = toPolicyAction(o);
      if (!act) continue;
      const ev = evaluatePolicy(policy, act, ctx);
      if (ev.decision === "not_covered") continue;
      const outcome = o.outcome.disputed ? "cannot_determine" : o.outcome.value;
      const cls = classify(ev.decision, outcome);
      const rec: PolicyDecisionRecord = {
        id: makeStableId("correlation", run.id, "decision", o.id, policy.version_id).replace(/^cor_/, "dec_"),
        subject: "observed_action",
        logical_observation_id: o.id,
        tool_use_id: attributions.get(o.id)?.toolUseId ?? null,
        event_ids: o.constituents,
        action: act.kind,
        resource: resourceLabel(o),
        decision: ev.decision,
        step: ev.step,
        deciding_rule_id: ev.decidingRuleId,
        matched_rule_ids: ev.matchedRuleIds,
        classification: cls,
        outcome: o.outcome.disputed ? "disputed" : o.outcome.value + (o.outcome.level ? `:${o.outcome.level}` : ""),
        blocked_by: o.outcome.blockedBy,
        policy_version_id: policy.version_id,
        reason: cls === "undetermined" ? "outcome not established by the available telemetry (not treated as safe)" : `${ev.step}${ev.decidingRuleId ? ` (${ev.decidingRuleId})` : ""}`,
      };
      decisions.push(rec);
      decisionsByObs.set(o.id, { record: rec, evaluation: ev });
    }
    for (const c of calls) {
      const fp = footprints.get(c.toolUseId);
      if (!fp || fp.obs) continue;
      const act = intentAction(c);
      if (!act) continue;
      const ev = evaluatePolicy(policy, act, ctx);
      if (ev.decision === "not_covered") continue;
      const cov = categoryState(input.coverage, intentCoverage(c));
      let cls = classify(ev.decision, "cannot_determine");
      let blockedBy: string | null = null;
      let reason = `no observed action; ${intentCoverage(c)} coverage ${cov}`;
      if (ev.decision === "deny" && c.outcome === "denied" && cov === "observed") {
        cls = "violation_blocked";
        blockedBy = "agent_layer";
        reason = "Claude Code recorded a permission denial and no action was observed while coverage was active";
      }
      const rec: PolicyDecisionRecord = {
        id: makeStableId("correlation", run.id, "intent", c.toolUseId, policy.version_id).replace(/^cor_/, "dec_"),
        subject: "reported_intent",
        logical_observation_id: null,
        tool_use_id: c.toolUseId,
        event_ids: c.eventIds,
        action: act.kind,
        resource: c.target ?? "?",
        decision: ev.decision as "allow" | "deny",
        step: ev.step,
        deciding_rule_id: ev.decidingRuleId,
        matched_rule_ids: ev.matchedRuleIds,
        classification: cls,
        outcome: `reported:${c.outcome}`,
        blocked_by: blockedBy,
        policy_version_id: policy.version_id,
        reason,
      };
      decisions.push(rec);
      intentDecisions.set(c.toolUseId, { record: rec, evaluation: ev });
    }
  }
  decisions.sort((a, b) => cmpStr(a.id, b.id));

  // ---- S8: discrepancy rules
  const notes: AnalysisResult["notes"] = [];
  if (inferredRoot) {
    notes.push({ code: "workspace_root_inferred", message: `Workspace root not supplied; inferred ${inferredRoot.root} from ${inferredRoot.support} repository-relative path(s) matching absolute paths in this run.`, event_ids: [] });
  }
  const ruleInputs: RuleInputs = { ctx, coverage: input.coverage, policy, observations, attributions, calls, tree, noise, decisionsByObs, intentDecisions, footprints, notes, diagnostics };
  const candidates = runRules(ruleInputs);

  // ---- S8b: narrative rules (the agent's final report vs observed records)
  let lastMsg: TimedEvent | null = null;
  for (const x of reportedEvents) if (x.e.event_type === "agent_message" && (!lastMsg || x.t > lastMsg.t)) lastMsg = x;
  const excerpts = new Map((input.evidence ?? []).map((ev) => [ev.id, ev.excerpt ?? null]));
  const finalReport: ReportText | null = lastMsg ? reportTextFor(lastMsg, lastMsg.e.evidence_id ? excerpts.get(lastMsg.e.evidence_id) : null) : null;
  const narrative = runNarrativeRules(ruleInputs, finalReport, reportedEvents.length > 0);
  for (const c of candidates) {
    // A subprocess write the command never names, on a path whose change the final report contradicts: the report
    // discrepancy is the change mismatch (narrative finding); the write itself is presented as an unreported action.
    if (c.ruleId !== RULES.D3undeclared || !c.resourceKey?.startsWith("path:") || !narrative.contradictedChangeKeys.has(c.resourceKey.slice(5))) continue;
    c.category = "unreported_observed_action";
    c.ruleId = RULES.D1undeclaredPersisted;
    c.claims = c.claims.filter((x) => !x.reason.startsWith("command text does not name the file"));
    c.confidenceCap = null;
    c.severityInput = { ...c.severityInput, category: "unreported_observed_action" };
    c.missingInformation = c.missingInformation.filter((m) => !m.startsWith("The agent's final report text is not evaluated"));
  }
  candidates.push(...narrative.candidates);

  // ---- S9: cluster + rubric
  const { findings, annotations } = clusterFindings(candidates, run, policy?.version_id ?? null, rulesetVersion, timed);

  // ---- correlations output
  const correlations = buildCorrelations(observations, calls, attributions, footprints, noise, run.id);
  const schemaCorrelations: EventCorrelation[] = correlations.map((c) => ({
    id: c.id,
    run_id: run.id,
    is_fixture: run.is_fixture,
    reported_event_id: c.reported_event_ids[0] ?? null,
    observed_event_id: c.observed_event_ids[0] ?? null,
    match: c.schema_match,
    confidence: c.confidence,
    note: [c.state, c.method !== "none" ? `via ${c.method}` : null, c.reason].filter(Boolean).join("; ") || null,
  }));

  const inObs = new Set(observations.flatMap((o) => o.constituents));
  const inCalls = new Set(calls.flatMap((c) => c.eventIds));
  const accounting = {
    input_events: input.events.length,
    observed_in_observations: inObs.size,
    reported_in_calls: inCalls.size,
    reported_context: contextEventIds.length,
    collector_status: collectorStatus.length,
    unprocessed: unprocessed.length,
  };

  const manifest = {
    engine: ENGINE_VERSION,
    ruleset: rulesetVersion,
    noise: NOISE_MODEL_VERSION,
    run: run.id,
    events: uniqSorted(input.events.map((e) => hashCanonical(e))),
    policy: input.policy ? hashCanonical(input.policy) : null,
    coverage: input.coverage ? hashCanonical(input.coverage) : null,
    context: hashCanonical(ctx),
    details: hashCanonical(details),
    report: finalReport ? hashCanonical({ id: finalReport.event.e.id, text: finalReport.text, origin: finalReport.origin }) : null,
  };
  const analysisId = "ana_" + hashCanonical(manifest).slice(0, 24);

  return {
    analysisVersion: `kw-analysis@${ENGINE_VERSION}/${rulesetVersion}/${NOISE_MODEL_VERSION}/${analysisId}`,
    analysisId,
    engineVersion: ENGINE_VERSION,
    rulesetVersion,
    noiseModelVersion: NOISE_MODEL_VERSION,
    policyVersionId: policy?.version_id ?? null,
    correlations,
    schemaCorrelations,
    findings,
    annotations,
    suppressed,
    decisions,
    observations,
    reportedCalls: calls,
    attributions: [...attributions.values()].sort((a, b) => cmpStr(a.observationId, b.observationId)),
    notes: notes.sort((a, b) => cmpStr(a.code, b.code) || cmpStr(a.message, b.message)),
    diagnostics: dedupeDiagnostics(diagnostics),
    unprocessed: unprocessed.sort((a, b) => cmpStr(a.event_id, b.event_id) || cmpStr(a.reason, b.reason)),
    accounting,
  };
}

function dedupeDiagnostics(list: Diagnostic[]): Diagnostic[] {
  const m = new Map<string, Diagnostic>();
  for (const d of list) m.set(`${d.code}|${d.message}|${d.event_ids.join(",")}`, d);
  return [...m.values()].sort((a, b) => cmpStr(a.code, b.code) || cmpStr(a.message, b.message));
}

function buildCorrelations(
  observations: LogicalObservation[],
  calls: ReportedCall[],
  attributions: Map<string, Attribution>,
  footprints: Map<string, { obs: LogicalObservation | null; state: MatchState; reason: string | null }>,
  noise: Map<string, NoiseMatch>,
  runId: string,
): CorrelationRecord[] {
  const out: CorrelationRecord[] = [];
  const callsById = new Map(calls.map((c) => [c.toolUseId, c]));
  const primaryObs = new Map<string, string>();
  for (const [tid, f] of footprints) if (f.obs) primaryObs.set(f.obs.id, tid);
  const conf = (s: MatchState): "high" | "medium" | "low" => (s === "exact" ? "high" : s === "probable" ? "medium" : "low");
  for (const o of observations) {
    if (o.kind === "fs.change" || o.kind === "proc.exit") continue;
    const a = attributions.get(o.id);
    if (!a) continue;
    const call = a.toolUseId ? callsById.get(a.toolUseId) : undefined;
    const isPrimary = primaryObs.get(o.id) === a.toolUseId && a.toolUseId !== null;
    const state: MatchState = a.scope === "tool_call" ? a.state : "unmatched_observed";
    const nm = noise.get(o.id);
    out.push({
      id: makeStableId("correlation", runId, o.id, a.toolUseId ?? "-"),
      state,
      schema_match: schemaMatch(state),
      confidence: state === "unmatched_observed" ? (a.lineageToAgent ? "high" : "medium") : conf(state),
      method: a.method,
      score: a.score,
      tool_use_id: a.toolUseId,
      tool_name: call?.toolName ?? null,
      reported_event_ids: call?.eventIds ?? [],
      observed_event_ids: o.constituents,
      logical_observation_id: o.id,
      role: state === "unmatched_observed" ? "unmatched" : isPrimary ? "primary_footprint" : "in_scope",
      alternatives: a.candidates.slice(0, 4).map((c) => ({ tool_use_id: c.toolUseId, score: c.score })),
      reason: [a.scope !== "tool_call" ? `scope ${a.scope}` : null, a.note, nm ? `noise ${nm.rule.id}` : null].filter(Boolean).join("; ") || null,
    });
  }
  for (const c of calls) {
    const f = footprints.get(c.toolUseId);
    if (!f || f.obs) continue;
    out.push({
      id: makeStableId("correlation", runId, "-", c.toolUseId),
      state: "unmatched_reported",
      schema_match: "reported_only",
      confidence: f.reason === "not_found" ? "medium" : "low",
      method: "none",
      score: 0,
      tool_use_id: c.toolUseId,
      tool_name: c.toolName,
      reported_event_ids: c.eventIds,
      observed_event_ids: [],
      logical_observation_id: null,
      role: "unmatched",
      alternatives: [],
      reason: f.reason,
    });
  }
  return out.sort((a, b) => cmpStr(a.id, b.id));
}

function clusterFindings(
  candidates: CandidateFinding[],
  run: AnalyzeRunInput["run"],
  policyVersionId: string | null,
  rulesetVersion: string,
  timed: TimedEvent[],
): { findings: Finding[]; annotations: FindingAnnotation[] } {
  // merge change-mismatch candidates into an observation cluster on the same path (one finding per underlying action)
  const byKey = new Map<string, CandidateFinding[]>();
  for (const c of candidates) {
    const l = byKey.get(c.clusterKey) ?? [];
    l.push(c);
    byKey.set(c.clusterKey, l);
  }
  for (const [key, list] of [...byKey.entries()]) {
    if (!key.startsWith("path:")) continue;
    const target = [...byKey.keys()].filter((k) => k !== key && k.endsWith(`|file.write|${key}`)).sort(cmpStr)[0];
    if (target) {
      byKey.get(target)!.push(...list);
      byKey.delete(key);
    }
  }
  const findings: Finding[] = [];
  const annotations: FindingAnnotation[] = [];
  // latest event by parsed time (string comparison is wrong when timestamps carry different UTC offsets)
  const startT = parseIsoMicros(run.started_at);
  const stamp = run.ended_at ?? timed.reduce<{ ts: string; t: number | null }>((acc, x) => (acc.t === null || x.t > acc.t ? { ts: x.e.timestamp, t: x.t } : acc), { ts: run.started_at, t: startT }).ts;
  for (const [key, list] of [...byKey.entries()].sort((a, b) => cmpStr(a[0], b[0]))) {
    const sorted = [...list].sort((a, b) => PRECEDENCE.indexOf(a.category) - PRECEDENCE.indexOf(b.category) || cmpStr(a.ruleId, b.ruleId));
    const primary = sorted[0]!;
    const secondary = sorted.slice(1).filter((c, i, arr) => arr.findIndex((x) => x.ruleId === c.ruleId) === i && c.ruleId !== primary.ruleId);
    let confidence = confidenceFromClaims(primary.claims);
    if (primary.confidenceCap) confidence = minConfidence(confidence, primary.confidenceCap);
    const hasD5 = primary.category !== "uncertain_correlation" && secondary.some((s) => s.category === "uncertain_correlation");
    if (hasD5) confidence = "low";
    const sev = computeSeverity(primary.severityInput);
    const related = uniqSorted(sorted.flatMap((c) => c.relatedEventIds));
    const evidence = uniqSorted(sorted.flatMap((c) => c.evidenceIds));
    const ruleIdForPolicy = primary.policyRuleId ?? sorted.find((c) => c.policyRuleId)?.policyRuleId ?? null;
    const id = makeStableId("finding", run.id, primary.category, ...related, rulesetVersion);
    const also = secondary.length ? ` Also: ${uniqSorted(secondary.map((s) => FINDING_CATEGORY_LABELS[s.category])).join(", ")}.` : "";
    const demoted = hasD5 ? " Confidence lowered: attribution of this action is uncertain (see Uncertain correlation)." : "";
    findings.push({
      id,
      run_id: run.id,
      is_fixture: run.is_fixture,
      category: primary.category,
      title: primary.title.length > 300 ? primary.title.slice(0, 297) + "..." : primary.title,
      description: primary.description + also + demoted,
      severity: sev.severity,
      confidence,
      status: "new",
      policy_id: ruleIdForPolicy ? policyVersionId : null,
      policy_rule_id: ruleIdForPolicy,
      recommended_next_step: primary.nextStep,
      missing_information: uniqSorted(sorted.flatMap((c) => c.missingInformation)),
      related_event_ids: related,
      evidence_ids: evidence,
      recurrence_of_finding_id: null,
      created_at: stamp,
      updated_at: stamp,
    });
    annotations.push({
      finding_id: id,
      rule_id: primary.ruleId,
      secondary: secondary.map((s) => ({ category: s.category, rule_id: s.ruleId })),
      confidence_basis: primary.claims,
      severity_basis: sev.basis,
      match_state: primary.matchState,
      policy_classification: primary.classification,
      cluster_key: key,
    });
  }
  const order = new Map(findings.map((f) => [f.id, f]));
  findings.sort((a, b) => SEVERITY_ORDER[b.severity] - SEVERITY_ORDER[a.severity] || cmpStr(a.id, b.id));
  annotations.sort((a, b) => {
    const fa = order.get(a.finding_id)!;
    const fb = order.get(b.finding_id)!;
    return SEVERITY_ORDER[fb.severity] - SEVERITY_ORDER[fa.severity] || cmpStr(a.finding_id, b.finding_id);
  });
  return { findings, annotations };
}

export { SHELL_TOOLS };
