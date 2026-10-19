import type { Event, TaskContext } from "@kw/schema";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router";
import { useFindingContext, useTaskRun, useTaskRunFindings, useTasks } from "../../api/findingsViews";
import { queryKeys } from "../../api/queries";
import { humanize, truncate } from "../../lib/format";
import { Badge, BasisBadge, CoverageBadge, FixtureBadge, OutcomeBadge, RedactionBadge, RunStatusBadge } from "../badges";
import { Button } from "../ds/Button";
import { Icon } from "../ds/Icon";
import { Cmd, EmptyState, ErrorState, SkeletonBlock, SkeletonRows } from "../states";
import { Mono, Panel, Time } from "../ui";
import { FindingRow, useExpanded } from "./FindingRow";
import { LAST_TASK_STORAGE_KEY, PREVIOUS_TASK_STORAGE_KEY, readStorage, useFindingsMode, useFindingsReturnHref, writeStorage } from "./useFindingsMode";

const RUN_ID = /^run_[A-Za-z0-9_-]+$/;

/**
 * By Task (default): findings for one task context (runs sharing repository + task description), optionally narrowed
 * to one run. Unrelated tasks never appear in the findings pane; a task without findings gets an explicit empty state.
 */
export function TaskMode() {
  const tasks = useTasks();
  const { params, patch } = useFindingsMode();
  const [search, setSearch] = useState("");
  const qc = useQueryClient();
  const [refreshing, setRefreshing] = useState(false);
  const [refreshNote, setRefreshNote] = useState<{ ok: boolean; text: string } | null>(null);
  const taskKey = params.get("task");
  const runParam = params.get("run");
  const legacyRunId = params.get("run_id");

  // Legacy deep link (/findings?run_id=...): open the task that contains that run, narrowed to it.
  useEffect(() => {
    if (!legacyRunId || !tasks.data) return;
    const owner = tasks.data.items.find((t) => t.runs.some((r) => r.id === legacyRunId));
    patch({ run_id: undefined, mode: "task", task: owner?.key, run: owner ? legacyRunId : undefined }, { replace: true });
  }, [legacyRunId, tasks.data, patch]);

  const selected = tasks.data?.items.find((t) => t.key === taskKey) ?? null;

  useEffect(() => {
    if (selected) writeStorage(LAST_TASK_STORAGE_KEY, selected.key);
  }, [selected]);

  const selectTask = (key: string) => {
    if (taskKey && taskKey !== key) writeStorage(PREVIOUS_TASK_STORAGE_KEY, taskKey);
    patch({ mode: "task", task: key, run: undefined });
  };

  /**
   * Explicit refresh (no background fetching in this mode): re-reads the task list and, for the open task, its runs and
   * findings. On failure the previously loaded list stays on screen.
   */
  const refreshTasks = async () => {
    setRefreshing(true);
    setRefreshNote(null);
    try {
      const res = await tasks.refetch();
      if (res.isError || !res.data) {
        setRefreshNote({ ok: false, text: `Refresh failed${res.error instanceof Error ? `: ${res.error.message}` : ""}. Showing the previous list.` });
        return;
      }
      const open = res.data.items.find((t) => t.key === taskKey);
      await Promise.all(
        (open?.runs ?? []).flatMap((r) => [
          qc.invalidateQueries({ queryKey: queryKeys.run(r.id) }),
          qc.invalidateQueries({ queryKey: queryKeys.runFindings(r.id) }),
        ]),
      );
      setRefreshNote({ ok: true, text: "Updated" });
    } finally {
      setRefreshing(false);
    }
  };

  const previousKey = readStorage(PREVIOUS_TASK_STORAGE_KEY);
  const previous = previousKey && previousKey !== taskKey ? (tasks.data?.items.find((t) => t.key === previousKey) ?? null) : null;

  const visibleTasks = useMemo(() => {
    const items = tasks.data?.items ?? [];
    const q = search.trim().toLowerCase();
    if (!q) return items;
    return items.filter(
      (t) =>
        t.task_description.toLowerCase().includes(q) ||
        (t.repository_id ?? "").toLowerCase().includes(q) ||
        t.runs.some((r) => r.id.toLowerCase().includes(q) || (r.label ?? "").toLowerCase().includes(q)),
    );
  }, [tasks.data, search]);

  return (
    <div className="grid gap-3 lg:grid-cols-[minmax(240px,320px)_1fr]">
      <Panel
        title="Tasks"
        bodyClassName=""
        aside={
          <>
            {tasks.data ? <span className="font-mono text-[11.5px] tabular-nums">{tasks.data.total}</span> : null}
            <Button
              size="sm"
              variant="ghost"
              onClick={refreshTasks}
              disabled={tasks.isPending}
              loading={refreshing}
              loadingText="Refreshing…"
              title="Re-read tasks, runs and findings. This view never updates on its own."
            >
              Refresh
            </Button>
          </>
        }
      >
        {refreshNote ? (
          <p
            role={refreshNote.ok ? "status" : "alert"}
            className={`flex items-center gap-1.5 border-b border-line px-3 py-1.5 text-[12px] ${refreshNote.ok ? "text-fg-2" : "bg-risk/8 text-risk"}`}
          >
            <Icon name={refreshNote.ok ? "check" : "alert"} size={12} />
            <span>{refreshNote.text}</span>
          </p>
        ) : null}
        <div className="border-b border-line p-2">
          <input
            type="search"
            className="field w-full font-sans"
            placeholder="Search tasks, repos, runs"
            aria-label="Search tasks"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        {tasks.isPending ? (
          <SkeletonRows rows={5} cols={1} />
        ) : !tasks.data ? (
          <ErrorState error={tasks.error} what="tasks" />
        ) : tasks.data.items.length === 0 ? (
          <EmptyState title="No tasks recorded">
            Tasks come from ingested runs. Fixture runs can be loaded with <Cmd>pnpm seed:fixtures</Cmd>.
          </EmptyState>
        ) : visibleTasks.length === 0 ? (
          <EmptyState title="No tasks match this search" />
        ) : (
          <ul aria-label="Task list" className="max-h-[40vh] overflow-y-auto lg:max-h-[70vh]">
            {visibleTasks.map((t) => (
              <TaskListItem key={t.key} task={t} selected={t.key === taskKey} onSelect={() => selectTask(t.key)} />
            ))}
          </ul>
        )}
      </Panel>

      <div className="flex min-w-0 flex-col gap-3">
        {previous ? (
          <div className="text-[12px] text-fg-2">
            <button type="button" className="text-accent hover:underline" onClick={() => selectTask(previous.key)}>
              ← Return to previous task
            </button>{" "}
            <span title={previous.task_description}>{truncate(previous.task_description, 80)}</span>
          </div>
        ) : null}
        {!taskKey ? (
          <Panel>
            <EmptyState title="Select a task">Choose a task or run on the left to see only its findings, events, policy, and evidence.</EmptyState>
          </Panel>
        ) : tasks.isPending ? (
          <Panel>
            <SkeletonBlock lines={4} />
          </Panel>
        ) : !selected ? (
          !tasks.data ? null : (
            <Panel>
              <EmptyState title="Task not found">This task context no longer matches any recorded run. Pick another task on the left.</EmptyState>
            </Panel>
          )
        ) : (
          <TaskDetail
            task={selected}
            runId={runParam && RUN_ID.test(runParam) && selected.runs.some((r) => r.id === runParam) ? runParam : null}
            onRun={(id) => patch({ run: id ?? undefined })}
          />
        )}
      </div>
    </div>
  );
}

function TaskListItem({ task, selected, onSelect }: { task: TaskContext; selected: boolean; onSelect: () => void }) {
  return (
    <li className="border-b border-line last:border-b-0">
      <button
        type="button"
        aria-current={selected ? "true" : undefined}
        onClick={onSelect}
        className={`flex w-full flex-col gap-1 border-l-2 px-3 py-2 text-left transition-colors duration-120 ease-out ${
          selected ? "border-accent bg-surface-3" : "border-transparent hover:bg-surface-2"
        }`}
      >
        <span className="flex items-start gap-1.5">
          <FixtureBadge isFixture={task.contains_fixture_data} compact />
          <span className="line-clamp-2 text-fg-0">{task.task_description || "(no task description)"}</span>
        </span>
        <span className="flex flex-wrap gap-x-2 text-[11px] text-fg-2">
          <span className={`tabular-nums ${task.open_finding_count > 0 ? "text-warn" : ""}`}>
            {task.finding_count} finding{task.finding_count === 1 ? "" : "s"}
            {task.open_finding_count > 0 ? ` · ${task.open_finding_count} open` : ""}
          </span>
          <span>
            {task.runs.length} run{task.runs.length === 1 ? "" : "s"}
          </span>
          <Time iso={task.last_activity_at} className="text-[11px]" />
        </span>
      </button>
    </li>
  );
}

function TaskDetail({ task, runId, onRun }: { task: TaskContext; runId: string | null; onRun: (id: string | null) => void }) {
  const runs = runId ? task.runs.filter((r) => r.id === runId) : task.runs;
  const findingCount = runs.reduce((n, r) => n + r.finding_count, 0);

  return (
    <>
      <Panel bodyClassName="flex flex-col gap-2 p-3">
        <div className="flex flex-wrap items-center gap-2">
          <FixtureBadge isFixture={task.contains_fixture_data} />
          <h2 className="min-w-0 text-[14px] font-semibold break-words text-fg-0">{task.task_description || "(no task description)"}</h2>
        </div>
        <div className="flex flex-wrap items-center gap-3 text-[12px] text-fg-2">
          <span>
            repository {task.repository_id ? <Mono>{task.repository_id}</Mono> : <span className="text-unknown">not recorded</span>}
          </span>
          <label className="flex min-w-0 max-w-full items-center gap-1.5">
            <span>Run</span>
            <select className="field min-w-0 max-w-full" aria-label="Run" value={runId ?? ""} onChange={(e) => onRun(e.target.value || null)}>
              <option value="">All runs in this task ({task.runs.length})</option>
              {task.runs.map((r) => (
                <option key={r.id} value={r.id}>
                  {(r.label ?? r.id) + ` · ${r.status} · ${r.finding_count} finding${r.finding_count === 1 ? "" : "s"}`}
                </option>
              ))}
            </select>
          </label>
        </div>
      </Panel>

      {findingCount === 0 ? (
        <Panel>
          <EmptyState title={runId ? "No findings for this run" : "No findings for this task"}>
            No discrepancy was recorded for this context. Check the coverage below: missing telemetry is not proof that nothing happened.
          </EmptyState>
        </Panel>
      ) : null}

      {runs.map((r) => (
        <RunSection key={r.id} runId={r.id} showEmpty={findingCount > 0} />
      ))}
    </>
  );
}

/** One run's context (status, coverage, events by basis, policy) and its findings. */
function RunSection({ runId, showEmpty }: { runId: string; showEmpty: boolean }) {
  const run = useTaskRun(runId);
  const findings = useTaskRunFindings(runId);
  const expanded = useExpanded();
  const from = useFindingsReturnHref();

  const ctx = run.data;
  const title = ctx ? (ctx.run.label ?? ctx.run.id) : runId;

  return (
    <Panel
      bodyClassName=""
      title={
        <span className="flex items-center gap-2 normal-case">
          <Icon name="dot" size={12} className="text-fg-2" />
          <Link to={`/runs/${encodeURIComponent(runId)}`} className="min-w-0 truncate hover:underline" title={runId}>
            {title}
          </Link>
        </span>
      }
      aside={
        ctx ? (
          <>
            <FixtureBadge isFixture={ctx.run.is_fixture} compact />
            <RunStatusBadge status={ctx.run.status} />
            <CoverageBadge level={ctx.coverage?.level ?? "unknown"} />
          </>
        ) : null
      }
    >
      {run.isError ? (
        <ErrorState error={run.error} what="run context" />
      ) : ctx ? (
        <div className="flex flex-wrap gap-x-4 gap-y-1 border-b border-line px-3 py-2 text-[12px] text-fg-2">
          <span>
            Started <Time iso={ctx.run.started_at} />
          </span>
          <span>
            <span className="tabular-nums text-reported">{ctx.counts.events_by_basis.reported ?? 0} agent-reported</span> ·{" "}
            <span className="tabular-nums text-observed">{ctx.counts.events_by_basis.observed ?? 0} independently observed</span> ·{" "}
            <span className="tabular-nums">{ctx.counts.events_by_basis.derived ?? 0} derived events</span>
          </span>
          <span>
            Policy{" "}
            {ctx.policy ? (
              <span className="text-fg-1">
                {ctx.policy.name} v{ctx.policy.version}
              </span>
            ) : (
              <span className="text-unknown">none recorded</span>
            )}
          </span>
          {ctx.coverage === null ? <span className="text-unknown">No coverage report recorded</span> : null}
        </div>
      ) : (
        <SkeletonBlock lines={1} />
      )}

      {findings.isPending ? (
        <SkeletonRows rows={3} cols={4} />
      ) : findings.isError ? (
        <ErrorState error={findings.error} what="findings for this run" />
      ) : findings.data.items.length === 0 ? (
        showEmpty ? <p className="px-3 py-2 text-[12px] text-fg-2">No findings recorded for this run.</p> : null
      ) : (
        <ul>
          {findings.data.items.map((f) => (
            <FindingRow
              key={f.id}
              finding={f}
              from={from}
              showRun={false}
              expanded={expanded.isOpen(f.id)}
              onToggle={() => expanded.toggle(f.id)}
            >
              <TaskFindingDetail findingId={f.id} />
            </FindingRow>
          ))}
        </ul>
      )}
    </Panel>
  );
}

/** Expanded finding in task context: reported actions vs observed events, applicable policy, evidence (loaded on expand). */
function TaskFindingDetail({ findingId }: { findingId: string }) {
  const q = useFindingContext(findingId, true);
  if (q.isPending) return <SkeletonBlock lines={3} />;
  if (q.isError) return <ErrorState error={q.error} what="finding context" />;
  const { finding, related_events: events, evidence, policy, run } = q.data;
  const reported = events.filter((e) => e.basis === "reported");
  const observed = events.filter((e) => e.basis === "observed");
  const rule = policy?.rules.find((r) => r.id === finding.policy_rule_id) ?? null;

  return (
    <div className="flex flex-col gap-3 text-[12px]">
      {finding.description ? <p className="text-fg-1">{finding.description}</p> : null}
      <EventGroup title="Agent-reported actions" events={reported} runId={run.id} empty="No linked agent-reported action." />
      <EventGroup
        title="Independently observed events"
        events={observed}
        runId={run.id}
        empty="No linked observed event. Missing telemetry is not proof the action did not happen."
      />
      <div>
        <div className="label mb-1">Applicable policy</div>
        {policy ? (
          <div className="text-fg-1">
            {policy.name} v{policy.version}
            {rule ? (
              <>
                {" "}
                · rule <Mono>{rule.id}</Mono> <Badge tone="muted">{rule.effect}</Badge> {rule.action} <Mono>{rule.resource_pattern}</Mono>
                {rule.description ? <span className="text-fg-2"> · {rule.description}</span> : null}
              </>
            ) : finding.policy_rule_id ? (
              <>
                {" "}
                · rule <Mono>{finding.policy_rule_id}</Mono>
              </>
            ) : null}
          </div>
        ) : (
          <span className="text-unknown">No policy recorded for this finding or run.</span>
        )}
      </div>
      <div>
        <div className="label mb-1">Evidence ({evidence.length})</div>
        {evidence.length === 0 ? (
          <span className="text-unknown">No evidence record linked.</span>
        ) : (
          <ul className="flex flex-col gap-1">
            {evidence.map((ev) => (
              <li key={ev.id} className="flex flex-wrap items-center gap-2">
                <Badge tone="muted">{humanize(ev.source_type)}</Badge>
                <Mono className="min-w-0 text-fg-1" title={ev.source_reference}>
                  {ev.source_reference}
                </Mono>
                <RedactionBadge status={ev.redaction_status} />
                <Mono className="text-[11px] text-fg-2">{ev.id}</Mono>
              </li>
            ))}
          </ul>
        )}
      </div>
      {finding.missing_information.length > 0 ? (
        <div>
          <div className="label mb-1">Missing information</div>
          <ul className="list-disc pl-5 text-fg-1">
            {finding.missing_information.map((m) => (
              <li key={m}>{m}</li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

function EventGroup({ title, events, runId, empty }: { title: string; events: Event[]; runId: string; empty: string }) {
  return (
    <div>
      <div className="label mb-1">
        {title} ({events.length})
      </div>
      {events.length === 0 ? (
        <span className="text-unknown">{empty}</span>
      ) : (
        <ul className="flex flex-col gap-1">
          {events.map((e) => (
            <li key={e.id} className="flex flex-wrap items-center gap-2">
              <BasisBadge basis={e.basis} />
              <OutcomeBadge outcome={e.outcome} />
              <Link to={`/runs/${encodeURIComponent(runId)}?event=${encodeURIComponent(e.id)}`} className="min-w-0 text-fg-0 hover:underline">
                {e.summary}
              </Link>
              <Time iso={e.timestamp} className="text-fg-2" />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
