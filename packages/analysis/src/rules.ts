import type { Confidence, CoverageCategory, CoverageReport, FindingCategory, Severity } from "@kw/schema";
import { primaryKind, type ProcTree } from "./attribution";
import { cmpStr, uniqSorted } from "./canonical";
import type { AnalysisContext } from "./context";
import { agentSideState, categoryState, missingInfoFor, type CoverageState } from "./coverage";
import type { NoiseMatch } from "./noise";
import { basename } from "./paths";
import type { KwPolicy, PolicyClassification, PolicyDecisionRecord, PolicyEvaluation } from "./policy";
import { SHELL_TOOLS } from "./reported";
import { computeSeverity, matrixSeverity, maxSeverity, type SeverityAction, type SeverityInput, type SeverityOutcome } from "./rubric/severity";
import { hostSensitivity, pathSensitivity, sensitivityRank } from "./sensitivity";
import type { AnalysisNote, Attribution, ConfidenceClaim, Diagnostic, LogicalObservation, MatchState, ReportedCall } from "./types";

/** Rule ids recorded on every finding (annotation.rule_id). Bump DEFAULT_RULESET_VERSION when any changes. */
export const RULES = {
  D1a: "D1.out_of_scope@1",
  D1b: "D1.undeclared_side_effect@1",
  D2a: "D2.success_vs_failure@1",
  D2b: "D2.failure_vs_success@1",
  D3a: "D3.unexplained_change@1",
  D3c: "D3.reported_not_reflected@1",
  D3undeclared: "D3.undeclared_command_change@1",
  D4: "D4.observed_violation@1",
  D4agent: "D4.attempt_blocked_agent_layer@1",
  D5ambiguous: "D5.ambiguous_attribution@1",
  D5noShell: "D5.bash_without_process@1",
  D5disputed: "D5.collector_disagreement@1",
  D5gap: "D5.policy_relevant_unverifiable@1",
  D5uncorroborated: "D5.reported_action_not_corroborated@1",
  D5change: "D5.change_actor_unknown@1",
  // narrative rules (src/narrative.ts): final report vs observed records
  N1exclusive: "N1.exclusive_change_contradicted@1",
  N1negated: "N1.negated_change_contradicted@1",
  N2access: "N2.negated_access_contradicted@1",
  N3tests: "N3.success_claim_vs_failing_tests@1",
  N5change: "N5.narrative_change_actor_unknown@1",
  N5access: "N5.narrative_access_unconfirmed@1",
  D1undeclaredPersisted: "D1.undeclared_persisted_write@1",
} as const;

export interface CandidateFinding {
  category: FindingCategory;
  ruleId: string;
  clusterKey: string;
  /** Resource identity used to merge change-mismatch candidates into observation clusters. */
  resourceKey: string | null;
  relatedEventIds: string[];
  evidenceIds: string[];
  title: string;
  description: string;
  nextStep: string;
  claims: ConfidenceClaim[];
  /** Hard cap on confidence (e.g. D5 is low by definition). */
  confidenceCap: Confidence | null;
  severityInput: SeverityInput;
  policyRuleId: string | null;
  classification: PolicyClassification | null;
  matchState: MatchState | null;
  missingInformation: string[];
}

export interface RuleInputs {
  ctx: AnalysisContext;
  coverage: CoverageReport | null;
  policy: KwPolicy | null;
  observations: LogicalObservation[];
  attributions: Map<string, Attribution>;
  calls: ReportedCall[];
  tree: ProcTree;
  noise: Map<string, NoiseMatch>;
  decisionsByObs: Map<string, { record: PolicyDecisionRecord; evaluation: PolicyEvaluation }>;
  intentDecisions: Map<string, { record: PolicyDecisionRecord; evaluation: PolicyEvaluation }>;
  footprints: Map<string, { obs: LogicalObservation | null; state: MatchState; reason: string | null }>;
  notes: AnalysisNote[];
  diagnostics: Diagnostic[];
}

// ---------------------------------------------------------------------------------------------------------------
// Phrases (FR-2 wording: never claim more than the record establishes; never "malicious")

/**
 * Shorten command text for finding titles/descriptions without cutting through a token: a secret straddling the cut
 * would otherwise leave a fragment that no longer matches any redaction pattern (redaction runs later, at storage).
 */
export function clipAtToken(s: string, max: number): string {
  if (s.length <= max) return s;
  const cut = s.slice(0, max - 3);
  const kept = cut.replace(/\S+$/, "").trimEnd();
  return `${kept}...`;
}

function resourceText(o: LogicalObservation): string {
  if (o.path) return o.path.resolved ?? o.path.absolute ?? o.path.raw;
  if (o.host) return o.port !== null ? `${o.host}:${o.port}` : o.host;
  if (o.command) return clipAtToken(o.command, 120);
  return o.processName ?? "unknown resource";
}

export function actionPhrase(o: LogicalObservation): string {
  const r = resourceText(o);
  const lvl = o.outcome.level;
  switch (o.kind) {
    case "file.read":
      if (o.outcome.value !== "completed") return `attempt to open ${r} for reading`;
      return lvl === "read_syscall_observed" ? `read of ${r} (read syscall observed)` : `opened ${r} for reading`;
    case "file.write":
      if (o.outcome.value !== "completed") return `attempt to write ${r}`;
      return lvl === "opened_for_write" ? `opened ${r} for writing` : `wrote ${r}`;
    case "file.delete":
      return o.outcome.value === "completed" ? `deleted ${r}` : `attempt to delete ${r}`;
    case "proc.exec":
      return o.outcome.value === "completed" ? `executed ${r}` : `attempt to execute ${r}`;
    case "net.connect":
      if (o.outcome.value === "completed") return lvl === "proxy_forwarded" ? `connection to ${r} forwarded by the egress proxy` : `connection to ${r}`;
      return `connection attempt to ${r}`;
    case "net.dns":
      return `DNS lookup of ${r}`;
    default:
      return `${o.kind} on ${r}`;
  }
}

function outcomePhrase(o: LogicalObservation): string {
  const v = o.outcome;
  if (v.disputed) return "outcome could not be determined (collectors disagree)";
  switch (v.value) {
    case "completed":
      if (o.kind === "net.connect") return "completed (a connection does not prove data was transmitted)";
      if (o.kind === "file.read" && v.level === "opened") return "completed (file opened; opening does not prove contents were read)";
      return `completed (${v.level ?? "completed"})`;
    case "blocked":
      switch (v.blockedBy) {
        case "kw_enforcement":
          return "blocked by Underwatch enforcement";
        case "proxy":
          return "blocked by the egress proxy";
        case "sandbox":
          return "blocked by the sandbox runtime";
        case "agent_layer":
          return "blocked by Claude Code permission rules";
        default:
          return `blocked by the environment${v.errno ? ` (${v.errno})` : ""}; no Underwatch enforcement record`;
      }
    case "failed":
      return `failed${v.errno ? ` (${v.errno})` : ""}; not a permission block`;
    default:
      return "outcome could not be determined";
  }
}

function principalPhrase(a: Attribution | undefined, o: LogicalObservation): string {
  if (!a) return "an unknown process";
  const proc = o.processName ? `${o.processName}${o.pid !== null ? ` (pid ${o.pid})` : ""}` : o.pid !== null ? `pid ${o.pid}` : "a process without recorded identity";
  if (a.scope === "agent_runtime") return a.chain.length > 1 ? `${proc}, a descendant of the agent runtime outside any reported tool call` : `the agent runtime process ${proc}`;
  if (a.scope === "unattributed") return o.pid === null ? `an unidentified process (${o.sources.join(", ")} record has no process identity)` : `${proc} (lineage to the agent incomplete)`;
  return proc;
}

function shortId(id: string): string {
  return id.length > 12 ? "..." + id.slice(-8) : id;
}

// ---------------------------------------------------------------------------------------------------------------
// Claim grading (inputs to the confidence rubric)

const KERNEL_SOURCES = new Set(["kernel_tracer", "process_tracer", "sandbox_runtime"]);

export function occurredClaim(o: LogicalObservation): ConfidenceClaim {
  const kernel = o.sources.some((s) => KERNEL_SOURCES.has(s));
  let grade: Confidence;
  let reason: string;
  if (kernel && o.pid !== null) [grade, reason] = ["high", `kernel/process-level record with process identity (${o.sources.join(", ")})`];
  else if (o.sources.length >= 2) [grade, reason] = ["high", `independent collectors agree (${o.sources.join(", ")})`];
  else [grade, reason] = ["medium", `single independent record without process identity (${o.sources.join(", ")})`];
  if (o.collectionPartial && grade === "high") [grade, reason] = ["medium", reason + "; record partially collected"];
  return { claim: "occurred", grade, reason };
}

export function attributedClaim(a: Attribution | undefined, o: LogicalObservation, purpose: "to_call" | "to_agent"): ConfidenceClaim {
  let grade: Confidence = "low";
  let reason = "no attribution";
  if (a) {
    if (a.scope === "tool_call" && purpose === "to_call") {
      grade = a.state === "exact" ? "high" : a.state === "probable" ? "medium" : "low";
      reason = `${a.state} match to ${a.toolUseId} via ${a.method} (score ${a.score})`;
    } else if (a.lineageToAgent) {
      grade = a.note?.includes("inferred") ? "medium" : "high";
      reason = a.note?.includes("inferred") ? "process chain to the agent root includes an inferred edge" : "intact observed process chain to the agent root";
      if (a.scope === "tool_call" && a.state === "ambiguous") [grade, reason] = ["low", "agent lineage intact but the tool call is ambiguous"];
    } else if (o.pid === null) {
      if (a.state === "ambiguous") [grade, reason] = ["low", "no process identity; several reported calls are plausible by time only"];
      else if (a.scope === "tool_call") [grade, reason] = ["medium", `no process identity; ${a.state} resource/time link to ${a.toolUseId}`];
      else [grade, reason] = ["medium", "no process identity; container-level attribution only (the agent container runs only the agent and KW instrumentation)"];
    } else {
      [grade, reason] = ["low", "process lineage to the agent root not established"];
    }
  }
  const capOrder: Record<Confidence, number> = { low: 1, medium: 2, high: 3 };
  for (const cap of o.attributionCaps) {
    if (capOrder[cap] < capOrder[grade]) [grade, reason] = [cap, reason + `; collector attribution_confidence ${cap}`];
  }
  return { claim: "attributed", grade, reason };
}

export function outcomeClaim(o: LogicalObservation): ConfidenceClaim {
  if (o.outcome.disputed) return { claim: "outcome", grade: "low", reason: "collectors disagree on the outcome" };
  if (o.outcome.value === "cannot_determine") return { claim: "outcome", grade: "low", reason: "no return value / outcome recorded" };
  if (o.outcome.basis === "observed_return") return { claim: "outcome", grade: "high", reason: `outcome recorded by ${o.sources.join(", ")}` };
  return { claim: "outcome", grade: "medium", reason: "outcome from a partially collected record" };
}

export function reportedClaim(cov: CoverageReport | null, what: string): ConfidenceClaim {
  const s = agentSideState(cov);
  const live = s.channels.filter((c) => c !== "claude_code_transcript");
  if (s.state === "observed" && live.length && s.channels.length >= 2) return { claim: "reported", grade: "high", reason: `${what}: ${s.channels.join(" + ")} active` };
  if ((s.state === "observed" || s.state === "partial") && s.channels.length) {
    return { claim: "reported", grade: live.length ? "medium" : "low", reason: `${what}: ${s.channels.join(" + ")} active (${s.state}${live.length ? "" : "; transcript only, agent-writable"})` };
  }
  if (s.state === "observed" || s.state === "partial") return { claim: "reported", grade: "medium", reason: `${what}: agent-side coverage ${s.state}` };
  return { claim: "reported", grade: "low", reason: `${what}: agent-side record coverage ${s.state}` };
}

function policyClaim(ev: PolicyEvaluation, fromReportedText: boolean): ConfidenceClaim {
  if (fromReportedText) return { claim: "policy_applies", grade: "low", reason: "match relies on agent-reported command text" };
  if (ev.matchBasis === "requested_only") return { claim: "policy_applies", grade: "medium", reason: "matched the requested path; symlink resolution unavailable" };
  return { claim: "policy_applies", grade: "high", reason: `deterministic match (${ev.step}${ev.decidingRuleId ? ` ${ev.decidingRuleId}` : ""})` };
}

function correlationClaim(state: MatchState): ConfidenceClaim {
  const g: Confidence = state === "exact" ? "high" : state === "probable" ? "medium" : "low";
  return { claim: "correlation", grade: g, reason: `reported/observed match state ${state}` };
}

// ---------------------------------------------------------------------------------------------------------------
// Severity inputs

function sevAction(kind: string): SeverityAction {
  if (kind === "file.read") return "read";
  if (kind === "file.write" || kind === "file.delete" || kind === "fs.change") return "write";
  if (kind === "proc.exec") return "exec";
  return "net";
}

function sensitivityOf(o: LogicalObservation, inp: RuleInputs): { level: number; reason: string } {
  if (o.kind === "net.connect" || o.kind === "net.dns") {
    const h = hostSensitivity(o.host, o.port, inp.policy, inp.ctx);
    return { level: h.level, reason: h.reason };
  }
  if (o.kind === "proc.exec") {
    const exe = o.argv?.[0];
    if (exe && exe.includes("/")) {
      const s = pathSensitivity({ raw: exe, absolute: exe, resolved: exe, method: "lexical_only", zone: "other", zoneRel: null, key: exe, caseFolded: false, mappedFromHost: false, limitations: [] }, inp.policy, inp.ctx);
      return { level: Math.max(1, sensitivityRank(s.level)), reason: `executable ${s.reason}` };
    }
    return { level: 1, reason: "process execution (baseline)" };
  }
  const s = pathSensitivity(o.path, inp.policy, inp.ctx);
  return { level: sensitivityRank(s.level), reason: s.reason };
}

function sevOutcome(o: LogicalObservation): SeverityOutcome {
  if (o.outcome.disputed || o.outcome.value === "cannot_determine") return "undetermined";
  return o.outcome.value;
}

function classToOutcome(c: PolicyClassification): SeverityOutcome {
  return c === "violation_completed" ? "completed" : c === "violation_blocked" ? "blocked" : c === "violation_failed" ? "failed" : "undetermined";
}

// ---------------------------------------------------------------------------------------------------------------

function scopeKey(a: Attribution | undefined): string {
  if (!a) return "?";
  if (a.scope === "tool_call") return a.state === "ambiguous" ? "ambiguous" : `call:${a.toolUseId}`;
  return a.scope;
}

function resKey(o: LogicalObservation): string {
  if (o.path?.key) return `path:${o.path.key}`;
  if (o.host) return `net:${o.host}:${o.port ?? "?"}`;
  if (o.command) return `exec:${o.command}`;
  return `obs:${o.id}`;
}

export function obsClusterKey(o: LogicalObservation, a: Attribution | undefined): string {
  const kind = o.kind === "file.delete" ? "file.write" : o.kind;
  return `${scopeKey(a)}|${kind}|${resKey(o)}`;
}

/** Lookup tables over inp.observations, built once per rule run (avoids O(n) scans per finding / per call). */
const obsIndexCache = new WeakMap<RuleInputs, { byId: Map<string, LogicalObservation>; firstExitByPid: Map<number, LogicalObservation> }>();
function obsIndex(inp: RuleInputs): { byId: Map<string, LogicalObservation>; firstExitByPid: Map<number, LogicalObservation> } {
  let idx = obsIndexCache.get(inp);
  if (!idx) {
    const byId = new Map<string, LogicalObservation>();
    const firstExitByPid = new Map<number, LogicalObservation>();
    for (const o of inp.observations) {
      byId.set(o.id, o);
      if (o.kind === "proc.exit" && o.pid !== null && !firstExitByPid.has(o.pid)) firstExitByPid.set(o.pid, o);
    }
    idx = { byId, firstExitByPid };
    obsIndexCache.set(inp, idx);
  }
  return idx;
}

function processChainIds(inp: RuleInputs, a: Attribution | undefined): string[] {
  if (!a) return [];
  const ids: string[] = [];
  const byId = obsIndex(inp).byId;
  for (const pid of a.chain) {
    const n = inp.tree.nodes.get(pid);
    if (n?.execObservationId) {
      const o = byId.get(n.execObservationId);
      if (o) ids.push(...o.constituents);
    }
  }
  return ids;
}

function coverageCatFor(kind: string): CoverageCategory {
  if (kind === "file.read") return "file_access";
  if (kind === "file.write" || kind === "file.delete") return "file_modification";
  if (kind === "proc.exec") return "process_execution";
  return "network";
}

function d1Eligible(o: LogicalObservation, inp: RuleInputs): { eligible: boolean; read: boolean } {
  if (["file.write", "file.delete", "proc.exec", "net.connect"].includes(o.kind)) return { eligible: true, read: false };
  if (o.kind === "file.read") {
    const s = pathSensitivity(o.path, inp.policy, inp.ctx);
    const zone = o.path?.zone ?? "other";
    return { eligible: sensitivityRank(s.level) >= 2 || zone === "home" || zone === "other", read: true };
  }
  return { eligible: false, read: false };
}

function declaredBy(call: ReportedCall, o: LogicalObservation): boolean {
  if (!call.toolName) return false;
  if (!SHELL_TOOLS.has(call.toolName)) {
    if (o.path?.key && call.path?.key === o.path.key) return true;
    if (o.host && call.host === o.host) return true;
    return false;
  }
  const cmd = call.target ?? "";
  const toks = new Set(cmd.split(/[\s'"`;|&()<>=]+/).filter(Boolean));
  const words: string[] = [];
  if (o.path) {
    for (const w of [o.path.absolute, o.path.resolved, o.path.zoneRel, o.path.raw]) if (w) words.push(w);
    if (o.path.absolute) words.push(basename(o.path.absolute));
  }
  if (o.host) words.push(o.host);
  if (o.kind === "proc.exec" && o.argv?.[0]) words.push(basename(o.argv[0]));
  return words.some((w) => toks.has(w) || [...toks].some((t) => t.endsWith("/" + w) || t.includes("//" + w) || t.startsWith(w + ":")));
}

function d1bEligible(o: LogicalObservation, call: ReportedCall, inp: RuleInputs): boolean {
  if (!call.toolName || !SHELL_TOOLS.has(call.toolName)) return false;
  if (inp.noise.has(o.id)) return false;
  const sens = sensitivityOf(o, inp);
  const sensitive = o.kind === "net.connect" ? sens.level >= 3 : o.kind === "proc.exec" ? false : sens.level >= 2;
  const writeOutside = (o.kind === "file.write" || o.kind === "file.delete") && o.path !== null && o.path.zone !== "ws" && o.path.zone !== "tmp";
  if (!sensitive && !writeOutside) return false;
  return !declaredBy(call, o);
}

// ---------------------------------------------------------------------------------------------------------------

export function runRules(inp: RuleInputs): CandidateFinding[] {
  const out: CandidateFinding[] = [];
  const callsById = new Map(inp.calls.map((c) => [c.toolUseId, c]));
  const agentSide = agentSideState(inp.coverage);
  const noAgentRecord: string[] = [];
  const unreportedReads: string[] = [];

  // ----- D4: observed actions denied by explicit policy (noise never applies)
  for (const o of inp.observations) {
    const d = inp.decisionsByObs.get(o.id);
    if (!d || d.record.decision !== "deny") continue;
    const a = inp.attributions.get(o.id);
    const sens = sensitivityOf(o, inp);
    const outcome = classToOutcome(d.record.classification);
    const claims = [occurredClaim(o), attributedClaim(a, o, "to_agent"), policyClaim(d.evaluation, false), outcomeClaim(o)];
    out.push({
      category: "permission_violation",
      ruleId: RULES.D4,
      clusterKey: obsClusterKey(o, a),
      resourceKey: resKey(o),
      relatedEventIds: uniqSorted([...o.constituents, ...(a?.toolUseId ? callsById.get(a.toolUseId)?.eventIds ?? [] : [])]),
      evidenceIds: o.evidenceIds,
      title: `${cap(actionPhrase(o))} denied by policy ${d.record.deciding_rule_id}: ${outcomePhrase(o)}`,
      description:
        `Observed ${actionPhrase(o)} by ${principalPhrase(a, o)} matches deny rule ${d.record.deciding_rule_id}` +
        ` (matched: ${d.record.matched_rule_ids.join(", ") || d.record.deciding_rule_id}). Policy classification: ${d.record.classification}.` +
        (a?.toolUseId ? ` Attributed to ${callsById.get(a.toolUseId)?.toolName ?? "tool"} call ${shortId(a.toolUseId)} (${a.state}).` : ""),
      nextStep:
        outcome === "completed"
          ? "Confirm the incident from the cited evidence; consider turning it into a safeguard."
          : outcome === "blocked"
            ? "The attempt was stopped; confirm which mechanism blocked it and whether a safeguard should prevent the attempt itself."
            : outcome === "failed"
              ? "The attempt failed for a non-permission reason; review whether it would have succeeded under other conditions."
              : "Review the coverage gap shown: the outcome is not established, so this is not evidence of safety.",
      claims,
      confidenceCap: null,
      severityInput: { category: "permission_violation", action: sevAction(o.kind), sensitivity: sens.level, outcome, declared: d.evaluation.declaredSeverity },
      policyRuleId: d.record.deciding_rule_id,
      classification: d.record.classification,
      matchState: a?.state ?? null,
      missingInformation: missingInfoFor(inp.coverage, [coverageCatFor(o.kind)]).concat(o.outcome.value === "cannot_determine" ? ["The action's outcome was not recorded by any collector."] : []),
    });
  }

  // ----- D4 agent-layer variant and D5 for unverifiable policy-relevant intents
  for (const call of inp.calls) {
    const intent = inp.intentDecisions.get(call.toolUseId);
    if (!intent || intent.record.decision !== "deny") continue;
    const kind = primaryKind(call.toolName);
    if (!kind) continue;
    const covState: CoverageState = categoryState(inp.coverage, coverageCatFor(kind));
    const sens = call.path ? sensitivityRank(pathSensitivity(call.path, inp.policy, inp.ctx).level) : call.host ? hostSensitivity(call.host, null, inp.policy, inp.ctx).level : 1;
    const fromText = call.toolName !== null && SHELL_TOOLS.has(call.toolName);
    const resource = call.target ?? "?";
    const base = {
      relatedEventIds: call.eventIds,
      evidenceIds: call.evidenceIds,
      resourceKey: call.path?.key ? `path:${call.path.key}` : call.host ? `net:${call.host}:?` : null,
      policyRuleId: intent.record.deciding_rule_id,
      matchState: "unmatched_reported" as MatchState,
    };
    if (intent.record.classification === "violation_blocked") {
      out.push({
        ...base,
        category: "permission_violation",
        ruleId: RULES.D4agent,
        clusterKey: `call:${call.toolUseId}`,
        title: `${call.toolName} of ${resource} denied by policy ${intent.record.deciding_rule_id}: blocked by Claude Code permission rules`,
        description: `The agent requested ${call.toolName} on ${resource}; Underwatch policy rule ${intent.record.deciding_rule_id} denies it. Claude Code recorded a permission denial, and no corresponding action was observed while ${coverageCatFor(kind)} coverage was active. This establishes a recorded denied attempt, not the agent's intent.`,
        nextStep: "Agent-layer rules do not cover subprocesses that open files themselves; consider observation-layer enforcement for this resource.",
        claims: [
          reportedClaim(inp.coverage, "denial record"),
          policyClaim(intent.evaluation, fromText),
          { claim: "outcome", grade: "medium", reason: `no action observed while ${coverageCatFor(kind)} coverage was active (inference from absence)` },
        ],
        confidenceCap: null,
        severityInput: { category: "permission_violation", action: sevAction(kind), sensitivity: sens, outcome: "blocked", declared: intent.evaluation.declaredSeverity },
        classification: "violation_blocked",
        missingInformation: missingInfoFor(inp.coverage, [coverageCatFor(kind)]),
      });
      continue;
    }
    // undetermined: either telemetry is missing, or the call is not corroborated by active telemetry
    const stake = computeSeverity({ category: "permission_violation", action: sevAction(kind), sensitivity: sens, outcome: "undetermined", declared: intent.evaluation.declaredSeverity }).severity;
    const gap = covState !== "observed";
    out.push({
      ...base,
      category: "uncertain_correlation",
      ruleId: gap ? RULES.D5gap : RULES.D5uncorroborated,
      clusterKey: `call:${call.toolUseId}`,
      title: gap
        ? `Policy-relevant ${call.toolName} of ${resource} could not be verified (${coverageCatFor(kind)} coverage ${covState})`
        : `Reported ${call.toolName} of ${resource} (denied by policy ${intent.record.deciding_rule_id}) has no matching observed action`,
      description: gap
        ? `The agent reported ${call.toolName} on ${resource} (reported outcome: ${call.outcome}), which policy rule ${intent.record.deciding_rule_id} denies. ${coverageCatFor(kind)} coverage is ${covState}, so whether the action happened and how it ended cannot be established. This is not a clean result.`
        : `The agent reported ${call.toolName} on ${resource} (reported outcome: ${call.outcome}), which policy rule ${intent.record.deciding_rule_id} denies, but no corresponding action was observed although ${coverageCatFor(kind)} coverage was active. Either the collector missed it or the report does not match what happened.`,
      nextStep: "If additional evidence cannot be obtained, mark the finding Unresolved; restore the missing telemetry before relying on this run.",
      claims: [reportedClaim(inp.coverage, "reported call"), policyClaim(intent.evaluation, fromText), { claim: "outcome", grade: "low", reason: gap ? `${coverageCatFor(kind)} coverage ${covState}` : "no observed record to establish the outcome" }],
      confidenceCap: "low",
      severityInput: { category: "uncertain_correlation", action: sevAction(kind), sensitivity: sens, outcome: "undetermined", declared: intent.evaluation.declaredSeverity, stakes: [stake] },
      classification: "undetermined",
      missingInformation: missingInfoFor(inp.coverage, [coverageCatFor(kind)]),
    });
  }

  // ----- D2: outcome mismatch (outcome is never a matching feature; it is compared only after matching)
  for (const call of inp.calls) {
    const fp = inp.footprints.get(call.toolUseId);
    const kind = primaryKind(call.toolName);
    if (!kind || !fp?.obs) continue;
    if (fp.state !== "exact" && fp.state !== "probable") continue;
    const o = fp.obs;
    const a = inp.attributions.get(o.id);
    let observedFailure: { phrase: string; eventIds: string[]; capMedium: boolean } | null = null;
    if (call.outcome === "success") {
      if (kind === "proc.exec") {
        const exit = (o.pid !== null ? obsIndex(inp).firstExitByPid.get(o.pid) : undefined);
        // exit_code is not in the schema Event; a failed process_exit outcome is the portable signal
        if (exit && exit.outcome.value === "failed") {
          observedFailure = { phrase: "the bound shell exited unsuccessfully", eventIds: exit.constituents, capMedium: true };
          inp.diagnostics.push({ code: "bash_exit_mismatch", message: `Bash call ${call.toolUseId} reported success but its shell exited unsuccessfully; the adapter may have misread the result.`, event_ids: uniqSorted([...call.eventIds, ...exit.constituents]) });
        } else if (o.outcome.value === "blocked" || o.outcome.value === "failed") {
          observedFailure = { phrase: `the shell exec ${outcomePhrase(o)}`, eventIds: o.constituents, capMedium: false };
        }
      } else if (o.outcome.value === "blocked" || o.outcome.value === "failed") {
        observedFailure = { phrase: `${actionPhrase(o)} ${outcomePhrase(o)}`, eventIds: o.constituents, capMedium: false };
      }
      if (observedFailure) {
        const sens = sensitivityOf(o, inp);
        out.push({
          category: "outcome_mismatch",
          ruleId: RULES.D2a,
          clusterKey: obsClusterKey(o, a),
          resourceKey: resKey(o),
          relatedEventIds: uniqSorted([...call.eventIds, ...observedFailure.eventIds]),
          evidenceIds: uniqSorted([...call.evidenceIds, ...o.evidenceIds]),
          title: `${call.toolName} reported success but ${observedFailure.phrase}`,
          description: `Agent-reported result for ${call.toolName} call ${shortId(call.toolUseId)} is success; the independently observed primary action (${fp.state} match) shows ${observedFailure.phrase}.`,
          nextStep: "Compare the agent's result record with the observed failure; check whether later steps relied on this action.",
          claims: [reportedClaim(inp.coverage, "result record"), occurredClaim(o), outcomeClaim(o), correlationClaim(fp.state)],
          confidenceCap: observedFailure.capMedium ? "medium" : null,
          severityInput: { category: "outcome_mismatch", action: sevAction(o.kind), sensitivity: sens.level, outcome: sevOutcome(o), declared: null },
          policyRuleId: inp.decisionsByObs.get(o.id)?.record.decision === "deny" ? inp.decisionsByObs.get(o.id)!.record.deciding_rule_id : null,
          classification: inp.decisionsByObs.get(o.id)?.record.classification ?? null,
          matchState: fp.state,
          missingInformation: missingInfoFor(inp.coverage, [coverageCatFor(o.kind), "tool_calls"]),
        });
      }
    } else if ((call.outcome === "error" || call.outcome === "denied") && o.outcome.value === "completed" && !o.outcome.disputed) {
      if (kind === "proc.exec" && call.outcome === "error") {
        // A completed shell exec does not mean the command succeeded: compare against the shell's exit status.
        const exit = (o.pid !== null ? obsIndex(inp).firstExitByPid.get(o.pid) : undefined);
        if (!exit || exit.outcome.value !== "completed") continue;
      }
      const sens = sensitivityOf(o, inp);
      out.push({
        category: "outcome_mismatch",
        ruleId: RULES.D2b,
        clusterKey: obsClusterKey(o, a),
        resourceKey: resKey(o),
        relatedEventIds: uniqSorted([...call.eventIds, ...o.constituents]),
        evidenceIds: uniqSorted([...call.evidenceIds, ...o.evidenceIds]),
        title: `${call.toolName} reported ${call.outcome === "denied" ? "a denial" : "failure"} but the action completed`,
        description: `Agent-reported result for ${call.toolName} call ${shortId(call.toolUseId)} is ${call.outcome}; the independently observed ${actionPhrase(o)} (${fp.state} match) ${outcomePhrase(o)}.`,
        nextStep: "Verify the side effect in the final state; if Claude Code rules denied it, check whether the action ran through another path.",
        claims: [reportedClaim(inp.coverage, "result record"), occurredClaim(o), outcomeClaim(o), correlationClaim(fp.state)],
        confidenceCap: null,
        severityInput: { category: "outcome_mismatch", action: sevAction(o.kind), sensitivity: sens.level, outcome: "completed", declared: null, agentLayerDenialFailed: call.outcome === "denied" },
        policyRuleId: null,
        classification: inp.decisionsByObs.get(o.id)?.record.classification ?? null,
        matchState: fp.state,
        missingInformation: missingInfoFor(inp.coverage, [coverageCatFor(o.kind)]),
      });
    }
  }

  // ----- D3: change mismatch (requires repository change coverage)
  const repoState = categoryState(inp.coverage, "repository_changes");
  const changes = inp.observations.filter((o) => o.kind === "fs.change" && o.path?.key);
  const ignored = (o: { path: LogicalObservation["path"] }) =>
    !!o.path && o.path.zone === "ws" && o.path.zoneRel !== null && (o.path.zoneRel === ".git" || o.path.zoneRel.startsWith(".git/") || inp.ctx.ignoredGlobs.some((g) => globLike(g, o.path!.zoneRel!)));
  if (repoState === "observed" || repoState === "partial") {
    const t1 = new Map<string, ReportedCall[]>();
    for (const c of inp.calls) {
      if (c.outcome !== "success" || primaryKind(c.toolName) !== "file.write" || !c.path?.key) continue;
      const l = t1.get(c.path.key) ?? [];
      l.push(c);
      t1.set(c.path.key, l);
    }
    const writesByKey = new Map<string, LogicalObservation[]>();
    for (const o of inp.observations) {
      if ((o.kind === "file.write" || o.kind === "file.delete") && o.path?.key && o.outcome.value === "completed") {
        const l = writesByKey.get(o.path.key) ?? [];
        l.push(o);
        writesByKey.set(o.path.key, l);
      }
    }
    for (const ch of changes) {
      if (ignored(ch)) continue;
      const key = ch.path!.key!;
      if (t1.has(key)) continue;
      const writes = writesByKey.get(key) ?? [];
      const callWrites = writes.filter((w) => {
        const a = inp.attributions.get(w.id);
        return a?.scope === "tool_call" && (a.state === "exact" || a.state === "probable");
      });
      if (callWrites.length > 0) {
        // Command-attributed change. It is explained only if some attributing call declares the file: a non-shell file
        // tool on that path, or a shell command whose text names it. A persisted change written solely by subprocesses of
        // shell commands that never name the file (e.g. `make test` running a formatter on src/config.py) is a change
        // the agent's tool inputs do not account for. Sensitive/out-of-workspace writes are already D1b; noise is skipped.
        const undeclared = callWrites.filter((w) => {
          const call = callsById.get(inp.attributions.get(w.id)!.toolUseId!);
          return !!call && !!call.toolName && SHELL_TOOLS.has(call.toolName) && !declaredBy(call, w) && !inp.noise.has(w.id) && !d1bEligible(w, call, inp);
        });
        if (undeclared.length !== callWrites.length) continue;
        const w = undeclared[undeclared.length - 1]!;
        const wa = inp.attributions.get(w.id)!;
        const call = callsById.get(wa.toolUseId!)!;
        const sens = sensitivityRank(pathSensitivity(ch.path, inp.policy, inp.ctx).level);
        out.push({
          category: "change_mismatch",
          ruleId: RULES.D3undeclared,
          clusterKey: obsClusterKey(w, wa),
          resourceKey: `path:${key}`,
          relatedEventIds: uniqSorted([...ch.constituents, ...w.constituents, ...call.eventIds, ...processChainIds(inp, wa)]),
          evidenceIds: uniqSorted([...ch.evidenceIds, ...w.evidenceIds, ...call.evidenceIds]),
          title: `Change to ${ch.path!.resolved} made inside ${call.toolName} call ${shortId(call.toolUseId)} is not declared by the command`,
          description:
            `The repository diff shows ${ch.path!.resolved} ${ch.outcome.level ?? "changed"}. No reported file edit covers it; the write was performed by ${principalPhrase(wa, w)}` +
            ` within the ${call.toolName} command "${clipAtToken(call.target ?? "", 160)}", whose text does not name this file.` +
            ` The command's own behavior (build script, formatter) may imply the change; the agent's tool inputs do not account for it.`,
          nextStep: "Inspect the diff for this path and the subprocess chain shown; check whether the agent's final account mentions this change.",
          claims: [
            occurredClaim(w),
            attributedClaim(wa, w, "to_call"),
            reportedClaim(inp.coverage, "absence of a reported edit"),
            { claim: "reported", grade: "medium", reason: "command text does not name the file, but the command's semantics (Makefile, script) are not visible to the engine" },
          ],
          confidenceCap: "medium",
          severityInput: { category: "change_mismatch", action: "write", sensitivity: sens, outcome: "completed", declared: null },
          policyRuleId: null,
          classification: null,
          matchState: wa.state,
          missingInformation: missingInfoFor(inp.coverage, ["repository_changes", "file_modification"]).concat(["The agent's final report text is not evaluated by this rule."]),
        });
        continue;
      }
      const sens = sensitivityRank(pathSensitivity(ch.path, inp.policy, inp.ctx).level);
      const fileModState = categoryState(inp.coverage, "file_modification");
      const writer = writes.find((w) => inp.attributions.get(w.id)?.scope !== "tool_call") ?? writes[0];
      const shellCalls = inp.calls.filter((c) => c.toolName !== null && SHELL_TOOLS.has(c.toolName) && c.outcome !== "denied");
      // U4: no write record WITH process identity (a file-watcher record cannot name the writer), file-modification
      // coverage incomplete, and at least one reported Bash call could have written it -> uncertain, not "unreported".
      const identifyingWriter = writes.some((w) => w.pid !== null);
      if (!identifyingWriter && fileModState !== "observed" && shellCalls.length > 0) {
        const stake = computeSeverity({ category: "change_mismatch", action: "write", sensitivity: sens, outcome: "completed", declared: null }).severity;
        out.push({
          category: "uncertain_correlation",
          ruleId: RULES.D5change,
          clusterKey: `path:${key}`,
          resourceKey: `path:${key}`,
          relatedEventIds: uniqSorted([...ch.constituents, ...writes.flatMap((w) => w.constituents), ...shellCalls.flatMap((c) => c.eventIds)]),
          evidenceIds: uniqSorted([...ch.evidenceIds, ...writes.flatMap((w) => w.evidenceIds), ...shellCalls.flatMap((c) => c.evidenceIds)]),
          title: `Change to ${ch.path!.resolved} cannot be attributed (file modification coverage ${fileModState})`,
          description: `The repository diff shows ${ch.path!.resolved} ${ch.outcome.level ?? "changed"}, no reported file edit covers it, and file-modification telemetry was ${fileModState}.${writes.length ? ` A write was recorded by ${uniqSorted(writes.flatMap((w) => w.sources)).join(", ")} without process identity.` : ""} ${shellCalls.length} Bash call(s) ran and could have written it; none can be confirmed.`,
          nextStep: "Inspect the Bash calls listed; if additional evidence cannot be obtained, mark the finding Unresolved.",
          claims: [{ claim: "occurred", grade: "medium", reason: "repository diff (single independent source)" }, { claim: "attributed", grade: "low", reason: "no syscall evidence of the writer" }],
          confidenceCap: "low",
          severityInput: { category: "uncertain_correlation", action: "write", sensitivity: sens, outcome: "undetermined", declared: null, stakes: [stake] },
          policyRuleId: null,
          classification: null,
          matchState: null,
          missingInformation: missingInfoFor(inp.coverage, ["file_modification", "repository_changes"]),
        });
        continue;
      }
      const wa = writer ? inp.attributions.get(writer.id) : undefined;
      const claims: ConfidenceClaim[] = [
        { claim: "occurred", grade: writer && writer.sources.some((s) => KERNEL_SOURCES.has(s)) ? "high" : "medium", reason: writer ? `repository diff corroborated by ${writer.sources.join(", ")} write record` : "repository diff (single independent source)" },
        writer ? attributedClaim(wa, writer, "to_agent") : { claim: "attributed", grade: "low", reason: "changed during the run; no syscall record identifies the writer" },
        reportedClaim(inp.coverage, "absence of a reported edit"),
      ];
      out.push({
        category: "change_mismatch",
        ruleId: RULES.D3a,
        clusterKey: writer ? obsClusterKey(writer, wa) : `path:${key}`,
        resourceKey: `path:${key}`,
        relatedEventIds: uniqSorted([...ch.constituents, ...(writer?.constituents ?? [])]),
        evidenceIds: uniqSorted([...ch.evidenceIds, ...(writer?.evidenceIds ?? [])]),
        title: `Unreported change to ${ch.path!.resolved}`,
        description: `The repository diff shows ${ch.path!.resolved} ${ch.outcome.level ?? "changed"}, but no reported file edit or attributed tool call explains it.` + (writer ? ` A write by ${principalPhrase(wa, writer)} was observed.` : " No syscall-level write record identifies who changed it."),
        nextStep: "Inspect the diff for this path and the process chain shown; decide whether the change was intended by the task.",
        claims,
        confidenceCap: null,
        severityInput: { category: "change_mismatch", action: "write", sensitivity: sens, outcome: "completed", declared: null },
        policyRuleId: null,
        classification: null,
        matchState: wa?.state ?? null,
        missingInformation: missingInfoFor(inp.coverage, ["repository_changes", "file_modification"]),
      });
    }
    // D3c: reported change not reflected in the final state
    if (repoState === "observed" && inp.coverage?.final_state_complete) {
      const changedKeys = new Set(changes.map((c) => c.path!.key!));
      for (const [key, calls] of [...t1.entries()].sort((a, b) => cmpStr(a[0], b[0]))) {
        const c = calls[calls.length - 1]!;
        if (!c.path || c.path.zone !== "ws" || ignored(c) || changedKeys.has(key)) continue;
        const sens = sensitivityRank(pathSensitivity(c.path, inp.policy, inp.ctx).level);
        out.push({
          category: "change_mismatch",
          ruleId: RULES.D3c,
          clusterKey: `path:${key}`,
          resourceKey: `path:${key}`,
          relatedEventIds: uniqSorted(calls.flatMap((x) => x.eventIds)),
          evidenceIds: uniqSorted(calls.flatMap((x) => x.evidenceIds)),
          title: `Reported change to ${c.path.resolved} is not reflected in the repository`,
          description: `${c.toolName} call ${shortId(c.toolUseId)} reported success on ${c.path.resolved}, but the post-run repository diff shows no content change for that path. (The edit may have been reverted later or written identical content.)`,
          nextStep: "Compare the reported edit with the final file; check whether a later action reverted it.",
          claims: [reportedClaim(inp.coverage, "edit record"), { claim: "occurred", grade: "medium", reason: "absence of a change in a complete repository diff (inference from absence)" }],
          confidenceCap: null,
          severityInput: { category: "change_mismatch", action: "write", sensitivity: sens, outcome: "completed", declared: null },
          policyRuleId: null,
          classification: null,
          matchState: inp.footprints.get(c.toolUseId)?.state ?? null,
          missingInformation: missingInfoFor(inp.coverage, ["repository_changes"]),
        });
      }
    }
  } else if (changes.length > 0 || inp.calls.some((c) => primaryKind(c.toolName) === "file.write")) {
    inp.notes.push({ code: "change_mismatch_not_assessable", message: `Repository change coverage is ${repoState}; reported and observed file changes were not compared.`, event_ids: uniqSorted(changes.flatMap((c) => c.constituents)) });
  }

  // ----- D1: unreported observed actions
  for (const o of inp.observations) {
    if (!["file.read", "file.write", "file.delete", "proc.exec", "net.connect"].includes(o.kind)) continue;
    const a = inp.attributions.get(o.id);
    if (!a || inp.noise.has(o.id)) continue;
    if (a.scope === "kw_instrumentation" || a.scope === "external") continue;
    const sens = sensitivityOf(o, inp);
    if (a.scope === "agent_runtime" || a.scope === "unattributed") {
      const el = d1Eligible(o, inp);
      if (!el.eligible) {
        if (el.read) unreportedReads.push(...o.constituents);
        continue;
      }
      if (agentSide.state !== "observed" && agentSide.state !== "partial") {
        noAgentRecord.push(...o.constituents);
        continue;
      }
      const claims = [occurredClaim(o), attributedClaim(a, o, "to_agent"), reportedClaim(inp.coverage, "no reported call")];
      out.push({
        category: "unreported_observed_action",
        ruleId: RULES.D1a,
        clusterKey: obsClusterKey(o, a),
        resourceKey: resKey(o),
        relatedEventIds: uniqSorted([...o.constituents, ...processChainIds(inp, a)]),
        evidenceIds: o.evidenceIds,
        title: `Unreported ${actionPhrase(o)} by ${principalPhrase(a, o)}`,
        description: `Observed ${actionPhrase(o)}; ${outcomePhrase(o)}. No agent-reported tool call explains it` +
          (a.candidates.length ? ` (closest candidate ${shortId(a.candidates[0]!.toolUseId)} scored ${a.candidates[0]!.score}, below the match threshold)` : "") +
          `. This is a discrepancy that needs review, not a confirmed violation.`,
        nextStep: "Check which component performed this action (process chain shown); if it is expected runtime behavior, propose a noise-model rule with a rationale; otherwise consider a policy rule.",
        claims,
        confidenceCap: null,
        severityInput: { category: "unreported_observed_action", action: sevAction(o.kind), sensitivity: sens.level, outcome: sevOutcome(o), declared: null },
        policyRuleId: null,
        classification: inp.decisionsByObs.get(o.id)?.record.classification ?? null,
        matchState: "unmatched_observed",
        missingInformation: missingInfoFor(inp.coverage, [coverageCatFor(o.kind), "tool_calls"]),
      });
      continue;
    }
    if (a.scope === "tool_call" && (a.state === "exact" || a.state === "probable") && a.toolUseId) {
      const call = callsById.get(a.toolUseId)!;
      if (!d1bEligible(o, call, inp)) continue;
      const dec = inp.decisionsByObs.get(o.id);
      if (dec?.record.decision === "allow" && dec.record.step === "explicit_allow") {
        inp.notes.push({ code: "sensitive_access_allowed", message: `${cap(actionPhrase(o))} within ${call.toolName} call ${shortId(call.toolUseId)} is explicitly allowed by policy rule ${dec.record.deciding_rule_id}.`, event_ids: o.constituents });
        continue;
      }
      out.push({
        category: "unreported_observed_action",
        ruleId: RULES.D1b,
        clusterKey: obsClusterKey(o, a),
        resourceKey: resKey(o),
        relatedEventIds: uniqSorted([...o.constituents, ...call.eventIds, ...processChainIds(inp, a)]),
        evidenceIds: uniqSorted([...o.evidenceIds, ...call.evidenceIds]),
        title: `${call.toolName} call ${shortId(call.toolUseId)} also ${actionPhrase(o)} (not declared in the command)`,
        description: `The ${call.toolName} command "${clipAtToken(call.target ?? "", 160)}" does not mention ${resourceText(o)}, but a process in its subtree performed ${actionPhrase(o)}; ${outcomePhrase(o)}.`,
        nextStep: "Inspect the subprocess chain; decide whether the side effect was intended by the task.",
        claims: [occurredClaim(o), attributedClaim(a, o, "to_call"), reportedClaim(inp.coverage, "command text")],
        confidenceCap: null,
        severityInput: { category: "unreported_observed_action", action: sevAction(o.kind), sensitivity: sens.level, outcome: sevOutcome(o), declared: null },
        policyRuleId: null,
        classification: dec?.record.classification ?? null,
        matchState: a.state,
        missingInformation: missingInfoFor(inp.coverage, [coverageCatFor(o.kind)]),
      });
    }
  }

  // ----- D5: ambiguous attribution (decision-relevance test), Bash without process, collector disagreement
  for (const o of inp.observations) {
    const a = inp.attributions.get(o.id);
    if (!a || a.state !== "ambiguous" || inp.noise.has(o.id)) continue;
    const alts = a.candidates.filter((c) => c.score >= 40).slice(0, 4);
    const weakSingle = alts.length <= 1;
    const outcomes: Array<{ label: string; cats: string; stake: Severity }> = [];
    const sens = sensitivityOf(o, inp);
    for (const alt of alts) {
      const call = callsById.get(alt.toolUseId)!;
      const cats: string[] = [];
      if (d1bEligible(o, call, inp)) cats.push("unreported_observed_action");
      if (primaryKind(call.toolName) === o.kind) {
        if (call.outcome === "success" && (o.outcome.value === "blocked" || o.outcome.value === "failed")) cats.push("outcome_mismatch");
        if ((call.outcome === "error" || call.outcome === "denied") && o.outcome.value === "completed") cats.push("outcome_mismatch");
      }
      outcomes.push({ label: `${call.toolName ?? "tool"} ${shortId(call.toolUseId)}`, cats: cats.join(","), stake: cats.length ? matrixSeverity(sevAction(o.kind), sens.level) : "info" });
    }
    if (weakSingle) {
      const el = d1Eligible(o, inp);
      outcomes.push({ label: "no reported call", cats: el.eligible ? "unreported_observed_action" : "", stake: el.eligible ? matrixSeverity(sevAction(o.kind), sens.level) : "info" });
    }
    const relevant = new Set(outcomes.map((x) => x.cats)).size > 1;
    if (!relevant) {
      inp.notes.push({ code: "attribution_alternatives", message: `Attribution of ${actionPhrase(o)} is ambiguous between ${outcomes.map((x) => x.label).join(", ")}, but every alternative leads to the same findings; no separate uncertainty finding.`, event_ids: o.constituents });
      continue;
    }
    out.push({
      category: "uncertain_correlation",
      ruleId: RULES.D5ambiguous,
      // one uncertainty finding per ambiguous process anchor (its descendants share the same ambiguity)
      clusterKey: a.anchorPid !== null ? `anchor:${a.anchorPid}` : obsClusterKey(o, a),
      resourceKey: resKey(o),
      relatedEventIds: uniqSorted([...o.constituents, ...alts.flatMap((c) => callsById.get(c.toolUseId)!.eventIds)]),
      evidenceIds: o.evidenceIds,
      title: `Cannot confidently attribute ${actionPhrase(o)}`,
      description: `Candidates: ${alts.map((c) => `${shortId(c.toolUseId)} (score ${c.score}: ${Object.entries(c.features).map(([k, v]) => `${k}=${v}`).join(" ")})`).join("; ") || "none above threshold"}. The interpretations lead to different findings: ${outcomes.map((x) => `${x.label} -> ${x.cats || "no finding"}`).join("; ")}.`,
      nextStep: "If additional evidence cannot be obtained, mark the finding Unresolved.",
      claims: [occurredClaim(o), attributedClaim(a, o, "to_call")],
      confidenceCap: "low",
      severityInput: { category: "uncertain_correlation", action: sevAction(o.kind), sensitivity: sens.level, outcome: sevOutcome(o), declared: null, stakes: outcomes.map((x) => x.stake) },
      policyRuleId: null,
      classification: inp.decisionsByObs.get(o.id)?.record.classification ?? null,
      matchState: "ambiguous",
      missingInformation: missingInfoFor(inp.coverage, [coverageCatFor(o.kind), "process_execution"]),
    });
  }

  const procState = categoryState(inp.coverage, "process_execution");
  for (const call of inp.calls) {
    if (!call.toolName || !SHELL_TOOLS.has(call.toolName) || call.outcome === "denied") continue;
    const fp = inp.footprints.get(call.toolUseId);
    if (fp?.obs || procState !== "observed") continue;
    if (inp.intentDecisions.get(call.toolUseId)?.record.decision === "deny") continue; // already covered by the intent rule above
    out.push({
      category: "uncertain_correlation",
      ruleId: RULES.D5noShell,
      clusterKey: `call:${call.toolUseId}`,
      resourceKey: null,
      relatedEventIds: call.eventIds,
      evidenceIds: call.evidenceIds,
      title: `Bash call ${shortId(call.toolUseId)} has no observed process`,
      description: `The agent reported running "${clipAtToken(call.target ?? "", 160)}" (reported outcome: ${call.outcome}), but no process bound to it was observed while process-execution coverage was active.`,
      nextStep: "Check collector health for this interval; if additional evidence cannot be obtained, mark the finding Unresolved.",
      claims: [reportedClaim(inp.coverage, "reported call")],
      confidenceCap: "low",
      severityInput: { category: "uncertain_correlation", action: "exec", sensitivity: 1, outcome: "undetermined", declared: null, stakes: ["low"] },
      policyRuleId: null,
      classification: null,
      matchState: "unmatched_reported",
      missingInformation: missingInfoFor(inp.coverage, ["process_execution"]),
    });
  }

  for (const o of inp.observations) {
    if (!o.outcome.disputed) continue;
    const a = inp.attributions.get(o.id);
    const relevantToPolicy = inp.decisionsByObs.get(o.id)?.record.decision === "deny";
    const relevantToCall = [...inp.footprints.values()].some((f) => f.obs?.id === o.id);
    if (!relevantToPolicy && !relevantToCall) continue;
    const sens = sensitivityOf(o, inp);
    out.push({
      category: "uncertain_correlation",
      ruleId: RULES.D5disputed,
      clusterKey: obsClusterKey(o, a),
      resourceKey: resKey(o),
      relatedEventIds: uniqSorted(inp.diagnostics.filter((d) => d.code === "collector_disagreement" && d.event_ids.some((id) => o.constituents.includes(id))).flatMap((d) => d.event_ids).concat(o.constituents)),
      evidenceIds: o.evidenceIds,
      title: `Collectors disagree on the outcome of ${actionPhrase(o)}`,
      description: "Independent collectors recorded contradictory outcomes for the same action. Both records are kept; the outcome is treated as undetermined.",
      nextStep: "Compare the raw collector records; if the disagreement cannot be resolved, mark the finding Unresolved.",
      claims: [occurredClaim(o), outcomeClaim(o)],
      confidenceCap: "low",
      severityInput: { category: "uncertain_correlation", action: sevAction(o.kind), sensitivity: sens.level, outcome: "undetermined", declared: inp.decisionsByObs.get(o.id)?.evaluation.declaredSeverity ?? null, stakes: [inp.decisionsByObs.get(o.id)?.evaluation.declaredSeverity ?? matrixSeverity(sevAction(o.kind), sens.level)] },
      policyRuleId: inp.decisionsByObs.get(o.id)?.record.deciding_rule_id ?? null,
      classification: inp.decisionsByObs.get(o.id)?.record.classification ?? null,
      matchState: a?.state ?? null,
      missingInformation: [],
    });
  }

  if (noAgentRecord.length) {
    inp.notes.push({ code: "agent_record_unavailable", message: `Agent-side record coverage is ${agentSide.state}; ${noAgentRecord.length} observed record(s) could not be checked against reported activity ("not reported" cannot be asserted).`, event_ids: uniqSorted(noAgentRecord) });
  }
  if (unreportedReads.length) {
    inp.notes.push({ code: "unreported_read", message: `${unreportedReads.length} non-sensitive read record(s) outside any reported tool call (visible, not flagged).`, event_ids: uniqSorted(unreportedReads) });
  }
  return out;
}

function globLike(g: string, rel: string): boolean {
  // gitignore-style: "dist/" or "dist/**" or "*.log"
  const pat = g.endsWith("/") ? g + "**" : g;
  const re = new RegExp("^" + pat.split("**").map((s) => s.split("*").map((x) => x.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join("[^/]*")).join(".*") + "$");
  return re.test(rel) || re.test(rel.split("/").pop() ?? rel);
}

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export { maxSeverity };
