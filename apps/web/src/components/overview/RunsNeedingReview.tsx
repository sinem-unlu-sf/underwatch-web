import type { RunListItem } from "@kw/schema";
import { Link } from "react-router";
import { useOverview } from "../../api/queries";
import { CoverageBadge, FixtureBadge, RunStatusBadge, SeverityBadge } from "../badges";
import { Section } from "../ds/Section";
import { EmptyState, ErrorState, LoadingState } from "../states";
import { Mono, Time } from "../ui";
import { ListFooter } from "./ListFooter";

/**
 * "Needs review": runs that still have open findings (new, under review, unresolved). Moved here from the Overview so
 * the Overview stays a short read. Data: the persisted overview record (runs_needing_review), no client-side guessing.
 */
export function RunsNeedingReviewSection() {
  const q = useOverview();
  return (
    <Section
      id="needs-review"
      title="Needs review"
      description="Runs with open findings (new, under review or unresolved), highest open severity first."
      actions={
        <Link to="/findings?status=open" className="text-[12px] text-fg-1 hover:text-fg-0 hover:underline">
          All open findings
        </Link>
      }
    >
      <div className="mb-6 rounded-md border border-line bg-surface-1">
        {q.isPending ? (
          <LoadingState label="Loading runs needing review…" />
        ) : q.isError ? (
          <div className="p-3">
            <ErrorState error={q.error} what="runs needing review" />
          </div>
        ) : q.data.runs_needing_review.count === 0 ? (
          <EmptyState title="No runs need review">Every recorded run's findings are confirmed, resolved or dismissed.</EmptyState>
        ) : (
          <>
            <RunList runs={q.data.runs_needing_review.items} showOpen label="Runs needing review" />
            {q.data.runs_needing_review.count > q.data.runs_needing_review.items.length ? (
              <ListFooter
                shown={q.data.runs_needing_review.items.length}
                total={q.data.runs_needing_review.count}
                noun="runs"
                to="/runs?has_findings=true"
                caveat="The filter below lists every run with findings, open or not."
              />
            ) : null}
          </>
        )}
      </div>
    </Section>
  );
}

export function RunList({ runs, showOpen, label = "Runs" }: { runs: RunListItem[]; showOpen?: boolean; label?: string }) {
  return (
    <ul className="divide-y divide-line" aria-label={label}>
      {runs.map((r) => (
        <li key={r.id} className="flex flex-col gap-1 px-3 py-2.5 transition-colors duration-120 hover:bg-surface-2/50">
          <div className="flex flex-wrap items-center gap-2">
            <Link to={`/runs/${encodeURIComponent(r.id)}`} className="min-w-0 flex-1 truncate font-medium text-fg-0 hover:underline" title={r.task_description}>
              {r.label ?? <Mono>{r.id}</Mono>}
            </Link>
            {r.is_fixture ? <FixtureBadge isFixture /> : <span className="font-mono text-[10.5px] tracking-wider text-fg-2 uppercase">live</span>}
          </div>
          <div className="flex flex-wrap items-center gap-2 text-[11.5px] text-fg-2">
            <RunStatusBadge status={r.status} />
            {r.coverage_status !== "complete" ? <CoverageBadge level={r.coverage_status} /> : null}
            {showOpen ? (
              <>
                {r.max_open_severity ? <SeverityBadge severity={r.max_open_severity} /> : null}
                <span className="text-fg-1">{r.open_finding_count} open</span>
              </>
            ) : (
              <span>
                {r.event_count} events · {r.finding_count} findings
                {r.open_finding_count > 0 ? <span className="text-fg-1"> · {r.open_finding_count} open</span> : null}
              </span>
            )}
            <span>
              started <Time iso={r.started_at} />
            </span>
          </div>
        </li>
      ))}
    </ul>
  );
}
