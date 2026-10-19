import { DigestDate, isValidTimeZone, type DigestGroup, type DigestResponse, type SnapshotFinding } from "@kw/schema";
import { useMemo, useState, type ReactNode } from "react";
import { useDigest, useRefreshDigest } from "../../api/findingsViews";
import { SeverityBadge } from "../badges";
import { Button, IconButton } from "../ds/Button";
import { Icon } from "../ds/Icon";
import { Notice } from "../ds/Notice";
import { SegmentedControl } from "../ds/SegmentedControl";
import { EmptyState, ErrorState, MutationError, SkeletonRows } from "../states";
import { Panel, Time } from "../ui";
import { CompletenessNotice } from "./CompletenessNotice";
import { FixtureNote } from "./CurrentStateMode";
import { FindingRow, useExpanded } from "./FindingRow";
import { SnapshotFindingDetail } from "./SnapshotFindingDetail";
import { browserTimeZone, todayIn, useFindingsMode, useFindingsReturnHref } from "./useFindingsMode";

function shiftDate(date: string, days: number): string {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

/**
 * Daily Digest: one stored, versioned snapshot per (day, time zone). It changes only when the user presses Refresh
 * (which appends a version only if content changed) or opens another version.
 */
export function DigestMode() {
  const { params, patch } = useFindingsMode();
  const tzParam = params.get("tz");
  const tz = tzParam && isValidTimeZone(tzParam) ? tzParam : browserTimeZone();
  const today = todayIn(tz);
  const dateParam = params.get("date");
  const date = dateParam && DigestDate.safeParse(dateParam).success ? dateParam : today;
  const versionNum = Number(params.get("version"));
  const version = Number.isInteger(versionNum) && versionNum >= 1 ? versionNum : null;
  const groupBy = params.get("group") === "category" ? "category" : "task";

  const digest = useDigest(date, tz, version);
  const refresh = useRefreshDigest(date, tz);
  const [refreshNote, setRefreshNote] = useState<string | null>(null);

  const goTo = (values: Record<string, string | undefined>) => {
    setRefreshNote(null);
    refresh.reset();
    patch(values);
  };

  const onRefresh = () => {
    setRefreshNote(null);
    refresh.mutate(undefined, {
      onSuccess: (res) => {
        if (version !== null) patch({ version: undefined }, { replace: true });
        setRefreshNote(res.created ? `Created snapshot v${res.snapshot.version}.` : "No changes since this snapshot.");
      },
    });
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <IconButton variant="secondary" icon="chevronLeft" label="Previous day" onClick={() => goTo({ date: shiftDate(date, -1), version: undefined })} />
        <input
          type="date"
          aria-label="Digest date"
          className="field"
          value={date}
          max={today}
          onChange={(e) => {
            if (DigestDate.safeParse(e.target.value).success) goTo({ date: e.target.value, version: undefined });
          }}
        />
        <IconButton
          variant="secondary"
          icon="chevronRight"
          label="Next day"
          disabled={date >= today}
          onClick={() => goTo({ date: shiftDate(date, 1), version: undefined })}
        />
        {date !== today ? (
          <Button variant="ghost" onClick={() => goTo({ date: today, version: undefined })}>
            Today
          </Button>
        ) : null}
        <span className="font-mono text-[11.5px] text-fg-2" title="Day boundaries are computed in this IANA time zone">
          {tz}
        </span>
      </div>

      {digest.isPending ? (
        <Panel bodyClassName="" title="Daily digest">
          <SkeletonRows rows={5} cols={4} />
        </Panel>
      ) : digest.isError ? (
        <Panel title="Daily digest">
          <ErrorState error={digest.error} what="this day's digest" />
        </Panel>
      ) : (
        <DigestBody
          data={digest.data}
          groupBy={groupBy}
          refreshing={refresh.isPending}
          refreshNote={refreshNote}
          refreshError={refresh.error}
          onRefresh={onRefresh}
          onOpenVersion={(v) => goTo({ version: v === null ? undefined : String(v) })}
          onGroupBy={(g) => patch({ group: g === "task" ? undefined : g }, { replace: true })}
        />
      )}
    </div>
  );
}

function DigestBody({
  data,
  groupBy,
  refreshing,
  refreshNote,
  refreshError,
  onRefresh,
  onOpenVersion,
  onGroupBy,
}: {
  data: DigestResponse;
  groupBy: "task" | "category";
  refreshing: boolean;
  refreshNote: string | null;
  refreshError: unknown;
  onRefresh: () => void;
  onOpenVersion: (version: number | null) => void;
  onGroupBy: (g: "task" | "category") => void;
}) {
  const from = useFindingsReturnHref();
  const expanded = useExpanded();
  const [openGroups, setOpenGroups] = useState<ReadonlySet<string>>(() => new Set());
  const { snapshot, latest_version: latest } = data;
  const content = snapshot.content;
  const byId = useMemo(() => new Map(content.findings.map((f) => [f.id, f])), [content.findings]);
  const groups = groupBy === "task" ? content.groups_by_task : content.groups_by_category;
  const isLatest = snapshot.version === latest;
  const s = content.summary;

  const toggleGroup = (key: string) =>
    setOpenGroups((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-line bg-surface-1 px-3 py-2 text-[12px] text-fg-2">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <Icon name="clock" size={13} />
          <span className="text-fg-1">
            Snapshot v{snapshot.version} from <Time iso={snapshot.created_at} />
          </span>
          {latest > 1 ? (
            <select
              className="field"
              aria-label="Snapshot version"
              value={snapshot.version}
              onChange={(e) => onOpenVersion(Number(e.target.value) === latest ? null : Number(e.target.value))}
            >
              {Array.from({ length: latest }, (_, i) => latest - i).map((v) => (
                <option key={v} value={v}>
                  v{v}
                  {v === latest ? " (latest)" : ""}
                </option>
              ))}
            </select>
          ) : null}
          {refreshNote ? <span role="status">· {refreshNote}</span> : null}
          <span className="text-[11.5px]">· stored snapshot, does not update on its own</span>
        </div>
        <Button
          size="sm"
          onClick={onRefresh}
          loading={refreshing}
          loadingText="Refreshing…"
          title="Re-compute this day's digest. A new version is stored only if the content changed."
        >
          Refresh
        </Button>
      </div>

      {refreshError ? <MutationError error={refreshError} what="refresh the digest" /> : null}

      {!isLatest ? (
        <Notice
          tone="caution"
          title="Older snapshot"
          actions={
            <Button size="sm" onClick={() => onOpenVersion(null)}>
              Open newer snapshot
            </Button>
          }
        >
          You are viewing an older snapshot. A newer snapshot (v{latest}) exists.
        </Notice>
      ) : data.newer_available ? (
        <Notice
          tone="info"
          title="Possibly stale"
          actions={
            <Button size="sm" onClick={onRefresh} disabled={refreshing}>
              Refresh to open a newer snapshot
            </Button>
          }
        >
          <span>
            Newer findings available ({data.changes.new_finding_ids.length} new, {data.changes.updated_finding_ids.length} updated
            {data.changes.removed_finding_ids.length > 0 ? `, ${data.changes.removed_finding_ids.length} removed` : ""}). Checked{" "}
            <Time iso={data.checked_at} />.
          </span>
        </Notice>
      ) : null}

      <Panel
        title={`${content.scope.date} · ${content.scope.tz}`}
        aside={content.contains_fixture_data ? <FixtureNote /> : null}
        bodyClassName="flex flex-col gap-3 p-3"
      >
        <p aria-label="Digest summary" className="text-fg-1">
          {s.total_findings} finding{s.total_findings === 1 ? "" : "s"} across {s.total_runs} run{s.total_runs === 1 ? "" : "s"} ·{" "}
          <span className={s.needs_attention.length > 0 ? "text-warn" : ""}>{s.needs_attention.length} need attention</span> · {s.blocked.length}{" "}
          blocked · {s.uncertain.length} uncertain · {s.coverage_gaps.length} coverage caveat{s.coverage_gaps.length === 1 ? "" : "s"}
        </p>
        <CompletenessNotice completeness={content.completeness} scope="this day" />
      </Panel>

      <Panel
        bodyClassName=""
        title={`Grouped by ${groupBy}`}
        aside={
          <SegmentedControl
            size="sm"
            label="Group digest by"
            value={groupBy}
            onChange={onGroupBy}
            options={[
              { value: "task", label: "Task" },
              { value: "category", label: "Category" },
            ]}
          />
        }
      >
        {content.findings.length === 0 ? (
          <EmptyState title="No findings in this digest">
            {content.runs.length === 0
              ? "No runs started on this day in this time zone."
              : `${content.runs.length} run${content.runs.length === 1 ? "" : "s"} started on this day without findings. See the caveats above for coverage limits.`}
          </EmptyState>
        ) : (
          <ul>
            {groups.map((g) => (
              <GroupRow
                key={`${g.kind}:${g.key}`}
                group={g}
                open={openGroups.has(g.key)}
                onToggle={() => toggleGroup(g.key)}
                findings={g.finding_ids.map((id) => byId.get(id)).filter((f): f is SnapshotFinding => f !== undefined)}
                renderFinding={(f) => (
                  <FindingRow key={f.id} finding={f} from={from} expanded={expanded.isOpen(f.id)} onToggle={() => expanded.toggle(f.id)}>
                    <SnapshotFindingDetail finding={f} />
                  </FindingRow>
                )}
              />
            ))}
          </ul>
        )}
      </Panel>
    </>
  );
}

function GroupRow({
  group,
  open,
  onToggle,
  findings,
  renderFinding,
}: {
  group: DigestGroup;
  open: boolean;
  onToggle: () => void;
  findings: SnapshotFinding[];
  renderFinding: (f: SnapshotFinding) => ReactNode;
}) {
  return (
    <li className="border-b border-line last:border-b-0">
      <button
        type="button"
        aria-expanded={open}
        onClick={onToggle}
        className="flex w-full flex-wrap items-center gap-x-2 gap-y-1 px-3 py-2 text-left transition-colors duration-120 ease-out hover:bg-surface-2"
      >
        <Icon name={open ? "chevronDown" : "chevronRight"} size={13} className="text-fg-2" />
        <span className="min-w-0 flex-1 truncate font-medium text-fg-0">{group.label}</span>
        {group.max_severity ? <SeverityBadge severity={group.max_severity} /> : null}
        <span className="text-[12px] whitespace-nowrap text-fg-2 tabular-nums">
          {group.finding_ids.length} finding{group.finding_ids.length === 1 ? "" : "s"} · {group.open_count} open · {group.run_ids.length} run
          {group.run_ids.length === 1 ? "" : "s"}
        </span>
      </button>
      {open ? <ul className="border-t border-line bg-surface-0/30">{findings.map(renderFinding)}</ul> : null}
    </li>
  );
}
