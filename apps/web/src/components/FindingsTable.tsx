import type { FindingListItem } from "@kw/schema";
import { Link, useNavigate } from "react-router";
import { CategoryLabel, ConfidenceBadge, FindingKindBadge, FindingStatusBadge, FixtureBadge, SeverityBadge } from "./badges";
import { Mono, Time } from "./ui";

/** Severity and confidence are separate columns on purpose (PRD 6.6): high severity with low confidence is a different situation than the reverse. */
export function FindingsTable({ findings, showRun = true, onFilterTimeline }: { findings: FindingListItem[]; showRun?: boolean; onFilterTimeline?: (findingId: string) => void }) {
  const navigate = useNavigate();
  return (
    <div className="overflow-x-auto">
      <table className="data">
        <thead>
          <tr>
            <th>Severity</th>
            <th>Confidence</th>
            <th>Finding</th>
            <th>Category</th>
            <th>Status</th>
            {showRun ? <th>Run</th> : null}
            <th>Created</th>
            {onFilterTimeline ? <th /> : null}
          </tr>
        </thead>
        <tbody>
          {findings.map((f) => (
            <tr key={f.id} className="cursor-pointer" onClick={() => navigate(`/findings/${encodeURIComponent(f.id)}`)}>
              <td>
                <SeverityBadge severity={f.severity} />
              </td>
              <td>
                <ConfidenceBadge confidence={f.confidence} />
              </td>
              <td className="max-w-[420px]">
                <div className="flex min-w-0 items-center gap-1.5">
                  <FixtureBadge isFixture={f.is_fixture} />
                  <Link
                    to={`/findings/${encodeURIComponent(f.id)}`}
                    title={f.title}
                    className="min-w-0 truncate font-medium text-fg-0 hover:underline"
                    onClick={(e) => e.stopPropagation()}
                  >
                    {f.title}
                  </Link>
                </div>
                <Mono className="text-[11px] text-fg-2">{f.id}</Mono>
              </td>
              <td className="whitespace-nowrap">
                <div className="flex flex-col items-start gap-1">
                  <FindingKindBadge finding={f} />
                  <CategoryLabel category={f.category} />
                </div>
              </td>
              <td>
                <FindingStatusBadge status={f.status} />
              </td>
              {showRun ? (
                <td className="max-w-[200px] truncate">
                  <Link to={`/runs/${encodeURIComponent(f.run_id)}`} className="text-fg-1 hover:underline" onClick={(e) => e.stopPropagation()}>
                    {f.run_label ?? <Mono>{f.run_id}</Mono>}
                  </Link>
                </td>
              ) : null}
              <td>
                <Time iso={f.created_at} />
              </td>
              {onFilterTimeline ? (
                <td>
                  <button
                    type="button"
                    className="btn btn-sm whitespace-nowrap"
                    onClick={(e) => {
                      e.stopPropagation();
                      onFilterTimeline(f.id);
                    }}
                  >
                    Show in timeline
                  </button>
                </td>
              ) : null}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
