import type { Safeguard } from "@kw/schema";

export type StepState = "reached" | "in_progress" | "failed" | "not_reached";
export interface ProgressStep {
  key: "investigate" | "propose" | "review" | "test" | "verify";
  label: string;
  state: StepState;
  detail: string;
}

/**
 * Investigate -> Propose -> Review -> Test -> Verify, computed ONLY from stored safeguard rows (approval, application,
 * verification status). Nothing is marked reached without a record; "verified" always means "for the tested scenario".
 */
export function safeguardProgression(safeguards: readonly Safeguard[]): ProgressStep[] {
  const n = safeguards.length;
  const approved = safeguards.filter((s) => s.approval_status === "approved").length;
  const rejected = safeguards.filter((s) => s.approval_status === "rejected").length;
  const applied = safeguards.filter((s) => s.application_status === "applied").length;
  const tested = safeguards.filter((s) => s.verification_status !== "not_tested").length;
  const pending = safeguards.filter((s) => s.verification_status === "test_pending").length;
  const verified = safeguards.filter((s) => s.verification_status === "verified_for_tested_scenario").length;
  const failed = safeguards.filter((s) => s.verification_status === "failed_verification").length;
  const inconclusive = safeguards.filter((s) => s.verification_status === "verification_inconclusive").length;

  const testParts = [
    tested - pending > 0 ? `${tested - pending} tested` : null,
    pending > 0 ? `${pending} running` : null,
  ].filter(Boolean);
  const verifyParts = [
    verified > 0 ? `${verified} verified for tested scenario` : null,
    failed > 0 ? `${failed} failed` : null,
    inconclusive > 0 ? `${inconclusive} inconclusive` : null,
  ].filter(Boolean);

  return [
    { key: "investigate", label: "Investigate", state: "reached", detail: "finding recorded" },
    {
      key: "propose",
      label: "Propose",
      state: n > 0 ? "reached" : "not_reached",
      detail: n > 0 ? `${n} safeguard${n === 1 ? "" : "s"} proposed` : "no safeguard proposed",
    },
    {
      key: "review",
      label: "Review",
      state: approved + rejected > 0 ? "reached" : "not_reached",
      detail:
        approved + rejected > 0
          ? [approved ? `${approved} approved` : null, rejected ? `${rejected} rejected` : null, applied ? `${applied} applied` : null].filter(Boolean).join(", ")
          : n > 0
            ? "not reviewed"
            : "nothing to review",
    },
    {
      key: "test",
      label: "Test",
      state: tested === 0 ? "not_reached" : tested === pending ? "in_progress" : "reached",
      detail: tested > 0 ? testParts.join(", ") : "not tested",
    },
    {
      key: "verify",
      label: "Verify",
      state: verified > 0 ? "reached" : failed + inconclusive > 0 ? "failed" : "not_reached",
      detail: verifyParts.length > 0 ? verifyParts.join(", ") : "no verification result",
    },
  ];
}

const STATE_CLASS: Record<StepState, string> = {
  reached: "border-verified/50 text-verified",
  in_progress: "border-focus/50 text-focus",
  failed: "border-risk/55 text-risk",
  not_reached: "border-line text-fg-2",
};
const STATE_TEXT: Record<StepState, string> = { reached: "recorded", in_progress: "in progress", failed: "failed or inconclusive", not_reached: "not yet" };

export function SafeguardProgression({ safeguards, onOpenSafeguards }: { safeguards: readonly Safeguard[]; onOpenSafeguards?: () => void }) {
  const steps = safeguardProgression(safeguards);
  return (
    <div className="rounded-[4px] border border-line bg-surface-1 px-3 py-2" aria-label="Safeguard progression">
      <div className="mb-1.5 flex flex-wrap items-center justify-between gap-2">
        <span className="label">Safeguard progression (from stored safeguard records)</span>
        {onOpenSafeguards ? (
          <button type="button" className="text-[11px] text-focus hover:underline" onClick={onOpenSafeguards}>
            safeguard details
          </button>
        ) : null}
      </div>
      <ol className="flex flex-wrap items-stretch gap-1 text-[11.5px]">
        {steps.map((s, i) => (
          <li key={s.key} className="flex items-center gap-1" data-step={s.key} data-state={s.state}>
            {i > 0 ? (
              <span className="text-fg-2" aria-hidden>
                →
              </span>
            ) : null}
            <span className={`rounded-[3px] border px-1.5 py-0.5 ${STATE_CLASS[s.state]}`} title={`${s.label}: ${STATE_TEXT[s.state]}`}>
              <span className="font-semibold">{s.label}</span> <span className="text-fg-2">· {s.detail}</span>
            </span>
          </li>
        ))}
      </ol>
    </div>
  );
}
