import type { ComponentStatus, SettingsStatusResponse } from "@kw/schema";
import type { ReactNode } from "react";
import { Link } from "react-router";
import { useSettingsStatus } from "../api/queries";
import { IntegrationStatusBadge } from "../components/badges";
import { Section } from "../components/ds/Section";
import { ErrorState, PageSkeleton } from "../components/states";
import { CredentialsPanel, WorkspacesPanel } from "../components/WorkspacesPanel";
import { KeyValue, Mono, PageHeader, Time } from "../components/ui";
import { ComponentTable } from "./OverviewPage";

const JUMP: Array<[string, string]> = [
  ["integrations", "Integrations"],
  ["collectors", "Event collection"],
  ["policy", "Policy"],
  ["workspaces", "Workspaces"],
  ["credentials", "Credentials"],
  ["retention", "Retention and redaction"],
  ["data-mode", "Data mode"],
];

export function SettingsPage() {
  const q = useSettingsStatus();
  return (
    <div>
      <PageHeader
        title="Settings"
        subtitle={
          <>
            Component status and authorized workspaces. Secrets are never sent to the browser: “configured via” names an environment variable or file, not its value.
            {q.data ? (
              <>
                {" "}
                Reported at <Time iso={q.data.generated_at} />.
              </>
            ) : null}
          </>
        }
      />
      <nav aria-label="Settings sections" className="mb-6 flex flex-wrap gap-1.5">
        {JUMP.filter(([id]) => q.data || id === "workspaces" || id === "credentials").map(([id, label]) => (
          <a key={id} href={`#${id}`} className="btn btn-sm btn-ghost">
            {label}
          </a>
        ))}
      </nav>
      <div className="flex flex-col gap-10">
        {q.isPending ? <PageSkeleton /> : q.isError ? <ErrorState error={q.error} what="settings status" /> : <StatusSections s={q.data} />}

        <Section
          id="workspaces"
          title="Workspaces"
          description="Where the backend may edit CLAUDE.md files, only after you approve a visible diff."
        >
          <WorkspacesPanel />
        </Section>

        <Section id="credentials" title="Credentials" description="Configured yes / no only. Values never reach the browser.">
          <CredentialsPanel aiStatus={q.data?.ai_inference.status ?? null} />
        </Section>

        {q.data ? <RetentionSections s={q.data} /> : null}
      </div>
    </div>
  );
}

/** One integration row: role, reported component, status (badge has a text label), detail, where it is configured. */
function IntegrationRow({ role, c, extra }: { role: string; c: ComponentStatus; extra?: ReactNode }) {
  return (
    <tr>
      <td className="whitespace-nowrap text-fg-0">{role}</td>
      <td className="text-fg-1">{c.name}</td>
      <td>
        <IntegrationStatusBadge status={c.status} />
      </td>
      <td className="min-w-[16rem] text-fg-1">
        {c.detail}
        {extra ? <div className="mt-0.5 text-fg-2">{extra}</div> : null}
      </td>
      <td>{c.configured_via ? <Mono className="text-fg-1">{c.configured_via}</Mono> : <span className="text-fg-2">—</span>}</td>
    </tr>
  );
}

function StatusSections({ s }: { s: SettingsStatusResponse }) {
  return (
    <>
      <Section
        id="integrations"
        title="Integrations and status"
        description="What this server reports for each component right now."
      >
        <div className="overflow-x-auto rounded-md border border-line">
          <table className="data">
            <thead>
              <tr>
                <th>Role</th>
                <th>Component</th>
                <th>Status</th>
                <th>Detail</th>
                <th>Configured via</th>
              </tr>
            </thead>
            <tbody>
              <IntegrationRow role="Agent adapter" c={s.adapter} />
              <IntegrationRow role="ai& Inference" c={s.ai_inference} />
              <IntegrationRow role="Neo4j evidence graph" c={s.neo4j} />
              <IntegrationRow
                role="Database"
                c={s.database}
                extra={
                  <>
                    Driver <Mono>{s.database.driver}</Mono>
                  </>
                }
              />
            </tbody>
          </table>
        </div>
      </Section>

      <Section
        id="collectors"
        title="Event collection (independent observers)"
        description="Observers that capture activity outside the agent's own account, such as the kernel tracer, file watcher and network proxy."
      >
        <div className="rounded-md border border-line">
          <ComponentTable components={s.collectors} />
        </div>
      </Section>

      <Section id="policy" title="Policy" description="The rules supervised runs are checked against.">
        <KeyValue
          items={[
            ["Component", s.policy.name],
            ["Status", <IntegrationStatusBadge status={s.policy.status} />],
            ["Detail", <span className="text-fg-1">{s.policy.detail}</span>],
            ["Configured via", s.policy.configured_via ? <Mono>{s.policy.configured_via}</Mono> : <span className="text-fg-2">—</span>],
            [
              "Active version",
              s.policy.active_policy_version_id ? (
                <span>
                  <Mono>{s.policy.active_policy_version_id}</Mono> <span className="text-fg-2">(built-in Underwatch supervised policy)</span>
                </span>
              ) : (
                <span className="text-fg-2">Built-in Underwatch supervised policy (no version stored yet; it is recorded on the first live supervised run)</span>
              ),
            ],
          ]}
        />
      </Section>
    </>
  );
}

function RetentionSections({ s }: { s: SettingsStatusResponse }) {
  return (
    <>
      <Section id="retention" title="Data retention and redaction" description="How long raw evidence is kept and whether sensitive values are redacted, as reported by the server.">
        <KeyValue
          items={[
            ["Retention", <span className="flex flex-wrap items-center gap-2"><IntegrationStatusBadge status={s.retention.status} /><span className="text-fg-1">{s.retention.detail}</span></span>],
            [
              "Raw evidence kept",
              s.retention.raw_evidence_retention_days !== null ? (
                <span>
                  <Mono>{s.retention.raw_evidence_retention_days} days</Mono>
                  {s.retention.status !== "connected" && s.retention.status !== "configured" ? <span className="text-fg-2"> (proposed; not enforced)</span> : null}
                </span>
              ) : (
                <span className="text-fg-2">no retention period set</span>
              ),
            ],
            ["Redaction", <span className="flex flex-wrap items-center gap-2"><IntegrationStatusBadge status={s.redaction.status} /><span className="text-fg-1">{s.redaction.detail}</span></span>],
          ]}
        />
      </Section>

      <Section id="data-mode" title="Data mode" description="Fixture records are hand-authored samples, never live captures.">
        <KeyValue
          items={[
            ["Fixture runs", <Mono>{s.data_mode.fixture_runs}</Mono>],
            ["Live runs", <Mono>{s.data_mode.live_runs}</Mono>],
            ["Contains fixture data", s.data_mode.contains_fixture_data ? "yes: fixture records are badged FIXTURE throughout the UI" : "no"],
          ]}
        />
        {s.data_mode.fixture_runs > 0 ? (
          <Link to="/runs?fixture=only" className="mt-3 inline-block text-focus hover:underline">
            View fixture runs
          </Link>
        ) : null}
      </Section>
    </>
  );
}
