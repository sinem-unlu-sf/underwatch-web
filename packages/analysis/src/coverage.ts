import type { CoverageCategory, CoverageReport, EventSource } from "@kw/schema";

/**
 * Rule of absence: a rule may conclude "X did not happen / was not reported" only when the relevant coverage category
 * is "observed". "partial" lets a rule fire with reduced confidence; "unavailable" or a missing report means the
 * absence proves nothing.
 */
export type CoverageState = "observed" | "partial" | "unavailable" | "unknown";

export function categoryState(coverage: CoverageReport | null, cat: CoverageCategory): CoverageState {
  if (!coverage) return "unknown";
  const entry = coverage.categories.find((c) => c.category === cat);
  if (!entry) return "unknown";
  return entry.status;
}

export function sourceActive(coverage: CoverageReport | null, source: EventSource): boolean {
  return !!coverage?.sources.some((s) => s.source === source && s.active);
}

export function sourceErrors(coverage: CoverageReport | null): string[] {
  if (!coverage) return [];
  return coverage.sources.flatMap((s) => s.errors.map((e) => `${s.source}: ${e}`)).sort();
}

export function canAssertAbsence(state: CoverageState): boolean {
  return state === "observed";
}

/** Agent-side record availability: which reported channels were active. */
export function agentSideState(coverage: CoverageReport | null): { state: CoverageState; channels: EventSource[] } {
  const channels = (["claude_code_hooks", "claude_code_transcript", "claude_code_otel"] as const).filter((s) => sourceActive(coverage, s));
  const tc = categoryState(coverage, "tool_calls");
  const ar = categoryState(coverage, "agent_reported_actions");
  const rank: Record<CoverageState, number> = { observed: 3, partial: 2, unavailable: 1, unknown: 0 };
  const best = rank[tc] >= rank[ar] ? tc : ar;
  return { state: best, channels: [...channels] };
}

/** Human-readable statements explaining missing evidence (FR-5), deterministic. */
export function missingInfoFor(coverage: CoverageReport | null, cats: CoverageCategory[]): string[] {
  if (!coverage) return ["No coverage report for this run: observation coverage is unknown, so absence of evidence proves nothing."];
  const out: string[] = [];
  for (const c of [...new Set(cats)].sort()) {
    const st = categoryState(coverage, c);
    const note = coverage.categories.find((x) => x.category === c)?.note;
    if (st === "unavailable") out.push(`Coverage for ${c} is unavailable${note ? ` (${note})` : ""}; related actions may have occurred without being observed.`);
    else if (st === "partial") out.push(`Coverage for ${c} is partial${note ? ` (${note})` : ""}.`);
    else if (st === "unknown") out.push(`Coverage for ${c} is not reported.`);
  }
  for (const e of sourceErrors(coverage)) out.push(`Collector error: ${e}`);
  if (!coverage.final_state_complete) out.push("The run's final state was not completely captured.");
  return out;
}
