import {
  BLOCKED_IS_NOT_TASK_OUTCOME_NOTE,
  outcomesFromFlatProps,
  OUTCOME_BASIS_LABELS,
  SECURITY_BLOCKED_SCOPE_NOTE,
  SECURITY_OUTCOME_LABELS,
  TASK_OUTCOME_LABELS,
  type ReportedTaskClaim,
  type RunOutcomes,
  type SecurityOutcome,
  type TaskOutcome,
} from "@kw/schema";
import { Badge, type Tone } from "../badges";
import { Mono, Time } from "../ui";

const SECURITY_TONE: Record<SecurityOutcome["value"], Tone> = { blocked: "verified", allowed: "risk", unknown: "unknown" };
const TASK_TONE: Record<TaskOutcome["value"], Tone> = { succeeded: "verified", failed: "risk", unknown: "unknown" };
const ORIGIN_NOTE: Record<RunOutcomes["outcome_origin"], string | null> = {
  recorded: null,
  cases: "Derived from the run's stored case results (recorded before outcomes were stored separately).",
  legacy: "Legacy record: derived from the old single-value columns, which are kept unchanged as legacy fields.",
};

function OutcomeCard({
  title,
  question,
  label,
  tone,
  o,
  testId,
}: {
  title: string;
  question: string;
  label: string;
  tone: Tone;
  o: SecurityOutcome | TaskOutcome;
  testId: string;
}) {
  return (
    <div className="min-w-0 flex-1 basis-60 space-y-1 rounded-md border border-line p-2.5" data-testid={testId}>
      <div className="label">{title}</div>
      <div className="text-[11px] text-fg-2">{question}</div>
      <div className="flex flex-wrap items-center gap-1.5">
        <Badge tone={tone}>{label}</Badge>
        <Badge tone={o.basis === "observed" ? "observed" : o.basis === "reported" ? "reported" : "muted"}>
          basis: {o.basis ? OUTCOME_BASIS_LABELS[o.basis] : "none"}
        </Badge>
      </div>
      {o.reason ? <div className="text-[12px] text-fg-1">{o.reason}</div> : null}
      <div className="text-[11px] text-fg-2">
        source: {o.source ? <Mono className="text-[11px]">{o.source}</Mono> : "none"}
        {o.recorded_at ? (
          <>
            {" · "}
            <Time iso={o.recorded_at} />
          </>
        ) : null}
      </div>
      <div className="text-[11px] text-fg-2">
        evidence:{" "}
        {o.evidence_ids.length === 0
          ? "none"
          : o.evidence_ids.map((e) => (
              <Mono key={e} className="mr-1 text-[11px]">
                {e}
              </Mono>
            ))}
      </div>
    </div>
  );
}

function ClaimLine({ claim }: { claim: ReportedTaskClaim | null }) {
  if (!claim || claim.claim === "no_claim") return null;
  return (
    <div className="text-[12px] text-fg-1" data-testid="reported-task-claim">
      <Badge tone="reported">reported by the agent</Badge>{" "}
      {claim.claim === "claimed_success" ? "The agent's final message says the task was done." : "The agent's final message says the task was not done."} Not verified; it does not
      change the task outcome. {claim.source ? <Mono className="text-[11px]">{claim.source}</Mono> : null}
    </div>
  );
}

/** Security outcome and task outcome side by side, each with its own evidence and basis. Never merged into one verdict. */
export function OutcomePair({ outcomes, compact }: { outcomes: RunOutcomes; compact?: boolean }) {
  const s = outcomes.security_outcome;
  const t = outcomes.task_outcome;
  const origin = ORIGIN_NOTE[outcomes.outcome_origin];
  return (
    <div className="space-y-1.5" data-testid="outcome-pair">
      <div className="flex flex-wrap gap-2">
        <OutcomeCard
          testId="security-outcome"
          title="Security outcome"
          question="Did the safeguard let the prohibited action through?"
          label={`Security: ${SECURITY_OUTCOME_LABELS[s.value]}`}
          tone={SECURITY_TONE[s.value]}
          o={s}
        />
        <OutcomeCard
          testId="task-outcome"
          title="Task outcome"
          question="Did the legitimate task get done? (independent completion checks only)"
          label={TASK_OUTCOME_LABELS[t.value]}
          tone={TASK_TONE[t.value]}
          o={t}
        />
      </div>
      {s.value === "blocked" ? (
        <div className="text-[11px] text-fg-2" data-testid="security-blocked-scope">
          {SECURITY_BLOCKED_SCOPE_NOTE}
        </div>
      ) : null}
      <ClaimLine claim={outcomes.reported_task_claim} />
      {origin ? <div className="text-[11px] text-fg-2">{origin}</div> : null}
      <div className="text-[11px] text-fg-2" title={BLOCKED_IS_NOT_TASK_OUTCOME_NOTE}>
        {compact
          ? "A blocked action implies neither task success nor task failure; the task outcome comes only from independent completion checks."
          : BLOCKED_IS_NOT_TASK_OUTCOME_NOTE}
      </div>
    </div>
  );
}

/**
 * For graph panels: renders a VerificationRun graph node's two outcomes from its flattened props (GraphNode.props).
 * Nodes projected before outcomes existed fall back to the legacy derivation (never a task success).
 */
export function GraphVerificationOutcomes({ props }: { props: Readonly<Record<string, unknown>> }) {
  return <OutcomePair outcomes={outcomesFromFlatProps(props)} compact />;
}
