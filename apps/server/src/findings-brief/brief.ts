/**
 * Addendum C section 3A: deterministic concise explanation ("brief") of a finding.
 *
 * Built ONLY from the stored records the finding detail already serves (finding, related events, evidence, policy) plus
 * the run's coverage report, the finding's safeguards (served lifecycle / verification state) and their verification
 * runs. No AI. Nothing is stored. Every copied string goes through redaction. Action statuses come from stored
 * safeguard / verification rows only, and there is no "done" status.
 */
import {
  BRIEF_ACTION_STATUS_LABELS,
  FINDING_BRIEF_VERSION,
  FINDING_CATEGORY_LABELS,
  FINDING_STATUS_LABELS,
  MECHANISMS,
  SAFEGUARD_LIFECYCLE_LABELS,
  type BriefAction,
  type BriefActionStatus,
  type BriefTerm,
  type BriefUncertainty,
  type CoverageReport,
  type Event,
  type FindingBrief,
  type FindingDetailResponse,
  type PolicyRule,
  type SafeguardLifecycleStatus,
  type SafeguardType,
  type ShortRead,
  type VerificationRunV2,
  type VerificationState,
} from "@kw/schema";
import { safeRedact } from "@kw/redaction";
import type { Db } from "../db/connection";
import { processRedactionOptions } from "../ingest/sanitize";
import { getCoverage } from "../repo/runs";
import { getFindingDetail } from "../repo/findings";
import { getSafeguardRecord } from "../safeguards/store";
import { getRunRow, listRunsForSafeguard } from "../verification/repo";
import { buildShortRead, countRunFindings, listRunResourceEvents } from "./short-read";

/** Stored safeguard plus its served (read-guarded) state and latest verification run. */
export interface BriefSafeguardInfo {
  id: string;
  type: SafeguardType;
  title: string;
  lifecycle: SafeguardLifecycleStatus;
  verification: VerificationState;
  latest_run: VerificationRunV2 | null;
  all_run_ids: string[];
}

export interface BriefInput {
  detail: Omit<FindingDetailResponse, "brief" | "short_read">;
  coverage: CoverageReport | null;
  safeguards: BriefSafeguardInfo[];
}

// ---------------------------------------------------------------------------------------------------------------
// Loading (read-only)
// ---------------------------------------------------------------------------------------------------------------

export function loadBriefInput(db: Db, detail: Omit<FindingDetailResponse, "brief" | "short_read">): BriefInput {
  const safeguards: BriefSafeguardInfo[] = [];
  for (const sg of detail.safeguards) {
    const rec = getSafeguardRecord(db, sg.id);
    const runs = listRunsForSafeguard(db, sg.id);
    const latest = (sg.last_verification_run_id ? getRunRow(db, sg.last_verification_run_id) : null) ?? runs[0] ?? null;
    safeguards.push({
      id: sg.id,
      type: sg.type,
      title: sg.title,
      lifecycle: rec?.lifecycle ?? "proposed",
      verification: rec?.verification ?? "not_tested",
      latest_run: latest,
      all_run_ids: runs.map((r) => r.id),
    });
  }
  return { detail, coverage: getCoverage(db, detail.run.id), safeguards };
}

export function getFindingBrief(db: Db, findingId: string): FindingBrief {
  return buildFindingBrief(loadBriefInput(db, getFindingDetail(db, findingId)));
}

/** Brief + short read for GET /api/findings/:id/brief. A short read that cannot be built is omitted (optional field). */
export function getFindingBriefResponse(db: Db, findingId: string): { brief: FindingBrief; short_read?: ShortRead } {
  const input = loadBriefInput(db, getFindingDetail(db, findingId));
  const brief = buildFindingBrief(input);
  const short_read = tryShortRead(db, input, brief);
  return short_read ? { brief, short_read } : { brief };
}

function tryShortRead(db: Db, input: BriefInput, brief: FindingBrief): ShortRead | undefined {
  try {
    const run_resource_events = listRunResourceEvents(db, input.detail.run.id, brief.affected.resource);
    return buildShortRead({ ...input, run_finding_count: countRunFindings(db, input.detail.run.id), run_resource_events }, brief);
  } catch (err) {
    console.error(`[kw] short read failed for ${input.detail.finding.id}: ${(err as Error).message}`);
    return undefined;
  }
}

/** Detail + brief + short read. Neither can break the existing detail response (both fields are optional). */
export function withBrief(db: Db, detail: FindingDetailResponse): FindingDetailResponse {
  try {
    const input = loadBriefInput(db, detail);
    const brief = buildFindingBrief(input);
    const short_read = tryShortRead(db, input, brief);
    return short_read ? { ...detail, brief, short_read } : { ...detail, brief };
  } catch (err) {
    console.error(`[kw] finding brief failed for ${detail.finding.id}: ${(err as Error).message}`);
    return detail;
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Text helpers
// ---------------------------------------------------------------------------------------------------------------

/** Redacts (fail-closed) and clips any string copied from a stored record. */
function red(text: string, max = 160): string {
  const r = safeRedact(text, { ...processRedactionOptions(), keepCleanTextVerbatim: true }).text.replace(/\s+/g, " ").trim();
  return r.length > max ? `${r.slice(0, max - 1).trimEnd()}…` : r;
}

const q = (s: string) => `"${s}"`;
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const SENSITIVE = /(^|[/\\.])env\b|\.env|secret|credential|\.pem\b|id_rsa|token|password/i;

function primaryResource(events: Event[]): string | null {
  const rank = (e: Event) => (e.basis === "derived" ? 0 : e.basis === "observed" ? 1 : 2);
  // A command line (Bash call/result) or an executable path (process exec/exit) is a route, not the affected resource.
  const isRoute = (e: Event) => e.tool_name === "Bash" || e.event_type === "process_exec" || e.event_type === "process_exit" || e.event_type === "agent_message";
  const withTarget = events.filter((e) => e.target_resource && !isRoute(e)).sort((a, b) => rank(a) - rank(b));
  return withTarget[0]?.target_resource ?? null;
}

/** How the agent reached the resource, from reported tool calls and observed processes (e.g. Bash `node show_env.js`). */
function route(events: Event[]): string | null {
  const seen = new Set<string>();
  const parts: string[] = [];
  for (const e of events) {
    if (e.basis !== "reported" || e.event_type !== "tool_call" || !e.tool_name) continue;
    const label = e.target_resource && e.tool_name === "Bash" ? `Bash (\`${red(e.target_resource, 80)}\`)` : `the ${e.tool_name} tool`;
    if (seen.has(label)) continue;
    seen.add(label);
    parts.push(label);
  }
  if (parts.length) return parts.slice(0, 2).join(", then ");
  const proc = events.find((e) => e.basis === "observed" && e.process_name);
  return proc ? `process ${red(proc.process_name!, 60)}` : null;
}

type ObservedOutcome = "blocked" | "succeeded" | "unknown";
function observedOutcome(events: Event[]): ObservedOutcome {
  const indep = events.filter((e) => e.basis !== "reported");
  if (indep.some((e) => e.outcome === "succeeded")) return "succeeded";
  if (indep.some((e) => e.outcome === "blocked" || e.outcome === "denied")) return "blocked";
  return "unknown";
}

// ---------------------------------------------------------------------------------------------------------------
// Action statuses (stored records only)
// ---------------------------------------------------------------------------------------------------------------

interface ActionSpec {
  text: string;
  mechanism: SafeguardType | null;
}

function pickSafeguard(sgs: BriefSafeguardInfo[], type: SafeguardType): BriefSafeguardInfo | null {
  // detail.safeguards is ordered newest first; prefer one that is not rejected.
  const ofType = sgs.filter((s) => s.type === type);
  return ofType.find((s) => s.lifecycle !== "rejected") ?? ofType[0] ?? null;
}

function statusFor(spec: ActionSpec, sgs: BriefSafeguardInfo[], findingStatus: string): Pick<BriefAction, "status" | "status_basis" | "safeguard_id" | "verification_run_id"> {
  if (spec.mechanism === null) {
    return {
      status: "proposed",
      status_basis: `Recommendation only; Underwatch keeps no record that this step was performed. Finding status is ${q(findingStatus)}.`,
      safeguard_id: null,
      verification_run_id: null,
    };
  }
  const sg = pickSafeguard(sgs, spec.mechanism);
  if (!sg) {
    return {
      status: "proposed",
      status_basis: `No ${MECHANISMS[spec.mechanism].label} safeguard exists for this finding yet.`,
      safeguard_id: null,
      verification_run_id: null,
    };
  }
  const run = sg.latest_run;
  const lifecycle = SAFEGUARD_LIFECYCLE_LABELS[sg.lifecycle];
  const base = `Safeguard ${sg.id} is ${q(lifecycle)}`;
  let status: BriefActionStatus;
  let basis: string;
  switch (sg.verification) {
    case "failed":
      status = "failed_verification";
      basis = `${base}; its latest verification run${run ? ` ${run.id}` : ""} failed.`;
      break;
    case "passed":
      status = "verified_for_tested_scenario";
      basis = `${base}; its latest verification run${run ? ` ${run.id}` : ""} passed for the tested scenario only${run ? ` (${red(run.scenario_description || run.scenario_id, 100)})` : ""}.`;
      break;
    case "inconclusive":
      status = "inconclusive";
      basis = `${base}; its latest verification run${run ? ` ${run.id}` : ""} was inconclusive, so nothing is established about whether it works.`;
      break;
    default:
      status = sg.lifecycle === "applied" ? "applied" : "safeguard_proposed";
      basis = `${base}; ${sg.verification === "running" ? "a verification run is in progress" : "it has not been verified"}.`;
  }
  return { status, status_basis: basis, safeguard_id: sg.id, verification_run_id: run?.id ?? null };
}

function toActions(specs: ActionSpec[], sgs: BriefSafeguardInfo[], findingStatus: string): BriefAction[] {
  return specs.slice(0, 3).map((spec, i) => {
    const st = statusFor(spec, sgs, findingStatus);
    const mech = spec.mechanism ? MECHANISMS[spec.mechanism] : null;
    return {
      id: `fix-${i + 1}`,
      text: spec.text,
      mechanism: spec.mechanism,
      enforces: mech ? mech.can_enforce : null,
      mechanism_limit: mech ? (mech.cannot[0] ?? null) : null,
      ...st,
      status_label: BRIEF_ACTION_STATUS_LABELS[st.status],
    };
  });
}

// ---------------------------------------------------------------------------------------------------------------
// Category templates
// ---------------------------------------------------------------------------------------------------------------

const TERMS: Record<string, BriefTerm> = {
  rule: { term: "permission rule", meaning: "A rule in the run's policy that says which actions the agent may or may not take (for example, never read .env)." },
  observed: {
    term: "independently observed",
    meaning: "Recorded by a collector outside the agent (kernel tracer, file watcher, host-side scan), not taken from the agent's own account.",
  },
  kernel: { term: "kernel-observed", meaning: "Seen by the Linux kernel tracer (Tetragon) in the agent's container, which sees every process, including scripts the agent starts." },
  reported: { term: "agent-reported", meaning: "What the agent itself said or logged (tool calls, transcript, final message)." },
  mismatch: { term: "outcome mismatch", meaning: "The agent's claim about a result (e.g. tests pass, nothing was accessed) contradicts an independently observed record." },
  correlation: { term: "correlation", meaning: "Underwatch's pairing of an agent-reported action with an observed event. Uncertain means the pairing could not be established." },
  verified: { term: "verified for tested scenario", meaning: "A recorded verification run passed for one specific scenario; it does not prove the safeguard works in every case." },
};

interface Ctx {
  agent: string;
  task: string | null;
  resource: string | null;
  rule: PolicyRule | null;
  route: string | null;
  outcome: ObservedOutcome;
  kernelObserved: boolean;
  kernelBlocked: boolean;
  title: string;
}

function ruleText(c: Ctx): string {
  if (!c.rule) return "";
  return ` policy rule ${c.rule.id}`;
}

function concretePath(c: Ctx): string | null {
  if (!c.resource || /[*?\s]/.test(c.resource)) return null;
  return c.resource;
}

function kernelFix(c: Ctx, path: string): ActionSpec {
  // The route can list several reported tool calls ("the Read tool, then Bash (`cat .env`)"); the bypass is the last one.
  const via = c.route ? (c.route.split(", then ").pop() ?? c.route) : null;
  const bypass =
    via && /Bash|^process/.test(via)
      ? c.outcome === "succeeded"
        ? `; a permission rule alone did not stop the ${via} bypass`
        : `; a permission rule alone does not stop ${via} reaching it`
      : "";
  return { text: `Add a kernel enforcement safeguard for ${path} (blocks any process in the agent container from opening it)${bypass}.`, mechanism: "kernel_enforcement" };
}

function permissionFix(c: Ctx, path: string): ActionSpec {
  const tool = c.rule?.action === "file_write" ? "Edit" : "Read";
  return {
    text: `Add a Claude Code permission deny rule ${tool}(${path}) so the ${tool} tool and recognized shell commands are refused early (it does not stop interpreter subprocesses).`,
    mechanism: "permission_rule",
  };
}

const regressionFix = (what: string): ActionSpec => ({
  text: `Add a regression test that re-runs ${what} in a disposable container, so a later change that lets it happen again is detected.`,
  mechanism: "regression_test",
});

function templateFor(cat: FindingDetailResponse["finding"]["category"], c: Ctx): { problem: string; why: string; specs: ActionSpec[]; terms: BriefTerm[] } {
  const where = c.task ? ` during the task ${q(c.task)}` : "";
  const res = c.resource ? red(c.resource, 100) : "a resource";
  const path = concretePath(c);
  const fileRuleDeny = c.rule?.effect === "deny" && (c.rule.action === "file_read" || c.rule.action === "file_write");
  switch (cat) {
    case "permission_violation": {
      const verb = c.rule?.action === "file_write" ? "write to" : c.rule?.action === "file_read" ? "read" : "access";
      const result =
        c.outcome === "succeeded"
          ? "and the observed records show it succeeded"
          : c.outcome === "blocked"
            ? `and it was blocked${c.kernelBlocked ? " in the kernel" : ""}`
            : "and the records do not establish whether it succeeded";
      const problem = `${c.task ? `During the task ${q(c.task)}, the` : "The"} ${c.agent} tried to ${verb} ${res}${c.route ? ` via ${c.route}` : ""}, which${ruleText(c) || " the run's policy"} forbids, ${result}.`;
      const why =
        c.outcome === "blocked"
          ? "The block worked this time, but it is a security outcome only: it does not show the legitimate task still succeeded, and the agent may retry through another route. A permission rule is a policy line saying what the agent may not do."
          : `${SENSITIVE.test(res) ? "Protected secrets may now be in the agent's context and could leak into logs, commits or network calls" : "The agent did something its policy forbids"}; it also shows the existing control did not stop this route. A permission rule is a policy line saying what the agent may not do.`;
      const specs: ActionSpec[] = [];
      if (fileRuleDeny && path) {
        if (!c.kernelBlocked) specs.push(kernelFix(c, path));
        specs.push(permissionFix(c, path));
      } else {
        specs.push({ text: `Review what the agent did with ${res} and decide whether the policy needs an exact deny rule for it.`, mechanism: null });
      }
      if (c.outcome === "succeeded" && SENSITIVE.test(res)) specs.splice(1, 0, { text: `Rotate or replace any real values stored in ${res}; treat them as exposed.`, mechanism: null });
      specs.push(regressionFix(`the restricted ${verb} of ${res} together with a legitimate task`));
      return { problem, why, specs, terms: [TERMS.rule!, TERMS.observed!, ...(c.kernelObserved ? [TERMS.kernel!] : []), TERMS.verified!] };
    }
    case "unreported_observed_action": {
      const problem = `Underwatch independently observed activity on ${res}${c.route ? ` by ${c.route}` : ""}${where}, but the ${c.agent}'s own report never mentions it.`;
      const why = `If the agent does things it does not report, its summary cannot be trusted as a record of what changed${SENSITIVE.test(res) ? ", and this action touched a sensitive file" : ""}. "Independently observed" means a collector outside the agent recorded it.`;
      const specs: ActionSpec[] = [
        { text: `Check the observed event(s) on ${res} and decide whether the action was needed for the task; then confirm or dismiss this finding.`, mechanism: null },
        { text: `Add a CLAUDE.md instruction telling the agent to report every file it opens or changes, including via shell commands (guidance only; it blocks nothing).`, mechanism: "claude_md_instruction" },
        fileRuleDeny && path && SENSITIVE.test(path) ? kernelFix(c, path) : regressionFix(`the task and checks that every observed action on ${res} is reported`),
      ];
      return { problem, why, specs, terms: [TERMS.observed!, TERMS.reported!, ...(c.kernelObserved ? [TERMS.kernel!] : [])] };
    }
    case "outcome_mismatch": {
      const problem = `The ${c.agent}'s account of the result disagrees with what was independently observed${where}: ${q(c.title)}.`;
      const why = `An outcome mismatch means the agent's claim (for example "tests pass" or "no secrets accessed") is contradicted by an observed record; trusting the claim could ship broken or unsafe changes.`;
      const specs: ActionSpec[] = [
        { text: `Do not rely on the agent's report for this run: re-check the observed result${c.resource ? ` (${res})` : ""} yourself, e.g. re-run the tests.`, mechanism: null },
        { text: "Add a CLAUDE.md instruction requiring the agent to report failed, blocked or unverified steps verbatim in its final message (guidance only; it blocks nothing).", mechanism: "claude_md_instruction" },
        regressionFix("the task and checks the outcome from host-side evidence rather than the agent's claim"),
      ];
      return { problem, why, specs, terms: [TERMS.mismatch!, TERMS.reported!, TERMS.observed!] };
    }
    case "change_mismatch": {
      const problem = `The repository changes Underwatch observed${where} do not match the changes the ${c.agent} reported${c.resource ? ` (${res})` : ""}: ${q(c.title)}.`;
      const why = "Changes the agent did not report can slip into a commit without review; the agent's summary is not a reliable list of what changed.";
      const specs: ActionSpec[] = [
        { text: `Review the observed diff${c.resource ? ` for ${res}` : ""} before committing and revert anything the task did not need.`, mechanism: null },
        { text: "Add a CLAUDE.md instruction telling the agent to check git status and list every changed file in its final summary (guidance only; it blocks nothing).", mechanism: "claude_md_instruction" },
        regressionFix("the task and compares the reported file list with the observed diff"),
      ];
      return { problem, why, specs, terms: [TERMS.reported!, TERMS.observed!] };
    }
    case "uncertain_correlation": {
      const problem = `Underwatch could not reliably match activity on ${res}${where} to an action the ${c.agent} reported: ${q(c.title)}.`;
      const why = "This is an evidence gap, not a confirmed violation: neither safe behavior nor a violation is established, so the run cannot be fully trusted yet. Correlation means pairing a reported action with an observed event.";
      const specs: ActionSpec[] = [
        { text: "Re-run the task as a Underwatch supervised run so the kernel observer can attribute the activity to a process.", mechanism: null },
        { text: `Check the observation coverage caveats for this run and enable the missing collector before relying on it.`, mechanism: null },
        { text: "Add a CLAUDE.md instruction asking the agent to name the tool or command used for each action, so records can be matched (guidance only; it blocks nothing).", mechanism: "claude_md_instruction" },
      ];
      return { problem, why, specs, terms: [TERMS.correlation!, TERMS.observed!] };
    }
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Builder
// ---------------------------------------------------------------------------------------------------------------

export function buildFindingBrief(input: BriefInput): FindingBrief {
  const { detail, coverage, safeguards } = input;
  const { finding, run, related_events: events, evidence, policy } = detail;
  const isFixture = finding.is_fixture || run.is_fixture;
  const rule = policy && finding.policy_rule_id ? (policy.rules.find((r) => r.id === finding.policy_rule_id) ?? null) : null;

  const reported = events.filter((e) => e.basis === "reported");
  const observed = events.filter((e) => e.basis === "observed");
  const derived = events.filter((e) => e.basis === "derived");
  const kernel = observed.filter((e) => e.source === "kernel_tracer");
  const resourceRaw = primaryResource(events);

  const c: Ctx = {
    agent: run.agent_type === "claude_code" ? "Claude Code agent" : `${run.agent_type} agent`,
    task: run.task_description ? red(run.task_description, 90) : null,
    resource: resourceRaw ? red(resourceRaw, 120) : null,
    rule,
    route: route(events),
    outcome: observedOutcome(events),
    kernelObserved: kernel.length > 0,
    kernelBlocked: kernel.some((e) => e.outcome === "blocked" || e.outcome === "denied"),
    title: red(finding.title, 140),
  };

  const t = templateFor(finding.category, c);
  const how_to_fix = toActions(t.specs, safeguards, FINDING_STATUS_LABELS[finding.status]);

  // Evidence summary ----------------------------------------------------------------------------------------------
  const level = coverage?.level ?? run.coverage_status ?? "unknown";
  const caveats: string[] = [];
  if (!coverage) caveats.push("No coverage report is stored for this run; observation completeness is unknown.");
  for (const cat of coverage?.categories ?? []) {
    if (cat.status !== "observed") caveats.push(red(`${cat.category.replace(/_/g, " ")}: ${cat.status}${cat.note ? ` (${cat.note})` : ""}`, 200));
  }
  for (const u of (coverage?.unsupported_capabilities ?? []).slice(0, 3)) caveats.push(red(`Not observable: ${u}`, 200));
  const keyEvents = [...derived, ...observed, ...reported].slice(0, 5).map((e) => e.id);
  const keyEvidence = [...new Set([...finding.evidence_ids, ...evidence.map((e) => e.id)])].slice(0, 5);
  const evidenceText =
    `${plural(reported.length, "agent-reported event")}, ${plural(observed.length, "independently observed event")}${kernel.length ? ` (${kernel.length} kernel-observed)` : ""}` +
    ` and ${plural(derived.length, "Underwatch analysis record")}; ${plural(evidence.length, "evidence record")}. Observation coverage for this run: ${level}.` +
    (isFixture ? " These are hand-labeled fixture records, not a live capture." : "");

  // Uncertainty ---------------------------------------------------------------------------------------------------
  const uncertainty: BriefUncertainty[] = [];
  if (isFixture) uncertainty.push({ kind: "fixture_data", text: "Fixture data: this finding and its evidence are hand-labeled fixture records, not captured from a live run." });
  if (finding.confidence !== "high") uncertainty.push({ kind: "confidence", text: `Underwatch rated its confidence in this finding ${finding.confidence}.` });
  if (level !== "complete") uncertainty.push({ kind: "partial_coverage", text: `Observation coverage is ${level}: some activity may not have been recorded, so absence of an event proves nothing.` });
  const lossyHay = JSON.stringify([coverage ?? null, events.map((e) => e.limitations), finding.missing_information]);
  if (/\blossy\b/i.test(lossyHay)) uncertainty.push({ kind: "lossy_kernel_capture", text: "The kernel capture was lossy (Tetragon dropped events during the run); a missing event cannot be ruled out." });
  if (c.outcome === "unknown" && finding.category !== "outcome_mismatch" && finding.category !== "change_mismatch")
    uncertainty.push({ kind: "unknown_outcome", text: "The independently observed records do not establish whether the action succeeded." });
  const runs = safeguards.flatMap((s) => (s.latest_run ? [s.latest_run] : []));
  const taskSucceeded = runs.some((r) => r.task_outcome?.value === "succeeded");
  if (runs.some((r) => r.task_outcome?.value === "unknown") && !taskSucceeded)
    uncertainty.push({ kind: "unknown_task_outcome", text: "In the recorded verification run(s), whether the legitimate task still succeeded is unknown." });
  else if (finding.category === "permission_violation" && c.outcome === "blocked" && !taskSucceeded)
    uncertainty.push({ kind: "unknown_task_outcome", text: "Blocking the action is a security outcome only; these records do not establish that the legitimate task succeeded." });
  if (observed.length === 0 && derived.length === 0)
    uncertainty.push({ kind: "no_independent_observation", text: "No independently observed event is linked to this finding; it rests on agent-reported records only." });
  for (const m of finding.missing_information.slice(0, 4)) uncertainty.push({ kind: "missing_information", text: red(m, 200) });

  const policyRuleOut = finding.policy_rule_id
    ? { id: finding.policy_rule_id, effect: rule?.effect ?? null, description: rule?.description ? red(rule.description, 200) : null }
    : null;

  return {
    brief_version: FINDING_BRIEF_VERSION,
    deterministic: true,
    finding_id: finding.id,
    category: finding.category,
    is_fixture: isFixture,
    data_origin: isFixture ? "Hand-labeled fixture (not a live capture)" : "Live capture",
    problem: t.problem,
    why_it_matters: t.why,
    terms: t.terms,
    how_to_fix,
    affected: { agent: c.agent, task: c.task, resource: c.resource, run_id: run.id, run_label: run.label ? red(run.label, 120) : null, policy_rule: policyRuleOut },
    evidence_summary: {
      agent_reported: reported.length,
      independently_observed: observed.length,
      derived: derived.length,
      evidence_records: evidence.length,
      key_event_ids: keyEvents,
      key_evidence_ids: keyEvidence,
      coverage_level: level,
      coverage_caveats: caveats.slice(0, 6),
      text: evidenceText,
    },
    uncertainty,
    generated_from: {
      finding_id: finding.id,
      run_id: run.id,
      event_ids: events.map((e) => e.id),
      evidence_ids: evidence.map((e) => e.id),
      policy_version_id: policy?.id ?? null,
      policy_rule_id: finding.policy_rule_id,
      coverage_report_run_id: coverage ? coverage.run_id : null,
      safeguard_ids: safeguards.map((s) => s.id),
      verification_run_ids: [...new Set(safeguards.flatMap((s) => s.all_run_ids))],
    },
    disclaimer: `Deterministic summary of the stored ${FINDING_CATEGORY_LABELS[finding.category].toLowerCase()} finding and the records listed in generated_from; no AI was used. It is not independent evidence: the full technical details below are the source.`,
  };
}
