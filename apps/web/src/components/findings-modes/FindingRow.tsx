import type { Confidence, FindingCategory, FindingStatus, Outcome, Severity } from "@kw/schema";
import { useCallback, useState, type ReactNode } from "react";
import { Link } from "react-router";
import { Badge, CategoryLabel, ConfidenceBadge, FindingKindBadge, FindingStatusBadge, FixtureBadge, OutcomeBadge, SeverityBadge } from "../badges";
import { Icon } from "../ds/Icon";
import { Mono } from "../ui";
import { findingHref } from "./useFindingsMode";

export interface FindingRowData {
  id: string;
  run_id: string;
  run_label: string | null;
  title: string;
  severity: Severity;
  confidence: Confidence;
  status: FindingStatus;
  category: FindingCategory;
  is_fixture: boolean;
  /** Optional: when present, a linked policy rule marks the finding as a policy violation. */
  policy_rule_id?: string | null;
}

/** Expanded-row state keyed by finding id; lives above the list so it survives a refresh of the data. */
export function useExpanded() {
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set());
  const toggle = useCallback(
    (id: string) =>
      setOpen((prev) => {
        const next = new Set(prev);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        return next;
      }),
    [],
  );
  return { isOpen: (id: string) => open.has(id), toggle };
}

/**
 * One dense line per finding: severity and confidence as separate pills (high severity with low confidence is a
 * different situation than the reverse), the policy-violation vs needs-review kind, and status. Metadata and evidence
 * links appear when expanded. On narrow screens the pills wrap under the title instead of being hidden.
 */
export function FindingRow({
  finding,
  expanded,
  onToggle,
  from,
  marker,
  showRun = true,
  children,
}: {
  finding: FindingRowData;
  expanded: boolean;
  onToggle: () => void;
  /** Href of the current findings view, so the finding page can link back to it. */
  from: string;
  marker?: "new" | "updated";
  showRun?: boolean;
  children?: ReactNode;
}) {
  const detailId = `finding-detail-${finding.id}`;
  return (
    <li className="border-b border-line last:border-b-0">
      <div
        className={`flex items-start gap-2 px-3 py-2 transition-colors duration-120 ease-out sm:items-center ${
          expanded ? "bg-surface-2/60" : "hover:bg-surface-2/50"
        }`}
      >
        <button
          type="button"
          aria-expanded={expanded}
          aria-controls={detailId}
          aria-label={`${expanded ? "Collapse" : "Expand"} ${finding.title}`}
          onClick={onToggle}
          className="-ml-1 mt-px inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-sm text-fg-2 transition-colors duration-120 hover:bg-surface-3 hover:text-fg-0 sm:mt-0"
        >
          <Icon name={expanded ? "chevronDown" : "chevronRight"} size={13} />
        </button>
        <div className="flex min-w-0 flex-1 flex-col gap-1 sm:flex-row sm:items-center sm:gap-2">
          <div className="flex min-w-0 flex-1 items-center gap-2">
            <FixtureBadge isFixture={finding.is_fixture} compact />
            <Link
              to={findingHref(finding.id, from)}
              title={finding.title}
              className="min-w-0 flex-1 truncate font-medium text-fg-0 hover:underline"
            >
              {finding.title}
            </Link>
            {marker ? <Badge tone="focus">{marker === "new" ? "New since last refresh" : "Updated since last refresh"}</Badge> : null}
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            <SeverityBadge severity={finding.severity} />
            <ConfidenceBadge confidence={finding.confidence} />
            <FindingKindBadge finding={finding} />
            <FindingStatusBadge status={finding.status} />
            <span className="hidden whitespace-nowrap text-[12px] xl:inline">
              <CategoryLabel category={finding.category} />
            </span>
            {showRun ? (
              <span className="hidden max-w-[180px] truncate text-[12px] text-fg-2 lg:inline" title={finding.run_id}>
                {finding.run_label ?? finding.run_id}
              </span>
            ) : null}
          </div>
        </div>
      </div>
      {expanded ? (
        <div id={detailId} className="kw-fade-in border-t border-line bg-surface-0/40 px-3 py-3 sm:pl-10">
          <div className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-fg-2">
            <span className="xl:hidden">
              <CategoryLabel category={finding.category} />
            </span>
            <Mono className="text-[11px]">{finding.id}</Mono>
            <span>
              run{" "}
              <Link to={`/runs/${encodeURIComponent(finding.run_id)}`} className="text-fg-1 hover:underline">
                {finding.run_label ?? <Mono>{finding.run_id}</Mono>}
              </Link>
            </span>
          </div>
          {children}
          <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-line pt-3 text-[12px]">
            <Link to={findingHref(finding.id, from)} className="btn btn-sm btn-primary">
              Open investigation →
            </Link>
            <Link
              to={`/runs/${encodeURIComponent(finding.run_id)}?finding_id=${encodeURIComponent(finding.id)}`}
              className="btn btn-sm"
            >
              Linked events in run timeline
            </Link>
          </div>
        </div>
      ) : null}
    </li>
  );
}

/** Outcomes of linked events for one basis. Empty means "no linked event of this basis" - never "nothing happened". */
export function OutcomeLine({ label, outcomes, emptyText }: { label: string; outcomes: readonly Outcome[]; emptyText: string }) {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <span className="label w-full shrink-0 sm:w-40">{label}</span>
      {outcomes.length === 0 ? (
        <span className="text-[12px] text-unknown">{emptyText}</span>
      ) : (
        outcomes.map((o) => <OutcomeBadge key={o} outcome={o} />)
      )}
      {outcomes.some((o) => o === "denied" || o === "blocked") ? (
        <span className="text-[11px] text-fg-2">denied/blocked = an attempt that was prevented, not a success</span>
      ) : null}
    </div>
  );
}
