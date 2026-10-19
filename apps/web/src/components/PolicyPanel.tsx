import type { PolicyVersion } from "@kw/schema";
import { Badge, FixtureBadge } from "./badges";
import { EmptyState } from "./states";
import { KeyValue, Mono, Panel, Time } from "./ui";

export function PolicyPanel({ policy, highlightRuleId, title = "Policy" }: { policy: PolicyVersion | null; highlightRuleId?: string | null; title?: string }) {
  if (!policy) {
    return (
      <Panel title={title}>
        <EmptyState title="No policy version recorded">
          This record does not reference a policy snapshot, so there is no policy to evaluate it against.
        </EmptyState>
      </Panel>
    );
  }
  return (
    <Panel title={title} aside={<FixtureBadge isFixture={policy.is_fixture} />} bodyClassName="">
      <div className="p-3">
        <KeyValue
          items={[
            ["Name", <span className="font-medium">{policy.name}</span>],
            ["Version", <Mono>{policy.version}</Mono>],
            ["Version id", <Mono className="text-fg-1">{policy.id}</Mono>],
            ["Source", policy.source_reference ? <Mono>{policy.source_reference}</Mono> : <span className="text-fg-2">not recorded</span>],
            ["SHA-256", policy.content_sha256 ? <Mono className="text-fg-1">{policy.content_sha256}</Mono> : <span className="text-fg-2">not computed</span>],
            ["Created", <Time iso={policy.created_at} />],
          ]}
        />
        {policy.description ? <p className="mt-2 text-fg-1">{policy.description}</p> : null}
      </div>
      {policy.rules.length === 0 ? (
        <EmptyState title="Policy has no rules" />
      ) : (
        <div className="overflow-x-auto border-t border-line">
          <table className="data">
            <thead>
              <tr>
                <th>Rule</th>
                <th>Effect</th>
                <th>Action</th>
                <th>Resource</th>
                <th>Description</th>
              </tr>
            </thead>
            <tbody>
              {policy.rules.map((r) => {
                const hit = r.id === highlightRuleId;
                return (
                  <tr key={r.id} className={hit ? "bg-warn/10" : undefined} aria-current={hit ? "true" : undefined}>
                    <td className="whitespace-nowrap">
                      <Mono>{r.id}</Mono>
                      {hit ? (
                        <span className="ml-1.5">
                          <Badge tone="warn">rule in finding</Badge>
                        </span>
                      ) : null}
                    </td>
                    <td>
                      <Badge tone={r.effect === "deny" ? "risk" : r.effect === "ask" ? "warn" : "neutral"}>{r.effect}</Badge>
                    </td>
                    <td>
                      <Mono>{r.action}</Mono>
                    </td>
                    <td>
                      <Mono>{r.resource_pattern}</Mono>
                    </td>
                    <td className="text-fg-1">{r.description}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  );
}
