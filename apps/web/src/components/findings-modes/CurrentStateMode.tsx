import {
  FINDING_CATEGORY_LABELS,
  FINDING_STATUS_LABELS,
  FindingCategory,
  FindingStatus,
  OPEN_FINDING_STATUSES,
  Severity,
  diffSnapshotFindings,
  hasSnapshotChanges,
  type FindingsSnapshotResponse,
  type SnapshotChanges,
} from "@kw/schema";
import { useMemo, useState } from "react";
import { useCurrentSnapshot } from "../../api/findingsViews";
import { pickEnum } from "../../lib/searchParams";
import { FixtureBadge } from "../badges";
import { Button } from "../ds/Button";
import { Icon } from "../ds/Icon";
import { Notice } from "../ds/Notice";
import { EmptyState, ErrorState, SkeletonRows } from "../states";
import { Field, Panel, Time } from "../ui";
import { CompletenessNotice } from "./CompletenessNotice";
import { FindingRow, useExpanded } from "./FindingRow";
import { SnapshotFindingDetail } from "./SnapshotFindingDetail";
import { useFindingsMode, useFindingsReturnHref } from "./useFindingsMode";

type RefreshOutcome =
  | { kind: "idle" }
  | { kind: "unchanged" }
  | { kind: "changed"; changes: SnapshotChanges }
  | { kind: "failed"; error: unknown };

const FILTER_KEYS = ["status", "severity", "category", "fixture"] as const;

/**
 * Current State: the latest findings as of the user's last explicit refresh. Filters are applied in the browser so
 * changing one never fetches; nothing refetches on focus, reconnect, or a timer (see CALM_QUERY).
 */
export function CurrentStateMode() {
  const snapshot = useCurrentSnapshot();
  const { params, patch } = useFindingsMode();
  const from = useFindingsReturnHref();
  const expanded = useExpanded();
  const [outcome, setOutcome] = useState<RefreshOutcome>({ kind: "idle" });
  const [refreshing, setRefreshing] = useState(false);

  const statusParam = params.get("status") ?? undefined;
  const status = statusParam === "open" ? "open" : pickEnum(statusParam, FindingStatus.options);
  const severity = pickEnum(params.get("severity") ?? undefined, Severity.options);
  const category = pickEnum(params.get("category") ?? undefined, FindingCategory.options);
  const fixture = pickEnum(params.get("fixture") ?? undefined, ["include", "exclude", "only"] as const) ?? "include";
  const filtered = FILTER_KEYS.some((k) => params.get(k) !== null);

  const refresh = async () => {
    const previous: FindingsSnapshotResponse | undefined = snapshot.data;
    setRefreshing(true);
    try {
      const res = await snapshot.refetch();
      if (res.isError || !res.data) {
        setOutcome({ kind: "failed", error: res.error });
      } else if (!previous || previous.snapshot_id === res.data.snapshot_id) {
        setOutcome({ kind: "unchanged" });
      } else {
        const changes = diffSnapshotFindings(previous.findings, res.data.findings);
        setOutcome(hasSnapshotChanges(changes) ? { kind: "changed", changes } : { kind: "unchanged" });
      }
    } finally {
      setRefreshing(false);
    }
  };

  const markers = useMemo(() => {
    const m = new Map<string, "new" | "updated">();
    if (outcome.kind === "changed") {
      for (const id of outcome.changes.new_finding_ids) m.set(id, "new");
      for (const id of outcome.changes.updated_finding_ids) m.set(id, "updated");
    }
    return m;
  }, [outcome]);

  const data = snapshot.data;
  const visible = useMemo(() => {
    if (!data) return [];
    return data.findings.filter((f) => {
      if (status === "open" && !(OPEN_FINDING_STATUSES as readonly string[]).includes(f.status)) return false;
      if (status && status !== "open" && f.status !== status) return false;
      if (severity && f.severity !== severity) return false;
      if (category && f.category !== category) return false;
      if (fixture === "exclude" && f.is_fixture) return false;
      if (fixture === "only" && !f.is_fixture) return false;
      return true;
    });
  }, [data, status, severity, category, fixture]);

  if (snapshot.isPending && !data) {
    return (
      <Panel bodyClassName="" title="Current state">
        <SkeletonRows rows={6} cols={4} />
      </Panel>
    );
  }
  if (!data) {
    return (
      <Panel title="Current state" aside={<RefreshButton refreshing={refreshing} onClick={refresh} />}>
        <ErrorState error={snapshot.error} what="the findings snapshot" />
      </Panel>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-line bg-surface-1 px-3 py-2">
        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-[12px] text-fg-2">
          <Icon name="clock" size={13} />
          <span>
            Last refreshed <Time iso={data.generated_at} className="text-fg-1" />
          </span>
          <RefreshStatus outcome={outcome} />
          <span className="text-[11.5px] text-fg-2">· does not update on its own</span>
        </div>
        <RefreshButton refreshing={refreshing} onClick={refresh} />
      </div>

      {outcome.kind === "failed" ? (
        <Notice tone="danger" title="Refresh failed.">
          Showing the previous snapshot from <Time iso={data.generated_at} />.{" "}
          {outcome.error instanceof Error ? outcome.error.message : "The API did not answer."}
        </Notice>
      ) : null}

      <div role="group" aria-label="Filters" className="flex flex-wrap items-end gap-3 border-b border-line pb-3 [&>*]:min-w-[8.5rem] [&>*]:flex-1 sm:[&>*]:flex-none">
        <Field label="Status">
          <select className="field" value={status ?? ""} onChange={(e) => patch({ status: e.target.value }, { replace: true })}>
            <option value="">Any</option>
            <option value="open">Open (needs attention)</option>
            {FindingStatus.options.map((s) => (
              <option key={s} value={s}>
                {FINDING_STATUS_LABELS[s]}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Severity">
          <select className="field" value={severity ?? ""} onChange={(e) => patch({ severity: e.target.value }, { replace: true })}>
            <option value="">Any</option>
            {[...Severity.options].reverse().map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Category">
          <select className="field" value={category ?? ""} onChange={(e) => patch({ category: e.target.value }, { replace: true })}>
            <option value="">Any</option>
            {FindingCategory.options.map((c) => (
              <option key={c} value={c}>
                {FINDING_CATEGORY_LABELS[c]}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Data">
          <select
            className="field"
            value={fixture}
            onChange={(e) => patch({ fixture: e.target.value === "include" ? undefined : e.target.value }, { replace: true })}
          >
            <option value="include">Fixture + live</option>
            <option value="exclude">Live only</option>
            <option value="only">Fixtures only</option>
          </select>
        </Field>
        {filtered ? (
          <Button
            variant="ghost"
            icon="x"
            onClick={() => patch(Object.fromEntries(FILTER_KEYS.map((k) => [k, undefined])), { replace: true })}
          >
            Clear filters
          </Button>
        ) : null}
      </div>

      <Panel
        bodyClassName=""
        title={`${visible.length} of ${data.total} finding${data.total === 1 ? "" : "s"}`}
        aside={data.data_mode.contains_fixture_data ? <FixtureNote /> : null}
      >
        {data.truncated ? (
          <p className="hatch flex items-center gap-1.5 border-b border-line px-3 py-2 text-[12px] text-warn">
            <Icon name="alertCircle" size={13} />
            <span>
              Incomplete list: showing the first {data.findings.length} of {data.total} findings. Use By Task or Daily Digest to see the rest in
              context.
            </span>
          </p>
        ) : null}
        {data.findings.length === 0 ? (
          <EmptyState title="No findings recorded yet">This snapshot contains no findings. That does not mean no agent activity occurred.</EmptyState>
        ) : visible.length === 0 ? (
          <EmptyState title="No findings match these filters" />
        ) : (
          <ul>
            {visible.map((f) => (
              <FindingRow
                key={f.id}
                finding={f}
                from={from}
                marker={markers.get(f.id)}
                expanded={expanded.isOpen(f.id)}
                onToggle={() => expanded.toggle(f.id)}
              >
                <SnapshotFindingDetail finding={f} />
              </FindingRow>
            ))}
          </ul>
        )}
      </Panel>

      <CompletenessNotice completeness={data.completeness} scope="the runs behind these findings" />
    </div>
  );
}

function RefreshButton({ refreshing, onClick }: { refreshing: boolean; onClick: () => void }) {
  return (
    <Button size="sm" onClick={onClick} loading={refreshing} loadingText="Refreshing…" title="Fetch the latest findings. This view never refreshes on its own.">
      Refresh
    </Button>
  );
}

function RefreshStatus({ outcome }: { outcome: RefreshOutcome }) {
  if (outcome.kind === "unchanged") return <span role="status">· No changes since your last refresh</span>;
  if (outcome.kind === "changed") {
    const { new_finding_ids: n, updated_finding_ids: u, removed_finding_ids: r } = outcome.changes;
    const parts = [`${n.length} new`, `${u.length} updated`];
    if (r.length > 0) parts.push(`${r.length} removed`);
    return (
      <span role="status" className="text-fg-1">
        · {parts.join(", ")} since your last refresh
      </span>
    );
  }
  return null;
}

export function FixtureNote() {
  return (
    <span className="flex items-center gap-1.5 text-[12px]">
      <FixtureBadge isFixture /> includes fixture data
    </span>
  );
}
