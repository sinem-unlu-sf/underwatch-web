/**
 * Short read: the finding in <= 150 words (one direct sentence, 2-5 real counts, one-line cause, one-line fix with its
 * honest status). Deterministic, no AI, nothing stored. Built from the same BriefInput as the brief, plus the run's
 * finding count. Every string copied from a record is redacted; statuses come from the brief's action statuses, which
 * come from stored safeguard / verification rows only.
 */
import {
  SHORT_READ_MAX_WORDS,
  SHORT_READ_VERSION,
  shortReadWordCount,
  type BriefAction,
  type BriefActionStatus,
  type Event,
  type FindingBrief,
  type SafeguardType,
  type ShortRead,
  type ShortReadNumber,
} from "@kw/schema";
import { safeRedact } from "@kw/redaction";
import type { Db } from "../db/connection";
import { processRedactionOptions } from "../ingest/sanitize";
import type { BriefInput } from "./brief";

export interface ShortReadInput extends BriefInput {
  /** Number of findings stored for the finding's run (including this one). */
  run_finding_count: number;
  /** listRunResourceEvents(run, brief.affected.resource); empty when unknown. */
  run_resource_events?: ResourceEventRow[];
}

/** Independently observed (non-agent) events in the run on one resource: the run-wide counts behind the numbers. */
export interface ResourceEventRow {
  id: string;
  source: string;
  event_type: string;
  process_name: string | null;
  outcome: string;
}

export function listRunResourceEvents(db: Db, runId: string, resource: string | null): ResourceEventRow[] {
  if (!resource) return [];
  return db
    .prepare("SELECT id, source, event_type, process_name, outcome FROM events WHERE run_id = ? AND basis = 'observed' AND target_resource = ? ORDER BY timestamp, id")
    .all(runId, resource) as unknown as ResourceEventRow[];
}

export function countRunFindings(db: Db, runId: string): number {
  const row = db.prepare("SELECT COUNT(*) AS n FROM findings WHERE run_id = ?").get(runId) as { n: number } | undefined;
  return Number(row?.n ?? 0);
}

function red(text: string, max = 80): string {
  const r = safeRedact(text, { ...processRedactionOptions(), keepCleanTextVerbatim: true }).text.replace(/\s+/g, " ").trim();
  return r.length > max ? `${r.slice(0, max - 1).trimEnd()}…` : r;
}

const shortId = (id: string) => (id.length > 12 ? `${id.slice(0, 12)}…` : id);
const n = (k: number, one: string, many = `${one}s`) => `${k} ${k === 1 ? one : many}`;
const SENSITIVE = /(^|[/\\.])env\b|\.env|secret|credential|\.pem\b|id_rsa|token|password/i;

const MECH_SHORT: Record<SafeguardType, string> = {
  claude_md_instruction: "CLAUDE.md instruction (guidance only)",
  permission_rule: "Permission rule",
  hook_policy: "Hook policy",
  regression_test: "Regression test",
  kernel_enforcement: "Kernel enforcement",
};

const STATUS_RANK: Record<BriefActionStatus, number> = {
  verified_for_tested_scenario: 5,
  applied: 4,
  failed_verification: 3,
  inconclusive: 2,
  safeguard_proposed: 1,
  proposed: 0,
};

/** The fix to show: the action with the most advanced recorded status; ties keep the brief's order. */
function pickFix(actions: BriefAction[]): BriefAction {
  return [...actions].sort((a, b) => STATUS_RANK[b.status] - STATUS_RANK[a.status])[0]!;
}

function matchesResource(e: Event, res: string | null): boolean {
  if (!res || !e.target_resource) return false;
  return e.target_resource === res || e.target_resource.endsWith(`/${res.replace(/^\/+/, "")}`) || res.endsWith(`/${e.target_resource.replace(/^\/+/, "")}`);
}

export function buildShortRead(input: ShortReadInput, brief: FindingBrief): ShortRead {
  const { detail, safeguards } = input;
  const { finding, run, related_events: events, evidence } = detail;
  const isFixture = brief.is_fixture;
  const resRaw = brief.affected.resource;
  const res = resRaw ? red(resRaw, 60) : null;
  const rule = brief.affected.policy_rule;
  const runRef = `run ${shortId(run.id)}`;

  const independent = events.filter((e) => e.basis !== "reported");
  const linkedOnRes: Pick<Event, "id" | "source" | "event_type" | "process_name" | "outcome">[] = independent.filter((e) => matchesResource(e, resRaw));
  // Prefer run-wide observed events on the resource (e.g. every kernel open), falling back to the finding's linked ones.
  const runObserved = (input.run_resource_events ?? []) as typeof linkedOnRes;
  const onRes = runObserved.length ? runObserved : linkedOnRes;
  const kernelOnRes = onRes.filter((e) => e.source === "kernel_tracer");
  const succeeded = onRes.filter((e) => e.outcome === "succeeded" && e.event_type !== "file_read");
  const blocked = onRes.filter((e) => e.outcome === "blocked" || e.outcome === "denied");
  const reportedOnRes = events.filter((e) => e.basis === "reported" && matchesResource(e, resRaw));
  const proc = (succeeded[0] ?? blocked[0] ?? onRes[0] ?? independent.find((e) => e.process_name))?.process_name ?? null;
  const actor = proc ? red(proc.split("/").pop() ?? proc, 30) : brief.affected.agent;
  const kernelTag = (list: typeof onRes) => (list.length && list.every((e) => e.source === "kernel_tracer") ? "kernel-observed" : "independently observed");
  const policyRule = detail.policy && finding.policy_rule_id ? detail.policy.rules.find((r) => r.id === finding.policy_rule_id) : undefined;
  const action = policyRule?.action === "file_write" ? "write" : "open";
  const anySucceeded = independent.some((e) => e.outcome === "succeeded") || succeeded.length > 0;
  const anyBlocked = independent.some((e) => e.outcome === "blocked" || e.outcome === "denied") || blocked.length > 0;

  // Finding: one direct sentence --------------------------------------------------------------------------------
  const resLabel = res ? `${res}${SENSITIVE.test(res) ? " (protected secrets file)" : ""}` : "a resource";
  let sentence: string;
  switch (finding.category) {
    case "permission_violation": {
      const verb = action === "write" ? "wrote to" : "opened";
      const despite = rule ? `, despite policy rule ${red(rule.id, 30)}${rule.effect === "deny" ? " denying it" : ""}` : "";
      sentence =
        anySucceeded
          ? `${actor} ${verb} ${resLabel} during ${runRef}${despite}`
          : anyBlocked
            ? `${actor} tried to ${action === "write" ? "write to" : "open"} ${resLabel} during ${runRef} and was blocked${kernelOnRes.some((e) => e.outcome === "blocked" || e.outcome === "denied") ? " in the kernel" : ""}`
            : `${actor} attempted to ${action === "write" ? "write to" : "open"} ${resLabel} during ${runRef}${despite}; the outcome is not established`;
      break;
    }
    case "unreported_observed_action":
      sentence = `${actor} touched ${resLabel} during ${runRef}, and the agent's report never mentions it`;
      break;
    case "outcome_mismatch":
      sentence = `The agent's claimed result in ${runRef} contradicts the observed record: "${red(finding.title, 80)}"`;
      break;
    case "change_mismatch":
      sentence = `Observed changes in ${runRef}${res ? ` (${res})` : ""} differ from what the agent reported`;
      break;
    case "uncertain_correlation":
      sentence = `Activity on ${resLabel} in ${runRef} could not be matched to any agent-reported action`;
      break;
  }
  const findingLine = `${sentence}${isFixture ? " (hand-labeled fixture)" : ""}.`;

  // Numbers: real counts only -----------------------------------------------------------------------------------
  const numbers: ShortReadNumber[] = [];
  const ids = (list: { id: string }[]) => list.map((e) => e.id);
  const noun = succeeded.every((e) => e.event_type === "file_open") ? "open" : succeeded.every((e) => e.event_type === "file_write") ? "write" : "access";
  if (res && succeeded.length) numbers.push({ text: `${n(succeeded.length, `successful ${noun}`, noun === "access" ? "successful accesses" : `successful ${noun}s`)} of ${res}${proc ? ` by ${actor}` : ""} (${kernelTag(succeeded)})`, basis: "observed", evidence_ids: ids(succeeded) });
  if (res && blocked.length) numbers.push({ text: `${n(blocked.length, "blocked or denied attempt")} on ${res} (${kernelTag(blocked)})`, basis: "observed", evidence_ids: ids(blocked) });
  if (res && !succeeded.length && !blocked.length && onRes.length) numbers.push({ text: `${n(onRes.length, "independently observed event")} on ${res}`, basis: "observed", evidence_ids: ids(onRes) });
  if (!res || !onRes.length) {
    const obs = events.filter((e) => e.basis === "observed");
    numbers.push({ text: `${n(obs.length, "independently observed event")} linked to this finding`, basis: "observed", evidence_ids: ids(obs) });
  }
  if (res) numbers.push({ text: `agent's own report: ${n(reportedOnRes.length, "action")} on ${res}`, basis: "reported", evidence_ids: ids(reportedOnRes) });
  else {
    const rep = events.filter((e) => e.basis === "reported");
    numbers.push({ text: `${n(rep.length, "agent-reported event")} linked`, basis: "reported", evidence_ids: ids(rep) });
  }
  numbers.push({ text: `${n(input.run_finding_count, "finding")} in this run`, basis: "derived", evidence_ids: [run.id] });
  for (const sg of safeguards) {
    if (numbers.length >= 5) break;
    if (!sg.latest_run) continue;
    const v = sg.verification === "passed" ? "passed for tested scenario" : sg.verification === "failed" ? "failed" : sg.verification === "inconclusive" ? "inconclusive" : sg.verification === "running" ? "running" : "not completed";
    numbers.push({ text: `${MECH_SHORT[sg.type].replace(/ \(guidance only\)$/, "")} verification: ${v} (latest of ${n(sg.all_run_ids.length || 1, "run")})`, basis: "derived", evidence_ids: [sg.latest_run.id] });
  }

  // Why: exactly one line -----------------------------------------------------------------------------------------
  const lastRoute = events.filter((e) => e.basis === "reported" && e.event_type === "tool_call" && e.tool_name).pop();
  let why: string;
  switch (finding.category) {
    case "permission_violation":
      if (anyBlocked && !anySucceeded) why = "An enforcement layer stopped the attempt; blocking is a security outcome, not proof the task still succeeded.";
      else if (!anySucceeded) why = "The records show the attempt but not whether any control stopped it.";
      else if (lastRoute?.tool_name === "Bash" || (proc && !/^claude/i.test(proc)))
        why = `The permission rule only covers the agent's own tool calls; ${proc && !/^claude/i.test(proc) ? `a ${actor} process` : "a shell command"} opened the file directly.`;
      else why = `The permission rule did not stop the agent's ${lastRoute?.tool_name ?? "tool"} call on the file.`;
      break;
    case "unreported_observed_action":
      why = "The agent's summary omits actions it took, so it is not a complete record of what happened.";
      break;
    case "outcome_mismatch":
      why = "The agent reported a result without it matching the independently observed outcome.";
      break;
    case "change_mismatch":
      why = "The agent's summary does not list every change it made.";
      break;
    case "uncertain_correlation":
      why = "No collector could attribute the activity to a reported action; this is an evidence gap, not a confirmed violation.";
      break;
  }

  // Fix: one line with honest status ------------------------------------------------------------------------------
  const fixAction = pickFix(brief.how_to_fix);
  const sg = fixAction.safeguard_id ? safeguards.find((s) => s.id === fixAction.safeguard_id) : undefined;
  const ver = fixAction.verification_run_id ? ` (${shortId(fixAction.verification_run_id)})` : "";
  const notApplied = sg && sg.lifecycle !== "applied" ? "; not applied to future runs" : "";
  const statusPhrase: Record<BriefActionStatus, string> = {
    verified_for_tested_scenario: `verified for the tested scenario${ver}${notApplied}`,
    applied: "applied, not yet verified",
    failed_verification: `verification failed${ver}`,
    inconclusive: `verification inconclusive${ver}`,
    safeguard_proposed: `safeguard ${fixAction.safeguard_id ? shortId(fixAction.safeguard_id) : ""} proposed, not applied`.replace(/\s+/g, " "),
    proposed: "proposed; no safeguard record yet",
  };
  const fixWhat = fixAction.mechanism
    ? `${MECH_SHORT[fixAction.mechanism]}${res && (fixAction.mechanism === "kernel_enforcement" || fixAction.mechanism === "permission_rule") ? ` on ${res}` : ""}`
    : (() => {
        const first = (fixAction.text.split(/[;:]\s|\.\s|\.$/)[0] ?? fixAction.text).trim();
        const w = first.split(/\s+/);
        return red(w.length > 20 ? `${w.slice(0, 20).join(" ")}…` : first, 160);
      })();
  const fix = `${fixWhat} - ${fixAction.mechanism ? statusPhrase[fixAction.status] : "recommendation only"}.`;

  // Enforce the word limit (drop trailing numbers first, then clip) ---------------------------------------------
  const out = { finding: findingLine, numbers, why, fix };
  while (shortReadWordCount(out) > SHORT_READ_MAX_WORDS && out.numbers.length > 2) out.numbers = out.numbers.slice(0, -1);
  const clipWords = (t: string, max: number) => {
    const w = t.split(/\s+/).filter(Boolean);
    return w.length > max ? `${w.slice(0, max).join(" ")}…` : t;
  };
  if (shortReadWordCount(out) > SHORT_READ_MAX_WORDS) {
    out.finding = clipWords(out.finding, 45);
    out.why = clipWords(out.why, 30);
    out.fix = clipWords(out.fix, 30);
    out.numbers = out.numbers.map((x) => ({ ...x, text: clipWords(x.text, 10) }));
  }

  return {
    short_read_version: SHORT_READ_VERSION,
    deterministic: true,
    finding_id: finding.id,
    is_fixture: isFixture,
    ...out,
    fix_status: fixAction.status,
    fix_status_label: fixAction.status_label,
    fix_safeguard_id: fixAction.safeguard_id,
    fix_verification_run_id: fixAction.verification_run_id,
    word_count: shortReadWordCount(out),
    generated_from: {
      finding_id: finding.id,
      run_id: run.id,
      event_ids: events.map((e) => e.id),
      evidence_ids: evidence.map((e) => e.id),
      safeguard_ids: safeguards.map((s) => s.id),
      verification_run_ids: [...new Set(safeguards.flatMap((s) => s.all_run_ids))],
    },
  };
}
