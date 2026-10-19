import { AgentType, FixtureFilter, RunStatus, type RunListItem, type RunsQueryInput } from "@kw/schema";
import { useEffect, useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router";
import { useRuns } from "../api/queries";
import { CoverageBadge, FixtureBadge, RunStatusBadge, SeverityBadge } from "../components/badges";
import { Pager } from "../components/Pager";
import { StartSupervisedRun } from "../components/run/StartSupervisedRun";
import { RunsNeedingReviewSection } from "../components/overview/RunsNeedingReview";
import { DataTable, type Column } from "../components/ds/DataTable";
import { Icon } from "../components/ds/Icon";
import { Section } from "../components/ds/Section";
import { Cmd, EmptyState, ErrorState, SkeletonRows } from "../components/states";
import { Field, Mono, PageHeader, Time } from "../components/ui";
import { humanize, isoToLocalInput, localInputToIso, timezoneLabel, truncate } from "../lib/format";
import { pickEnum, useUrlFilters } from "../lib/searchParams";

const PAGE_SIZE = 50;
const FILTER_KEYS = ["q", "agent", "status", "from", "to", "has_findings", "fixture"];

export function RunsPage() {
  const { get, set, clear } = useUrlFilters();
  const navigate = useNavigate();
  const offset = Number(get("offset") ?? 0) || 0;

  const query: RunsQueryInput = {
    q: get("q"),
    agent: pickEnum(get("agent"), AgentType.options),
    status: pickEnum(get("status"), RunStatus.options),
    from: get("from"),
    to: get("to"),
    has_findings: pickEnum(get("has_findings"), ["true", "false"] as const),
    fixture: pickEnum(get("fixture"), FixtureFilter.options),
    limit: PAGE_SIZE,
    offset,
  };
  const filtered = FILTER_KEYS.some((k) => get(k) !== undefined);
  const runs = useRuns(query);

  const [search, setSearch] = useState(query.q ?? "");
  useEffect(() => setSearch(get("q") ?? ""), [get]);
  const onSearch = (e: FormEvent) => {
    e.preventDefault();
    set({ q: search.trim() || undefined });
  };

  return (
    <div>
      <PageHeader title="Agent Runs" subtitle="Supervised agent sessions, most recent first." />
      <RunsNeedingReviewSection />
      <StartSupervisedRun />

      <form
        onSubmit={onSearch}
        role="search"
        aria-label="Filter runs"
        className="mb-4 flex flex-wrap items-end gap-x-3 gap-y-3 border-b border-line pb-4"
      >
        <Field label="Search" htmlFor="runs-q" className="w-full sm:w-auto">
          <span className="flex gap-1">
            <span className="relative min-w-0 flex-1">
              <Icon name="search" size={13} className="pointer-events-none absolute top-1/2 left-2 -translate-y-1/2 text-fg-2" />
              <input
                id="runs-q"
                type="search"
                className="field w-full pl-7 sm:w-64"
                placeholder="id, label or task text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </span>
            <button type="submit" className="btn">
              Search
            </button>
          </span>
        </Field>
        <Field label="Agent">
          <select className="field" value={query.agent ?? ""} onChange={(e) => set({ agent: e.target.value })}>
            <option value="">Any</option>
            {AgentType.options.map((a) => (
              <option key={a} value={a}>
                {a === "claude_code" ? "Claude Code" : a}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Run status">
          <select className="field" value={query.status ?? ""} onChange={(e) => set({ status: e.target.value })}>
            <option value="">Any</option>
            {RunStatus.options.map((s) => (
              <option key={s} value={s}>
                {humanize(s)}
              </option>
            ))}
          </select>
        </Field>
        <Field label={`Started from (${timezoneLabel})`}>
          <input
            type="datetime-local"
            className="field"
            value={isoToLocalInput(query.from ?? null)}
            onChange={(e) => set({ from: localInputToIso(e.target.value) })}
          />
        </Field>
        <Field label="Started to">
          <input
            type="datetime-local"
            className="field"
            value={isoToLocalInput(query.to ?? null)}
            onChange={(e) => set({ to: localInputToIso(e.target.value) })}
          />
        </Field>
        <Field label="Findings">
          <select className="field" value={query.has_findings ?? ""} onChange={(e) => set({ has_findings: e.target.value })}>
            <option value="">Any</option>
            <option value="true">Has findings</option>
            <option value="false">No findings</option>
          </select>
        </Field>
        <Field label="Data">
          <select
            className="field"
            value={query.fixture ?? "include"}
            onChange={(e) =>
              set({
                fixture: e.target.value === "include" ? undefined : e.target.value,
              })
            }
          >
            <option value="include">Fixture + live</option>
            <option value="exclude">Live only</option>
            <option value="only">Fixtures only</option>
          </select>
        </Field>
        {filtered ? (
          <button type="button" className="btn btn-ghost" onClick={() => clear(FILTER_KEYS)}>
            <Icon name="x" size={13} /> Clear filters
          </button>
        ) : null}
      </form>

      <Section
        id="runs-list"
        title={runs.data ? `${runs.data.total} run${runs.data.total === 1 ? "" : "s"}` : "Runs"}
        description={
          filtered
            ? "Filtered by the controls above. Open a run to see its two-lane timeline and evidence."
            : "Open a run to see its two-lane timeline and evidence."
        }
      >
        <div className="overflow-clip rounded-md border border-line bg-surface-1">
          {runs.isPending ? (
            <SkeletonRows rows={8} cols={7} />
          ) : runs.isError ? (
            <ErrorState error={runs.error} what="runs" />
          ) : runs.data.items.length === 0 ? (
            filtered ? (
              <EmptyState title="No runs match these filters">
                <button type="button" className="btn mt-2" onClick={() => clear(FILTER_KEYS)}>
                  Clear filters
                </button>
              </EmptyState>
            ) : (
              <EmptyState title="No runs recorded">
                Use <span className="font-medium">Start supervised run</span> above to run Claude Code under observation, or load hand-authored
                fixture runs with <Cmd>pnpm seed:fixtures</Cmd> to explore the UI.
              </EmptyState>
            )
          ) : (
            <>
              <DataTable
                caption="Agent runs, most recent first"
                columns={RUN_COLUMNS}
                rows={runs.data.items}
                rowKey={(r) => r.id}
                onRowClick={(r) => navigate(`/runs/${encodeURIComponent(r.id)}`)}
              />
              <Pager
                offset={offset}
                limit={PAGE_SIZE}
                total={runs.data.total}
                shown={runs.data.items.length}
                onChange={(o) => set({ offset: String(o) })}
              />
            </>
          )}
        </div>
      </Section>
    </div>
  );
}

const agentLabel = (a: string) => (a === "claude_code" ? "Claude Code" : a);

const RUN_COLUMNS: Array<Column<RunListItem>> = [
  {
    key: "run",
    header: "Run",
    className: "max-w-[260px]",
    cell: (r) => (
      <>
        <div className="flex min-w-0 items-center gap-1.5">
          {r.is_fixture ? (
            <FixtureBadge isFixture />
          ) : (
            <span className="shrink-0 font-mono text-[10px] tracking-wider text-fg-2 uppercase" title="Captured from a live run (not fixture data)">
              live
            </span>
          )}
          <Link
            to={`/runs/${encodeURIComponent(r.id)}`}
            className="truncate font-medium text-fg-0 hover:underline"
            onClick={(e) => e.stopPropagation()}
          >
            {r.label ?? r.id}
          </Link>
        </div>
        {r.label ? (
          <Mono className="block truncate text-[11px] text-fg-2" title={r.id}>
            {r.id}
          </Mono>
        ) : null}
      </>
    ),
  },
  {
    key: "agent",
    header: "Agent",
    className: "whitespace-nowrap text-fg-1",
    cell: (r) => agentLabel(r.agent_type),
  },
  {
    key: "task",
    header: "Task",
    className: "max-w-[360px] min-w-[180px] text-fg-1",
    cell: (r) => <span title={r.task_description}>{truncate(r.task_description, 110)}</span>,
  },
  {
    key: "started",
    header: "Started",
    cell: (r) => <Time iso={r.started_at} />,
  },
  {
    key: "events",
    header: "Events",
    align: "right",
    className: "font-mono",
    cell: (r) => r.event_count,
  },
  {
    key: "findings",
    header: "Findings",
    align: "right",
    className: "whitespace-nowrap",
    cell: (r) => (
      <>
        <span className="font-mono">{r.finding_count}</span>
        {r.open_finding_count > 0 ? (
          <span className="ml-1.5 inline-flex items-center gap-1">
            <span className="text-[11px] text-warn">{r.open_finding_count} open</span>
            {r.max_open_severity ? <SeverityBadge severity={r.max_open_severity} /> : null}
          </span>
        ) : null}
      </>
    ),
  },
  {
    key: "coverage",
    header: "Coverage",
    cell: (r) => <CoverageBadge level={r.coverage_status} />,
  },
  {
    key: "status",
    header: "Status",
    cell: (r) => <RunStatusBadge status={r.status} />,
  },
];
