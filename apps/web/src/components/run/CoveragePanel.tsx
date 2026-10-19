import { EVENT_SOURCE_LABELS, type CoverageLevel, type CoverageReport } from "@kw/schema";
import { Badge, CategoryCoverageBadge, CoverageBadge, FixtureBadge, TriState } from "../badges";
import { Mono, Panel, Time } from "../ui";
import { humanize } from "../../lib/format";

/** PRD FR-11. A missing report is shown as unknown coverage, never as complete. */
export function CoveragePanel({ coverage, runLevel }: { coverage: CoverageReport | null; runLevel: CoverageLevel }) {
  if (!coverage) {
    return (
      <Panel title="Observation coverage" aside={<CoverageBadge level={runLevel} />}>
        <div className="hatch rounded-sm p-3 text-unknown">
          No coverage report was recorded for this run. What was and was not observed is unknown; the absence of events here does not mean the agent
          did nothing.
        </div>
      </Panel>
    );
  }

  const activeSources = coverage.sources.filter((s) => s.active);
  const inactiveSources = coverage.sources.filter((s) => !s.active);

  return (
    <Panel
      title="Observation coverage"
      aside={
        <>
          <FixtureBadge isFixture={coverage.is_fixture} />
          <CoverageBadge level={coverage.level} />
          <span className="text-[11px]">
            generated <Time iso={coverage.generated_at} />
          </span>
        </>
      }
      bodyClassName=""
    >
      <div className="grid gap-x-8 gap-y-4 p-4 md:grid-cols-2">
        <div>
          <div className="label mb-1">Event categories</div>
          {coverage.categories.length === 0 ? (
            <div className="hatch rounded-sm px-2 py-1 text-unknown">No category coverage recorded</div>
          ) : (
            <ul className="space-y-1.5">
              {coverage.categories.map((c) => (
                <li key={c.category} className="flex flex-wrap items-baseline gap-2">
                  <span className="w-full shrink-0 text-fg-1 sm:w-44">{humanize(c.category)}</span>
                  <CategoryCoverageBadge status={c.status} />
                  {c.note ? <span className="text-[11px] text-fg-2">{c.note}</span> : null}
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <span className="label sm:w-56">Network outcomes observable</span>
            <TriState value={coverage.network_outcomes_observable} />
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <span className="label sm:w-56">Final repository state complete</span>
            <TriState value={coverage.final_state_complete} />
          </div>
          <div>
            <div className="label mb-1">Gaps / unsupported capabilities</div>
            {coverage.unsupported_capabilities.length === 0 ? (
              <span className="text-fg-2">None listed by the coverage report</span>
            ) : (
              <ul className="list-inside list-disc space-y-0.5 text-warn">
                {coverage.unsupported_capabilities.map((u, i) => (
                  <li key={i}>
                    <span className="text-fg-1">{u}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </div>

      <div className="relative overflow-x-auto border-t border-line">
        <table className="data">
          <caption className="sr-only">Observation sources and what each could capture</caption>
          <thead>
            <tr>
              <th>Source</th>
              <th>Active</th>
              <th>Categories</th>
              <th>Process attribution</th>
              <th>Errors</th>
            </tr>
          </thead>
          <tbody>
            {[...activeSources, ...inactiveSources].map((s) => (
              <tr key={s.source} className={s.active ? undefined : "text-fg-2"}>
                <td>
                  <Mono>{s.source}</Mono>
                  <div className="text-[11px] text-fg-2">{EVENT_SOURCE_LABELS[s.source]}</div>
                </td>
                <td>
                  {s.active ? (
                    <Badge tone="neutral" icon="check">
                      active
                    </Badge>
                  ) : (
                    <Badge tone="unknown">inactive</Badge>
                  )}
                </td>
                <td className="text-fg-1">{s.categories.length ? s.categories.map(humanize).join(", ") : "—"}</td>
                <td>{s.attribution_available ? <Badge tone="neutral">available</Badge> : <Badge tone="unknown">not available</Badge>}</td>
                <td>
                  {s.errors.length === 0 ? (
                    <span className="text-fg-2">none</span>
                  ) : (
                    <ul className="space-y-0.5 text-risk">
                      {s.errors.map((e, i) => (
                        <li key={i} className="font-mono text-[11px]">
                          {e}
                        </li>
                      ))}
                    </ul>
                  )}
                </td>
              </tr>
            ))}
            {coverage.sources.length === 0 ? (
              <tr>
                <td colSpan={5}>
                  <span className="hatch inline-block rounded-sm px-1 text-unknown">No sources listed in the coverage report</span>
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </Panel>
  );
}
