import type { BriefAction, BriefActionStatus, BundleEvidenceRef, FindingBrief, Safeguard } from "@kw/schema";
import type { ReactNode } from "react";
import { Link } from "react-router";
import { Badge } from "../badges";
import { Icon } from "../ds/Icon";
import { StatusPill, type StatusKind } from "../ds/StatusPill";
import { Panel } from "../ui";
import { humanize, truncate } from "../../lib/format";

/**
 * Addendum C section 3A: concise explanation (Problem / Why it matters / How to fix). It renders the server's
 * deterministic brief, which is built from the same finding detail records the full view shows. Nothing here is a
 * new source of truth: action statuses come from stored safeguard / verification rows, and every evidence chip opens
 * the same record the full view lists.
 */

/** Honest status chips: symbol + the server's label. Green only for "verified for tested scenario". */
const STATUS_PILL: Record<BriefActionStatus, StatusKind> = {
  proposed: "pending",
  safeguard_proposed: "pending",
  applied: "active",
  verified_for_tested_scenario: "verified",
  failed_verification: "failed",
  inconclusive: "inconclusive",
};

export function BriefCard({
  brief,
  safeguards,
  evidenceIndex,
  onOpenEvidence,
  onShowFull,
  afterProblem,
}: {
  brief: FindingBrief | undefined;
  safeguards: readonly Safeguard[];
  evidenceIndex: ReadonlyMap<string, BundleEvidenceRef>;
  onOpenEvidence: (id: string) => void;
  onShowFull: () => void;
  /** Quick Read: the most relevant graph relationship, placed near the top (right after the problem statement). */
  afterProblem?: ReactNode;
}) {
  if (!brief) {
    return (
      <Panel title="Brief">
        <div role="status" className="hatch rounded-[3px] px-2 py-1.5 text-[12px] text-unknown">
          A concise brief could not be built for this finding. Nothing is hidden: the full technical details have every record.
        </div>
        <button type="button" className="mt-2 text-[12px] text-focus hover:underline" onClick={onShowFull}>
          Show full technical details
        </button>
      </Panel>
    );
  }
  const es = brief.evidence_summary;
  const chips = [...es.key_event_ids, ...es.key_evidence_ids];
  const rule = brief.affected.policy_rule;
  return (
    <Panel
      id="finding-brief"
      title="Brief"
      aside={
        <span className="flex items-center gap-1.5 text-[11px]">
          {brief.is_fixture ? <Badge tone="warn">{brief.data_origin}</Badge> : null}
          <span title="Built by Underwatch from stored records without AI">deterministic · no AI</span>
        </span>
      }
    >
      <div className="flex flex-col gap-3">
        <BriefBlock label="Problem">
          <p className="text-fg-0">{brief.problem}</p>
          <dl className="mt-1.5 flex flex-wrap gap-x-4 gap-y-0.5 text-[11.5px] text-fg-2">
            <span>
              <dt className="inline">Agent: </dt>
              <dd className="inline text-fg-1">{brief.affected.agent}</dd>
            </span>
            {brief.affected.resource ? (
              <span>
                <dt className="inline">Resource: </dt>
                <dd className="inline font-mono break-all text-fg-1">{brief.affected.resource}</dd>
              </span>
            ) : null}
            {rule ? (
              <span>
                <dt className="inline">Rule: </dt>
                <dd className="inline text-fg-1">
                  {rule.id}
                  {rule.effect ? ` (${rule.effect})` : ""}
                  {rule.description ? `: ${truncate(rule.description, 90)}` : ""}
                </dd>
              </span>
            ) : null}
            <span>
              <dt className="inline">Run: </dt>
              <dd className="inline">
                <Link to={`/runs/${encodeURIComponent(brief.affected.run_id)}`} className="text-fg-1 hover:underline">
                  {brief.affected.run_label ?? brief.affected.run_id}
                </Link>
              </dd>
            </span>
          </dl>
        </BriefBlock>

        {afterProblem}

        <BriefBlock label="Why it matters">
          <p className="text-fg-0">{brief.why_it_matters}</p>
          {brief.terms.length > 0 ? (
            <details className="mt-1">
              <summary className="cursor-pointer text-[11px] text-fg-2">Terms used ({brief.terms.length})</summary>
              <dl className="mt-1 space-y-0.5 text-[11.5px]">
                {brief.terms.map((t) => (
                  <div key={t.term}>
                    <dt className="inline font-semibold text-fg-1">{t.term}: </dt>
                    <dd className="inline text-fg-2">{t.meaning}</dd>
                  </div>
                ))}
              </dl>
            </details>
          ) : null}
        </BriefBlock>

        <BriefBlock label="How to fix">
          <ol className="space-y-2">
            {brief.how_to_fix.map((a, i) => (
              <ActionRow key={a.id} n={i + 1} action={a} safeguard={a.safeguard_id ? safeguards.find((s) => s.id === a.safeguard_id) : undefined} />
            ))}
          </ol>
        </BriefBlock>

        <div className="border-t border-line pt-2">
          <div className="label mb-1">Evidence</div>
          <p className="text-[12px] text-fg-1">{es.text}</p>
          {chips.length > 0 ? (
            <div className="mt-1.5 flex flex-wrap gap-1.5" role="group" aria-label="Key evidence">
              {chips.map((id) => {
                const ref = evidenceIndex.get(id);
                const label = ref ? `${ref.basis ?? ref.kind}: ${truncate(ref.summary, 48)}` : id;
                return (
                  <button
                    key={id}
                    type="button"
                    title={id}
                    onClick={() => onOpenEvidence(id)}
                    className={`inline-flex items-center gap-1 rounded-[5px] border px-1.5 py-0.5 text-left text-[11px] transition-colors duration-120 hover:bg-surface-3 ${
                      ref?.basis === "observed" ? "border-observed/50 text-observed" : ref?.basis === "reported" ? "border-reported/50 text-reported" : "border-line-strong text-fg-1"
                    }`}
                  >
                    <Icon name={ref?.basis === "observed" ? "eye" : ref?.basis === "reported" ? "quote" : ref?.kind === "evidence" ? "file" : "derive"} size={11} />
                    {label}
                  </button>
                );
              })}
            </div>
          ) : null}
          {es.coverage_caveats.length > 0 ? (
            <p className="mt-1 text-[11px] text-fg-2">
              Coverage {es.coverage_level}. {es.coverage_caveats.join(" ")}
            </p>
          ) : null}
        </div>

        <div className="border-t border-line pt-2" aria-label="Uncertainty">
          <span className="label mr-1.5">Uncertainty</span>
          {brief.uncertainty.length === 0 ? (
            <span className="text-[12px] text-fg-2">No uncertainty flagged by the stored records.</span>
          ) : (
            <ul className="mt-1 space-y-0.5">
              {brief.uncertainty.map((u, i) => (
                <li key={i} className="hatch rounded-[2px] px-1.5 py-0.5 text-[12px] text-fg-1">
                  {u.text}
                </li>
              ))}
            </ul>
          )}
        </div>

        <p className="border-t border-line pt-2 text-[11px] text-fg-2">
          Built from the same records as the full report ({brief.generated_from.event_ids.length} events, {brief.generated_from.evidence_ids.length} evidence
          records, {brief.generated_from.safeguard_ids.length} safeguards). Not independent evidence.{" "}
          <button type="button" className="text-focus hover:underline" onClick={onShowFull}>
            Open the full technical details
          </button>
        </p>
      </div>
    </Panel>
  );
}

function BriefBlock({ label, children }: { label: string; children: ReactNode }) {
  return (
    <section aria-label={label}>
      <h3 className="label mb-0.5">{label}</h3>
      {children}
    </section>
  );
}

function ActionRow({ n, action: a, safeguard }: { n: number; action: BriefAction; safeguard: Safeguard | undefined }) {
  /** The brief's status follows the latest verification; say plainly when that safeguard is still not applied. */
  const fromVerification = a.status === "verified_for_tested_scenario" || a.status === "failed_verification" || a.status === "inconclusive";
  const notApplied = fromVerification && safeguard && safeguard.application_status !== "applied" ? safeguard : null;
  return (
    <li className="rounded-[3px] border border-line bg-surface-2 px-2 py-1.5" data-action-status={a.status}>
      <div className="flex flex-wrap items-start gap-1.5">
        <span className="font-mono text-[11px] text-fg-2">{n}.</span>
        <span className="min-w-0 flex-1 text-[12.5px] text-fg-0">{a.text}</span>
      </div>
      <div className="mt-1 flex flex-wrap items-center gap-1.5 pl-4">
        <StatusPill kind={STATUS_PILL[a.status]} title={a.status_basis}>
          {a.status_label}
        </StatusPill>
        {notApplied ? (
          <Badge tone="muted" title="Verification ran against this safeguard, but it is not recorded as applied to your workspace">
            safeguard {notApplied.application_status.replace(/_/g, " ")}
          </Badge>
        ) : null}
        {a.mechanism ? <Badge tone="muted">{humanize(a.mechanism)}</Badge> : null}
        {a.enforces === false ? (
          <Badge tone="warn" title="Written guidance influences the agent; it is not technical enforcement">
            guidance, not enforced
          </Badge>
        ) : null}
        {a.safeguard_id ? (
          <Link to={`/safeguards/${encodeURIComponent(a.safeguard_id)}`} className="font-mono text-[11px] text-focus hover:underline">
            {a.safeguard_id}
          </Link>
        ) : null}
      </div>
      <p className="mt-0.5 pl-4 text-[11px] text-fg-2">{a.status_basis}</p>
      {a.mechanism_limit ? <p className="pl-4 text-[11px] text-fg-2">Limit: {a.mechanism_limit}</p> : null}
    </li>
  );
}
