import { outcomesForRun, type SafeguardListItem } from "@kw/schema";
import { Link } from "react-router";
import { useOverview, useSafeguards } from "../../api/queries";
import { ApplicationBadge, ApprovalBadge, Badge, FixtureBadge, SeverityBadge, TriState, VerificationBadge } from "../badges";
import { Section } from "../ds/Section";
import { EmptyState, ErrorState, LoadingState } from "../states";
import { Time } from "../ui";
import { truncate } from "../../lib/format";
import { ListFooter } from "./ListFooter";

/**
 * Moved from the Overview to the Safeguards page: safeguards awaiting a decision or with failed / inconclusive
 * verification, confirmed findings that may need a safeguard, and the recent verification results table.
 */

/** Why a safeguard needs a person, or null when it does not. Failed states first: they are unresolved problems. */
export function safeguardAction(s: Pick<SafeguardListItem, "approval_status" | "application_status" | "verification_status">): string | null {
  if (s.verification_status === "failed_verification") return "Verification failed for the tested scenario: review the result";
  if (s.application_status === "application_failed") return "Application failed: review and retry";
  if (s.verification_status === "verification_inconclusive") return "Verification inconclusive: the run did not establish the outcome";
  if (s.approval_status === "proposed") return "Proposed: awaiting approve or reject";
  return null;
}

const SAFEGUARD_ACTION_RANK = (s: SafeguardListItem) =>
  s.verification_status === "failed_verification" ? 0 : s.application_status === "application_failed" ? 1 : s.verification_status === "verification_inconclusive" ? 2 : 3;

export function SafeguardsNeedingActionSection() {
  const sg = useSafeguards({});
  const ov = useOverview();
  const needing = sg.data
    ? sg.data.items.filter((s) => safeguardAction(s) !== null).sort((a, b) => SAFEGUARD_ACTION_RANK(a) - SAFEGUARD_ACTION_RANK(b) || b.created_at.localeCompare(a.created_at))
    : [];
  const confirmed = ov.data?.confirmed_findings;

  return (
    <Section
      id="needs-action"
      title="Safeguards needing action"
      description="Proposed safeguards awaiting a decision, and failed or inconclusive verifications."
    >
      <div className="mb-6 rounded-md border border-line bg-surface-1">
        {sg.isPending ? (
          <LoadingState label="Loading safeguards…" />
        ) : sg.isError ? (
          <div className="p-3">
            <ErrorState error={sg.error} what="safeguards" />
          </div>
        ) : needing.length === 0 ? (
          <EmptyState title="Nothing awaiting a decision">
            No proposed safeguards and no failed or inconclusive verifications. Safeguards are proposed from a finding's page.
          </EmptyState>
        ) : (
          <SafeguardList items={needing} />
        )}
      </div>

      {confirmed && confirmed.count > 0 ? (
        <div className="mb-6">
          <h3 className="mb-2 text-[12.5px] font-medium text-fg-1">
            Confirmed findings <span className="font-mono text-fg-2">{confirmed.count}</span>
          </h3>
          <p className="mb-2 text-[12px] text-fg-2">Confirmed by a reviewer. Open one to propose or review its safeguard.</p>
          <div className="rounded-md border border-line bg-surface-1">
            <ul className="divide-y divide-line" aria-label="Confirmed findings">
              {confirmed.items.map((f) => (
                <li key={f.id} className="flex flex-wrap items-center gap-2 px-3 py-2 transition-colors duration-120 hover:bg-surface-2/50">
                  <SeverityBadge severity={f.severity} />
                  <Link to={`/findings/${encodeURIComponent(f.id)}`} className="min-w-0 flex-1 truncate text-fg-0 hover:underline" title={f.title}>
                    {f.title}
                  </Link>
                  <FixtureBadge isFixture={f.is_fixture} compact />
                </li>
              ))}
            </ul>
            {confirmed.count > confirmed.items.length ? (
              <ListFooter shown={confirmed.items.length} total={confirmed.count} noun="confirmed findings" to="/findings?status=confirmed" />
            ) : null}
          </div>
        </div>
      ) : null}

      <RecentVerificationResults />
    </Section>
  );
}

function SafeguardList({ items }: { items: SafeguardListItem[] }) {
  return (
    <ul className="divide-y divide-line" aria-label="Safeguards needing action">
      {items.map((s) => {
        const why = safeguardAction(s);
        return (
          <li key={s.id} className="flex flex-col gap-1 px-3 py-2.5 transition-colors duration-120 hover:bg-surface-2/50">
            <div className="flex flex-wrap items-center gap-2">
              <Link to={`/safeguards/${encodeURIComponent(s.id)}`} className="min-w-0 flex-1 truncate font-medium text-fg-0 hover:underline" title={s.title}>
                {s.title}
              </Link>
              <FixtureBadge isFixture={s.is_fixture} compact />
            </div>
            {why ? <p className="text-[12.5px] text-fg-2">{why}</p> : null}
            <div className="flex flex-wrap items-center gap-2 text-[11.5px] text-fg-2">
              <ApprovalBadge status={s.approval_status} />
              {s.application_status === "application_failed" ? <ApplicationBadge status={s.application_status} /> : null}
              {s.verification_status !== "not_tested" ? <VerificationBadge status={s.verification_status} /> : null}
              <span className="min-w-0 truncate">
                for{" "}
                <Link to={`/findings/${encodeURIComponent(s.finding_id)}`} className="text-fg-1 hover:underline" title={s.finding_title}>
                  {truncate(s.finding_title, 60)}
                </Link>
              </span>
            </div>
          </li>
        );
      })}
    </ul>
  );
}

function RecentVerificationResults() {
  const q = useOverview();
  if (q.isPending) return null;
  if (q.isError) return <ErrorState error={q.error} what="recent verification results" />;
  const v = q.data.recent_verification_results;
  return (
    <div>
      <h3 className="mb-1 text-[12.5px] font-medium text-fg-1">Recent verification results</h3>
      <p className="mb-2 text-[12px] text-fg-2">
        Security outcome and task outcome are separate: a blocked action implies neither task success nor failure. Results hold for the tested scenario only.
      </p>
      <div className="rounded-md border border-line bg-surface-1">
        {v.items.length === 0 ? (
          <EmptyState title="No completed verification runs">Verification runs start from an approved safeguard's page; none have completed yet.</EmptyState>
        ) : (
          <div className="overflow-x-auto">
            <table className="data" aria-label="Recent verification results">
              <thead>
                <tr>
                  <th>Safeguard</th>
                  <th title="Overall verification result for the tested scenario (legacy single field). It is not a task outcome.">Result</th>
                  <th title="Did the safeguard let the prohibited action through? (enforcement only)">Security outcome</th>
                  <th title="Independent completion checks only. A blocked action implies neither task success nor failure; agent claims never count.">Task outcome</th>
                </tr>
              </thead>
              <tbody>
                {v.items.map((r) => (
                  <tr key={r.id}>
                    <td className="min-w-[180px]">
                      <span className="flex items-center gap-1.5">
                        <FixtureBadge isFixture={r.is_fixture} compact />
                        <Link to={`/safeguards/${encodeURIComponent(r.safeguard_id)}`} className="hover:underline" title={r.safeguard_title}>
                          {truncate(r.safeguard_title, 50)}
                        </Link>
                      </span>
                      <span className="text-[11px] text-fg-2">
                        ended <Time iso={r.ended_at} />
                      </span>
                    </td>
                    <td>{r.result ? <VerificationBadge status={r.result} /> : <TriState value={null} />}</td>
                    <OutcomeCells run={r} />
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {v.count > v.items.length ? (
          <p className="border-t border-line px-3 py-2 text-[11.5px] text-fg-2">
            Showing {v.items.length} of {v.count} completed verification runs. Each safeguard's page lists its full history.
          </p>
        ) : null}
      </div>
    </div>
  );
}

/** Security and task outcomes as two separate cells, each with its basis; never one merged verdict. */
export function OutcomeCells({ run }: { run: Parameters<typeof outcomesForRun>[0] }) {
  const o = outcomesForRun(run);
  const s = o.security_outcome;
  const t = o.task_outcome;
  const basis = (b: string | null) => (b ? ` (${b})` : "");
  return (
    <>
      <td title={`${s.reason}${s.evidence_ids.length ? ` | evidence: ${s.evidence_ids.join(", ")}` : ""}`}>
        <Badge tone={s.value === "blocked" ? "verified" : s.value === "allowed" ? "risk" : "unknown"}>
          {s.value}
          {basis(s.basis)}
        </Badge>
      </td>
      <td title={`${t.reason}${t.evidence_ids.length ? ` | evidence: ${t.evidence_ids.join(", ")}` : ""}`}>
        <Badge tone={t.value === "succeeded" ? "verified" : t.value === "failed" ? "risk" : "unknown"}>
          {t.value}
          {basis(t.basis)}
        </Badge>
        {o.reported_task_claim?.claim === "claimed_success" && t.value !== "succeeded" ? <span className="ml-1 text-[11px] text-reported">agent claimed done (reported)</span> : null}
      </td>
    </>
  );
}
