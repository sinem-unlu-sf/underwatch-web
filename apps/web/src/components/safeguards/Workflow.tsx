import {
  MECHANISMS,
  SAFEGUARD_LIFECYCLE_LABELS,
  lifecycleFromLegacy,
  type MechanismInfo,
  type SafeguardLifecycleStatus,
  type SafeguardListItem,
  type VerificationState,
} from "@kw/schema";
import { Icon, type IconName } from "../ds/Icon";

/**
 * Investigate -> Propose -> Review -> Test -> Verify, derived ONLY from the safeguard's recorded state.
 *  - Investigate: a safeguard exists only for a finding with related evidence, so this step is always done.
 *  - Propose: done (a version or legacy record exists).
 *  - Review: approval decision, plus whether the approved change was applied / failed / rolled back.
 *  - Test: whether a verification run has executed.
 *  - Verify: the server-derived verification result. Green ("verified") only for "passed", and only for the tested
 *    scenario. Inconclusive stays inconclusive; not tested is never shown as safe.
 */
export type WorkflowStepState = "done" | "current" | "todo" | "failed" | "caution" | "inconclusive" | "off";
export type WorkflowStepId = "investigate" | "propose" | "review" | "test" | "verify";
export interface WorkflowStep {
  id: WorkflowStepId;
  label: string;
  state: WorkflowStepState;
  detail: string;
}

export interface WorkflowInput {
  lifecycle: SafeguardLifecycleStatus;
  verification: VerificationState;
  /** Can this mechanism be tested in this build? */
  testable: boolean;
  /** e.g. "v2 · ai& proposal"; defaults to "Proposal recorded". */
  proposeDetail?: string;
  /** Number of recorded verification runs, when known. */
  runCount?: number;
}

const APPLY_DETAIL: Partial<Record<SafeguardLifecycleStatus, string>> = {
  approved: "Approved · not applied yet",
  applied: "Approved · applied",
  rolled_back: "Approved · rolled back",
  application_failed: "Approved · application failed",
};

export function workflowSteps(i: WorkflowInput): WorkflowStep[] {
  const { lifecycle: lc, verification: vs } = i;
  const review: WorkflowStep =
    lc === "proposed"
      ? { id: "review", label: "Review", state: "current", detail: "Awaiting your approval" }
      : lc === "rejected"
        ? { id: "review", label: "Review", state: "failed", detail: "Rejected" }
        : { id: "review", label: "Review", state: lc === "application_failed" ? "caution" : "done", detail: APPLY_DETAIL[lc] ?? SAFEGUARD_LIFECYCLE_LABELS[lc] };

  const ran = vs === "passed" || vs === "failed" || vs === "inconclusive";
  const runs = i.runCount !== undefined && i.runCount > 0 ? ` · ${i.runCount} run${i.runCount === 1 ? "" : "s"}` : "";
  const test: WorkflowStep =
    vs === "running"
      ? { id: "test", label: "Test", state: "current", detail: "Verification running" }
      : ran
        ? { id: "test", label: "Test", state: "done", detail: `Tested in a disposable container${runs}` }
        : lc === "rejected"
          ? { id: "test", label: "Test", state: "off", detail: "Not tested (rejected)" }
          : !i.testable
            ? { id: "test", label: "Test", state: "off", detail: "Not testable in this build" }
            : lc === "proposed"
              ? { id: "test", label: "Test", state: "todo", detail: "Not tested" }
              : { id: "test", label: "Test", state: "current", detail: "Not tested yet: run verification" };

  const verify: WorkflowStep =
    vs === "passed"
      ? { id: "verify", label: "Verify", state: "done", detail: "Verified for the tested scenario only" }
      : vs === "failed"
        ? { id: "verify", label: "Verify", state: "failed", detail: "Failed verification" }
        : vs === "inconclusive"
          ? { id: "verify", label: "Verify", state: "inconclusive", detail: "Inconclusive: neither works nor fails" }
          : vs === "running"
            ? { id: "verify", label: "Verify", state: "todo", detail: "Waiting for the run" }
            : { id: "verify", label: "Verify", state: lc === "rejected" || !i.testable ? "off" : "todo", detail: "Not verified" };

  return [
    { id: "investigate", label: "Investigate", state: "done", detail: "Finding with related evidence" },
    { id: "propose", label: "Propose", state: "done", detail: i.proposeDetail ?? "Proposal recorded" },
    review,
    test,
    verify,
  ];
}

/** Workflow for a list row (v1 fields), using the same derivation as the server's compatibility mapping. */
export function workflowForListItem(s: Pick<SafeguardListItem, "type" | "approval_status" | "application_status" | "verification_status">): WorkflowInput {
  const { lifecycle, verification } = lifecycleFromLegacy(s);
  return { lifecycle, verification, testable: MECHANISMS[s.type].availability.status === "available" };
}

const STATE_SPEC: Record<WorkflowStepState, { icon: IconName; word: string; cls: string; dot: string }> = {
  done: { icon: "check", word: "done", cls: "text-fg-0", dot: "border-line-strong bg-surface-3 text-fg-0" },
  current: { icon: "dot", word: "current step", cls: "text-focus", dot: "border-focus bg-focus/15 text-focus" },
  todo: { icon: "circle", word: "not started", cls: "text-fg-2", dot: "border-line text-fg-2" },
  failed: { icon: "x", word: "failed", cls: "text-risk", dot: "border-risk/55 bg-risk/12 text-risk" },
  caution: { icon: "alertCircle", word: "needs attention", cls: "text-warn", dot: "border-warn/55 bg-warn/12 text-warn" },
  inconclusive: { icon: "question", word: "inconclusive", cls: "text-warn", dot: "hatch border-warn/45 text-warn" },
  off: { icon: "minus", word: "not applicable", cls: "text-unknown", dot: "hatch border-line text-unknown" },
};

/** Verified green is reserved for the Verify step when the result is "passed". */
function dotClass(step: WorkflowStep) {
  if (step.id === "verify" && step.state === "done") return "border-verified/55 bg-verified/12 text-verified";
  return STATE_SPEC[step.state].dot;
}

export function SafeguardWorkflow({
  input,
  lifecycle,
  compact,
  label = "Safeguard workflow",
}: {
  input: WorkflowInput;
  /** Kept as a screen-reader line for continuity with the previous stepper. */
  lifecycle?: SafeguardLifecycleStatus;
  compact?: boolean;
  label?: string;
}) {
  const steps = workflowSteps(input);
  if (compact) {
    return (
      <ol aria-label={label} className="relative flex flex-wrap items-center gap-x-1 gap-y-1 text-[11px]">
        {steps.map((s, idx) => {
          const spec = STATE_SPEC[s.state];
          return (
            <li key={s.id} className="flex items-center gap-1" data-step={s.id} data-step-state={s.state} title={s.detail}>
              {idx > 0 ? <Icon name="chevronRight" size={10} className="text-fg-disabled" /> : null}
              <span className={`inline-flex items-center gap-1 rounded-[5px] border px-1.5 py-px leading-4 ${dotClass(s)}`}>
                <Icon name={spec.icon} size={10} />
                {s.label}
                <span className="sr-only">
                  : {spec.word}. {s.detail}
                </span>
              </span>
            </li>
          );
        })}
      </ol>
    );
  }
  return (
    <ol aria-label={label} className="relative grid grid-cols-1 gap-2 sm:grid-cols-5 sm:gap-0">
      {steps.map((s, idx) => {
        const spec = STATE_SPEC[s.state];
        return (
          <li
            key={s.id}
            data-step={s.id}
            data-step-state={s.state}
            aria-current={s.state === "current" ? "step" : undefined}
            className="relative flex min-w-0 items-start gap-2 sm:flex-col sm:gap-1.5 sm:pr-3"
          >
            {idx < steps.length - 1 ? (
              <span aria-hidden className="absolute top-3 left-6 hidden h-px w-[calc(100%-1.75rem)] bg-line-strong sm:block" />
            ) : null}
            <span className={`relative z-[1] inline-flex size-6 shrink-0 items-center justify-center rounded-full border bg-surface-0 ${dotClass(s)}`}>
              <Icon name={spec.icon} size={12} />
            </span>
            <span className="min-w-0">
              <span className={`block text-[12px] font-semibold ${spec.cls}`}>
                <span className="mr-1 font-mono text-[10.5px] font-normal text-fg-2">{idx + 1}</span>
                {s.label}
                <span className="sr-only">: {spec.word}.</span>
              </span>
              <span className="block text-[11.5px] leading-4 text-fg-2">{s.detail}</span>
            </span>
          </li>
        );
      })}
      {lifecycle ? <li className="sr-only">Lifecycle: {SAFEGUARD_LIFECYCLE_LABELS[lifecycle]}</li> : null}
    </ol>
  );
}

/** One-line honest summary of what the mechanism enforces. CLAUDE.md / tests never read as enforcement. */
export function EnforcementPill({ m }: { m: Pick<MechanismInfo, "can_enforce" | "kind" | "availability"> }) {
  if (m.availability.status === "unavailable")
    return (
      <span className="hatch inline-flex items-center gap-1 rounded-[5px] border border-line px-1.5 py-px text-[11px] leading-4 text-unknown" title="This mechanism cannot be applied or tested in this build">
        <Icon name="minus" size={10} />
        Text only in this build
      </span>
    );
  if (m.can_enforce)
    return (
      <span className="inline-flex items-center gap-1 rounded-[5px] border border-line-strong bg-surface-2 px-1.5 py-px text-[11px] leading-4 text-fg-0" title="Can block actions when applied and in effect; only verification shows whether it does">
        <Icon name="shield" size={10} />
        Enforcing control (when applied)
      </span>
    );
  return (
    <span className="inline-flex items-center gap-1 rounded-[5px] border border-warn/45 bg-warn/12 px-1.5 py-px text-[11px] leading-4 text-warn" title={m.kind === "instruction" ? "CLAUDE.md is guidance, not a security boundary" : "Detects regressions; prevents nothing by itself"}>
      <Icon name="alertCircle" size={10} />
      {m.kind === "instruction" ? "Instruction only (guidance)" : "Detection only (prevents nothing)"}
    </span>
  );
}
