import {
  EVENT_SOURCE_LABELS,
  EventBasis,
  EventSource,
  EventType,
  Outcome,
  type BundleEvidenceRef,
  type Event,
  type RunEventsResponse,
  type RunListItem,
} from "@kw/schema";
import { useQueries } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router";
import { api } from "../api/client";
import { queryKeys, useFindings, useRunFindings, useRuns } from "../api/queries";
import { EvidenceRefDrawer } from "../components/askwitness/EvidenceRef";
import { BasisBadge, FindingKindBadge, FixtureBadge, OutcomeBadge, SeverityBadge, SourceBadge } from "../components/badges";
import { DataTable, type Column, Notice, Section, SegmentedControl } from "../components/ds";
import { EvidenceGraphPanel } from "../components/graph/EvidenceGraphPanel";
import { EventInspector } from "../components/run/EventInspector";
import { EmptyState, ErrorState, SkeletonRows } from "../components/states";
import { Mono, PageHeader, Time } from "../components/ui";
import { humanize, truncate } from "../lib/format";
import { pickEnum, useUrlFilters } from "../lib/searchParams";

/**
 * Evidence Explorer: browse the REAL normalized events of recorded runs (GET /api/runs + GET /api/runs/:id/events), filter
 * them by evidence basis, source, outcome, event type and text, and open any event in the existing evidence inspector.
 * The Graph tab renders the existing per-finding evidence graph (Neo4j projection, or the labelled relational fallback).
 * Read-only; no polling: every request is made once when the user opens the page or changes the run.
 */

/** "All runs" loads the events of at most this many most-recent runs (one request per run, existing endpoint). */
export const ALL_RUNS_CAP = 20;
const ROW_STEP = 200;
const FILTER_KEYS = ["basis", "source", "outcome", "type", "q"];

type Tab = "events" | "graph";
type Row = Event & { run_label: string | null };

export function EvidenceExplorerPage() {
  const { get, set, clear } = useUrlFilters();
  const tab: Tab = get("tab") === "graph" ? "graph" : "events";
  const runParam = get("run") ?? "";

  const runs = useRuns({ limit: 100 });

  return (
    <div>
      <PageHeader
        title="Evidence Explorer"
        subtitle="Recorded events across runs, by how each was established: reported by the agent, independently observed, or derived by Underwatch."
      />
      <div className="mb-4 flex flex-wrap items-end gap-3">
        <SegmentedControl<Tab>
          label="Explorer view"
          value={tab}
          onChange={(v) => set({ tab: v === "events" ? undefined : v }, { replace: true })}
          options={[
            { value: "events", label: "Events" },
            { value: "graph", label: "Graph", description: "Evidence graph for one finding" },
          ]}
        />
        <label className="flex min-w-0 flex-col gap-1">
          <span className="label">Run</span>
          <select
            aria-label="Run"
            className="field max-w-[min(360px,100%)]"
            value={runParam}
            onChange={(e) => set({ run: e.target.value || undefined, event: undefined, finding: undefined })}
            disabled={runs.isPending || runs.isError}
          >
            <option value="">{`All runs (most recent ${ALL_RUNS_CAP})`}</option>
            {(runs.data?.items ?? []).map((r) => (
              <option key={r.id} value={r.id}>
                {runOptionLabel(r)}
              </option>
            ))}
          </select>
        </label>
      </div>

      {runs.isError ? (
        <ErrorState error={runs.error} what="runs" />
      ) : tab === "graph" ? (
        <GraphTab runId={runParam || null} selectedFinding={get("finding") ?? null} onFinding={(f) => set({ finding: f }, { replace: true })} />
      ) : (
        <EventsTab runs={runs.data?.items ?? null} runsTotal={runs.data?.total ?? 0} runId={runParam || null} get={get} set={set} clear={clear} />
      )}
    </div>
  );
}

function runOptionLabel(r: RunListItem): string {
  const name = r.label ? truncate(r.label, 48) : r.id;
  return `${r.is_fixture ? "[FIXTURE] " : ""}${name} · ${r.event_count} events`;
}

// ---------------------------------------------------------------------------------------------------------------
// Events tab
// ---------------------------------------------------------------------------------------------------------------

function EventsTab({
  runs,
  runsTotal,
  runId,
  get,
  set,
  clear,
}: {
  runs: RunListItem[] | null;
  runsTotal: number;
  runId: string | null;
  get: (k: string) => string | undefined;
  set: (patch: Record<string, string | undefined>, opts?: { replace?: boolean }) => void;
  clear: (keys: string[]) => void;
}) {
  const targetIds = useMemo(() => (runId ? [runId] : (runs ?? []).slice(0, ALL_RUNS_CAP).map((r) => r.id)), [runId, runs]);
  const labels = useMemo(() => new Map((runs ?? []).map((r) => [r.id, r.label])), [runs]);

  // Same cache entries as the run page's unfiltered timeline (queryKeys.runEvents(id, {})).
  const eventQueries = useQueries({
    queries: targetIds.map((id) => ({ queryKey: queryKeys.runEvents(id, {}), queryFn: () => api.runEvents(id, {}) })),
  });
  const byRun = new Map<string, RunEventsResponse>();
  targetIds.forEach((id, i) => {
    const d = eventQueries[i]?.data;
    if (d) byRun.set(id, d);
  });
  const failed = targetIds.map((id, i) => ({ id, q: eventQueries[i] })).filter((x) => x.q?.isError);
  const loading = runs === null || eventQueries.some((q) => q.isPending);
  const dataStamp = eventQueries.map((q) => q.dataUpdatedAt).join(",");

  const all: Row[] = useMemo(() => {
    const out: Row[] = [];
    for (const [rid, d] of byRun) for (const e of d.items) out.push({ ...e, run_label: labels.get(rid) ?? null });
    // Newest first across runs; ties keep the server's per-run order.
    return out.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dataStamp, labels, targetIds.join(",")]);

  const basis = pickEnum(get("basis"), EventBasis.options);
  const source = pickEnum(get("source"), EventSource.options);
  const outcome = pickEnum(get("outcome"), Outcome.options);
  const type = pickEnum(get("type"), EventType.options);
  const q = (get("q") ?? "").trim();
  const filtered = FILTER_KEYS.some((k) => get(k) !== undefined);

  const rows = useMemo(() => {
    const needle = q.toLowerCase();
    return all.filter(
      (e) =>
        (!basis || e.basis === basis) &&
        (!source || e.source === source) &&
        (!outcome || e.outcome === outcome) &&
        (!type || e.event_type === type) &&
        (!needle ||
          [e.summary, e.id, e.target_resource, e.tool_name, e.process_name, e.raw_summary, e.run_id]
            .filter((v): v is string => typeof v === "string")
            .some((v) => v.toLowerCase().includes(needle))),
    );
  }, [all, basis, source, outcome, type, q]);

  const [limit, setLimit] = useState(ROW_STEP);
  // A new filter or run starts again from the first page of rows.
  useEffect(() => setLimit(ROW_STEP), [basis, source, outcome, type, q, runId]);
  const visible = rows.slice(0, limit);

  const selectedId = get("event") ?? null;
  const selected = selectedId ? (all.find((e) => e.id === selectedId) ?? null) : null;
  const select = useCallback((id: string) => set({ event: id }, { replace: true }), [set]);
  const closeInspector = useCallback(() => set({ event: undefined }, { replace: true }), [set]);
  const selectedCorrelations = selected
    ? (byRun.get(selected.run_id)?.correlations ?? []).filter((c) => c.reported_event_id === selected.id || c.observed_event_id === selected.id)
    : [];

  const counts = useMemo(() => {
    const c: Record<EventBasis, number> = { reported: 0, observed: 0, derived: 0 };
    for (const e of rows) c[e.basis] += 1;
    return c;
  }, [rows]);

  const columns: Array<Column<Row>> = [
    { key: "time", header: "Time", cell: (e) => <Time iso={e.timestamp} />, width: "150px" },
    { key: "basis", header: "Basis", cell: (e) => <BasisBadge basis={e.basis} />, width: "110px" },
    { key: "source", header: "Source", cell: (e) => <SourceBadge source={e.source} /> },
    { key: "type", header: "Event type", cell: (e) => <Mono>{e.event_type}</Mono> },
    { key: "outcome", header: "Outcome", cell: (e) => <OutcomeBadge outcome={e.outcome} /> },
    {
      key: "summary",
      header: "Summary",
      cell: (e) => (
        <span className="flex min-w-0 items-center gap-1.5">
          <FixtureBadge isFixture={e.is_fixture} compact />
          <span className="truncate">{e.summary}</span>
        </span>
      ),
      truncate: true,
      fullValue: (e) => e.summary,
    },
    ...(runId
      ? []
      : [
          {
            key: "run",
            header: "Run",
            cell: (e: Row) => <Mono>{e.run_label ? truncate(e.run_label, 28) : e.run_id}</Mono>,
            truncate: true,
            fullValue: (e: Row) => `${e.run_label ?? ""} ${e.run_id}`.trim(),
          },
        ]),
  ];

  return (
    <div className={selectedId ? "lg:pr-[500px]" : undefined}>
      {!runId && runs && runsTotal > ALL_RUNS_CAP ? (
        <Notice tone="info" className="mb-3" title={`Showing events from the ${ALL_RUNS_CAP} most recent of ${runsTotal} runs`}>
          Pick a run above to explore an older run's events.
        </Notice>
      ) : null}
      {failed.length > 0 ? (
        <div className="mb-3 space-y-2">
          <Notice tone="caution" title={`Events for ${failed.length} run${failed.length === 1 ? "" : "s"} could not be loaded`}>
            Those runs are missing from the list below; the rest are shown. <span className="font-mono text-[11px]">{failed.map((f) => f.id).join(", ")}</span>
          </Notice>
          <ErrorState error={failed[0]!.q!.error} what="events" />
        </div>
      ) : null}

      {selected ? <SelectedEventContext event={selected} onShowGraph={(fid) => set({ tab: "graph", finding: fid, event: undefined })} /> : null}

      <Section
        title="Events"
        description={
          loading ? (
            "Loading recorded events…"
          ) : (
            <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <span>
                <span className="font-mono">{rows.length}</span> {filtered ? "matching" : "recorded"} event{rows.length === 1 ? "" : "s"}
              </span>
              {EventBasis.options.map((b) => (
                <span key={b} className="inline-flex items-center gap-1">
                  <BasisBadge basis={b} />
                  <span className="font-mono">{counts[b]}</span>
                </span>
              ))}
            </span>
          )
        }
      >
        <form className="mb-3 flex flex-wrap items-end gap-3" role="search" aria-label="Filter events" onSubmit={(e) => e.preventDefault()}>
          <label className="flex min-w-[180px] flex-1 flex-col gap-1">
            <span className="label">Search</span>
            <input
              className="field"
              type="search"
              value={get("q") ?? ""}
              onChange={(e) => set({ q: e.target.value || undefined }, { replace: true })}
              placeholder="Summary, resource, tool, process, id…"
            />
          </label>
          <Filter label="Basis" value={basis} onChange={(v) => set({ basis: v })} options={EventBasis.options.map((b) => [b, humanize(b)])} />
          <Filter label="Source" value={source} onChange={(v) => set({ source: v })} options={EventSource.options.map((s) => [s, EVENT_SOURCE_LABELS[s]])} />
          <Filter label="Outcome" value={outcome} onChange={(v) => set({ outcome: v })} options={Outcome.options.map((o) => [o, o])} />
          <Filter label="Event type" value={type} onChange={(v) => set({ type: v })} options={EventType.options.map((t) => [t, t])} />
          {filtered ? (
            <button type="button" className="btn" onClick={() => clear(FILTER_KEYS)}>
              Clear filters
            </button>
          ) : null}
        </form>

        {loading ? (
          <SkeletonRows rows={8} cols={6} />
        ) : targetIds.length === 0 ? (
          <EmptyState title="No runs recorded yet">Start a supervised run or import a session; its events will appear here.</EmptyState>
        ) : (
          <>
            <DataTable
              columns={columns}
              rows={visible}
              rowKey={(e) => e.id}
              onRowClick={(e) => select(e.id)}
              selectedKey={selectedId}
              caption="Recorded events; select a row to open it in the evidence inspector"
              maxHeight="65vh"
              empty={
                filtered ? (
                  <EmptyState title="No events match these filters" action={<button type="button" className="btn" onClick={() => clear(FILTER_KEYS)}>Clear filters</button>} />
                ) : (
                  <EmptyState title="No events recorded">
                    Nothing was captured for {runId ? "this run" : "these runs"}, or no collector was active. An empty list is not evidence that nothing happened; check
                    each run's coverage.
                  </EmptyState>
                )
              }
            />
            {rows.length > visible.length ? (
              <div className="mt-2 flex items-center gap-3 text-[12px] text-fg-2">
                <span>
                  Showing <span className="font-mono">{visible.length}</span> of <span className="font-mono">{rows.length}</span>
                </span>
                <button type="button" className="btn btn-sm" onClick={() => setLimit((l) => l + ROW_STEP)}>
                  Show {Math.min(ROW_STEP, rows.length - visible.length)} more
                </button>
              </div>
            ) : null}
          </>
        )}
      </Section>

      {selectedId ? (
        <EventInspector
          eventId={selectedId}
          event={selected}
          correlations={selectedCorrelations}
          onSelect={select}
          onClose={closeInspector}
          onClearFilters={() => clear(FILTER_KEYS)}
        />
      ) : null}
    </div>
  );
}

/** Links out of the selected event: its place in the run timeline, and findings that cite it. */
function SelectedEventContext({ event, onShowGraph }: { event: Event; onShowGraph: (findingId: string) => void }) {
  const findings = useRunFindings(event.run_id);
  const related = (findings.data?.items ?? []).filter((f) => f.related_event_ids.includes(event.id));
  return (
    <Section level={3} title="Selected event" className="mb-5" description={<Mono>{event.id}</Mono>}>
      <div className="flex flex-wrap items-center gap-2">
        <Link className="btn btn-sm" to={`/runs/${encodeURIComponent(event.run_id)}?event=${encodeURIComponent(event.id)}`}>
          Open in run timeline
        </Link>
        <span className="text-[12px] text-fg-2">
          Run <Mono>{event.run_id}</Mono>
        </span>
      </div>
      <div className="mt-3">
        <div className="label mb-1">Related findings</div>
        {findings.isPending ? (
          <SkeletonRows rows={1} cols={3} />
        ) : findings.isError ? (
          <ErrorState error={findings.error} what="findings for this run" />
        ) : related.length === 0 ? (
          <p className="text-[12px] text-fg-2">No finding in this run cites this event.</p>
        ) : (
          <ul className="space-y-1.5">
            {related.map((f) => (
              <li key={f.id} className="flex flex-wrap items-center gap-2 text-[12.5px]">
                <FixtureBadge isFixture={f.is_fixture} compact />
                <FindingKindBadge finding={f} />
                <SeverityBadge severity={f.severity} />
                <Link to={`/findings/${encodeURIComponent(f.id)}`} className="min-w-0 text-fg-0 hover:underline">
                  {f.title}
                </Link>
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => onShowGraph(f.id)}>
                  Show in graph
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Section>
  );
}

function Filter({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string | undefined;
  onChange: (v: string | undefined) => void;
  options: Array<[string, string]>;
}) {
  return (
    <label className="flex flex-col gap-1">
      <span className="label">{label}</span>
      <select className="field max-w-[240px]" value={value ?? ""} onChange={(e) => onChange(e.target.value || undefined)}>
        <option value="">All</option>
        {options.map(([v, l]) => (
          <option key={v} value={v}>
            {l}
          </option>
        ))}
      </select>
    </label>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// Graph tab
// ---------------------------------------------------------------------------------------------------------------

/** Graph "Evidence" nodes are evidence records: open them in the inspector, which loads the record itself. */
const evidenceNodeRef = (id: string): BundleEvidenceRef => ({ evidence_id: id, kind: "evidence", basis: null, source: null, timestamp: null, summary: "Evidence record from the graph", run_id: null });

function GraphTab({ runId, selectedFinding, onFinding }: { runId: string | null; selectedFinding: string | null; onFinding: (id: string | undefined) => void }) {
  const findings = useFindings(runId ? { limit: 200, run_id: runId } : { limit: 200 });
  const [openEvidence, setOpenEvidence] = useState<string | null>(null);
  const items = findings.data?.items ?? [];
  const current = selectedFinding ? items.find((f) => f.id === selectedFinding) : undefined;

  return (
    <Section
      title="Evidence graph"
      description="How one finding connects to agent actions, observed events, processes, resources and safeguards. Read from the Neo4j projection when it is available; otherwise the relational fallback, labelled as such."
    >
      <label className="mb-3 flex max-w-full flex-col gap-1">
        <span className="label">Finding</span>
        <select
          aria-label="Finding"
          className="field max-w-[min(560px,100%)]"
          value={selectedFinding ?? ""}
          onChange={(e) => onFinding(e.target.value || undefined)}
          disabled={findings.isPending || findings.isError}
        >
          <option value="">{findings.isPending ? "Loading findings…" : "Choose a finding…"}</option>
          {items.map((f) => (
            <option key={f.id} value={f.id}>
              {`${f.is_fixture ? "[FIXTURE] " : ""}${truncate(f.title, 70)} · ${f.severity}`}
            </option>
          ))}
        </select>
      </label>

      {findings.isError ? (
        <ErrorState error={findings.error} what="findings" />
      ) : !findings.isPending && items.length === 0 ? (
        <EmptyState title={runId ? "No findings for this run" : "No findings recorded"}>The graph is built per finding; there is nothing to draw yet.</EmptyState>
      ) : selectedFinding ? (
        <>
          {current ? (
            <div className="mb-2 flex flex-wrap items-center gap-2 text-[12.5px]">
              <FixtureBadge isFixture={current.is_fixture} compact />
              <FindingKindBadge finding={current} />
              <Link to={`/findings/${encodeURIComponent(current.id)}`} className="text-fg-0 hover:underline">
                Open finding
              </Link>
              <Link to={`/runs/${encodeURIComponent(current.run_id)}`} className="text-fg-1 hover:underline">
                Open run
              </Link>
            </div>
          ) : null}
          <EvidenceGraphPanel key={selectedFinding} findingId={selectedFinding} onOpenEvidence={setOpenEvidence} />
        </>
      ) : (
        <p className="text-[12.5px] text-fg-2">Choose a finding to draw its evidence graph.</p>
      )}

      {openEvidence ? <EvidenceRefDrawer id={openEvidence} evidenceRef={evidenceNodeRef(openEvidence)} onClose={() => setOpenEvidence(null)} /> : null}
    </Section>
  );
}
