import { taskContextKey, type RunListItem, type TaskContext, type TasksQuery, type TasksResponse } from "@kw/schema";
import { stmt } from "../db/codec";
import type { Db } from "../db/connection";
import { queryRunList, RECENT_RUNS_ORDER } from "../repo/runs";
import { fixtureCondition, whereClause } from "../repo/sql";
import { dataMode } from "../status";
import { maxSeverity } from "./snapshot-findings";

/**
 * Task contexts: runs grouped by (repository_id, task_description). There is no task id in the data model, so the key
 * is derived (taskContextKey). Task detail reuses /api/runs/:id, /api/runs/:id/findings and /api/runs/:id/events.
 */

const later = (a: string, b: string): string => (Date.parse(b) > Date.parse(a) ? b : a);

export function listTasks(db: Db, q: TasksQuery): TasksResponse {
  const runs = queryRunList(db, {
    where: whereClause([fixtureCondition(q.fixture, "rl.is_fixture")]),
    orderBy: RECENT_RUNS_ORDER,
    limit: 1_000_000,
  }).items;

  const lastFindingUpdate = new Map<string, string>();
  for (const r of stmt(db, "SELECT run_id, updated_at FROM findings").all()) {
    const runId = r.run_id as string;
    const prev = lastFindingUpdate.get(runId);
    lastFindingUpdate.set(runId, prev ? later(prev, r.updated_at as string) : (r.updated_at as string));
  }

  const groups = new Map<string, RunListItem[]>();
  for (const run of runs) {
    const key = taskContextKey(run.repository_id, run.task_description);
    groups.set(key, [...(groups.get(key) ?? []), run]);
  }

  const needle = q.q?.toLowerCase();
  const matches = (task: RunListItem[]): boolean =>
    !needle ||
    task.some((r) => [r.task_description, r.repository_id, r.id, r.label].some((v) => v?.toLowerCase().includes(needle)));

  const items: TaskContext[] = [...groups.entries()]
    .filter(([, taskRuns]) => matches(taskRuns))
    .map(([key, taskRuns]) => {
      const first = taskRuns[0]!;
      let last = first.ended_at ?? first.started_at;
      for (const r of taskRuns) {
        last = later(last, r.ended_at ?? r.started_at);
        const f = lastFindingUpdate.get(r.id);
        if (f) last = later(last, f);
      }
      return {
        key,
        task_description: first.task_description,
        repository_id: first.repository_id,
        runs: taskRuns.map((r) => ({
          id: r.id,
          label: r.label,
          is_fixture: r.is_fixture,
          status: r.status,
          coverage_status: r.coverage_status,
          started_at: r.started_at,
          ended_at: r.ended_at,
          finding_count: r.finding_count,
          open_finding_count: r.open_finding_count,
          max_open_severity: r.max_open_severity,
        })),
        finding_count: taskRuns.reduce((n, r) => n + r.finding_count, 0),
        open_finding_count: taskRuns.reduce((n, r) => n + r.open_finding_count, 0),
        max_open_severity: maxSeverity(taskRuns.map((r) => r.max_open_severity)),
        last_activity_at: last,
        contains_fixture_data: taskRuns.some((r) => r.is_fixture),
      };
    })
    .sort((a, b) => Date.parse(b.last_activity_at) - Date.parse(a.last_activity_at) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));

  return { items, total: items.length, data_mode: dataMode(db) };
}
