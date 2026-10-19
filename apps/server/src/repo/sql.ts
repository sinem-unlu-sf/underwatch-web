import { OPEN_FINDING_STATUSES, SEVERITY_ORDER, type FixtureFilter, type Severity } from "@kw/schema";

/** SQL list literal of open statuses. Built from schema constants, never from input. */
export const OPEN_STATUSES_SQL = `(${OPEN_FINDING_STATUSES.map((s) => `'${s}'`).join(", ")})`;

const SEVERITY_BY_RANK = new Map(Object.entries(SEVERITY_ORDER).map(([s, rank]) => [rank, s as Severity]));

export function severityFromRank(rank: unknown): Severity | null {
  if (rank === null || rank === undefined) return null;
  const s = SEVERITY_BY_RANK.get(Number(rank));
  if (!s) throw new Error(`Unknown severity rank ${String(rank)}`);
  return s;
}

/** WHERE fragment for the include/exclude/only fixture filter, or null when no restriction applies. */
export function fixtureCondition(filter: FixtureFilter, column: string): string | null {
  if (filter === "exclude") return `${column} = 0`;
  if (filter === "only") return `${column} = 1`;
  return null;
}

export function likePattern(term: string): string {
  return `%${term.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

export function whereClause(conditions: (string | null | undefined | false)[]): string {
  const parts = conditions.filter((c): c is string => typeof c === "string" && c.length > 0);
  return parts.length ? `WHERE ${parts.join(" AND ")}` : "";
}

export function countOf(row: unknown): number {
  const n = (row as { n?: number | bigint } | undefined)?.n ?? 0;
  return Number(n);
}

/** Event order used everywhere events are listed (timeline order). */
export const EVENT_ORDER = "ORDER BY julianday(e.timestamp), e.source_sequence IS NULL, e.source_sequence, e.id";
