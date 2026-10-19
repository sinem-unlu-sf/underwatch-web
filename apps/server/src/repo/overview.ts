import { OVERVIEW_ITEM_LIMIT, type ComponentStatus, type EntityTotals, type OverviewResponse } from "@kw/schema";
import { stmt } from "../db/codec";
import type { Db } from "../db/connection";
import { dataMode, observationComponents, overallStatus } from "../status";
import { queryFindingList } from "./findings";
import { RECENT_RUNS_ORDER, queryRunList } from "./runs";
import { querySafeguardList, recentCompletedVerifications } from "./safeguards";

const TOTAL_TABLES = {
  runs: "runs",
  events: "events",
  findings: "findings",
  safeguards: "safeguards",
  verification_runs: "verification_runs",
} as const satisfies Record<keyof EntityTotals, string>;

function entityTotals(db: Db): { fixture: EntityTotals; live: EntityTotals; all: EntityTotals } {
  const fixture = {} as EntityTotals;
  const live = {} as EntityTotals;
  const all = {} as EntityTotals;
  for (const [key, table] of Object.entries(TOTAL_TABLES) as [keyof EntityTotals, string][]) {
    const row = stmt(db, `SELECT COALESCE(SUM(is_fixture), 0) AS fixture, COUNT(*) AS total FROM ${table}`).get()!;
    fixture[key] = Number(row.fixture);
    all[key] = Number(row.total);
    live[key] = all[key] - fixture[key];
  }
  return { fixture, live, all };
}

/** Every number here is computed from persisted rows at request time. */
export function getOverview(db: Db, env: NodeJS.ProcessEnv, neo4j?: ComponentStatus, inference?: { id: string; model: string }): OverviewResponse {
  const limit = OVERVIEW_ITEM_LIMIT;
  const totals = entityTotals(db);
  const components = observationComponents(env, neo4j, inference, db);

  return {
    generated_at: new Date().toISOString(),
    data_mode: dataMode(db),
    totals: totals.all,
    breakdown: { fixture: totals.fixture, live: totals.live },
    recent_runs: toCounted(queryRunList(db, { orderBy: RECENT_RUNS_ORDER, limit })),
    runs_needing_review: toCounted(
      queryRunList(db, {
        where: "WHERE rl.open_finding_count > 0",
        orderBy: "ORDER BY rl.max_open_rank DESC, julianday(rl.started_at) DESC, rl.id",
        limit,
      }),
    ),
    new_findings: toCounted(
      queryFindingList(db, { where: "WHERE f.status = 'new'", orderBy: "ORDER BY julianday(f.created_at) DESC, f.id", limit }),
    ),
    confirmed_findings: toCounted(
      queryFindingList(db, { where: "WHERE f.status = 'confirmed'", orderBy: "ORDER BY julianday(f.updated_at) DESC, f.id", limit }),
    ),
    safeguards_awaiting_approval: toCounted(querySafeguardList(db, { where: "WHERE sg.approval_status = 'proposed'", limit })),
    recent_verification_results: toCounted(recentCompletedVerifications(db, limit)),
    observation_health: { overall: overallStatus(components.map((c) => c.status)), components },
  };
}

function toCounted<T>({ items, total }: { items: T[]; total: number }): { count: number; items: T[] } {
  return { count: total, items };
}
