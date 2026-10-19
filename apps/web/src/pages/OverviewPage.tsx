import {
  EVENT_SOURCE_BASIS,
  OPEN_FINDING_STATUSES,
  SEVERITY_ORDER,
  outcomesForRun,
  type ComponentStatus,
  type Confidence,
  type EntityTotals,
  type FindingListItem,
  type OverviewResponse,
} from "@kw/schema";
import { useRef, useState } from "react";
import { Link, useNavigate } from "react-router";
import { useFindings, useOverview } from "../api/queries";
import { AskAboutIssuePanel } from "../components/askwitness/AskAboutIssuePanel";
import { Badge, FixtureBadge, IntegrationStatusBadge, SeverityBadge, TriState, VerificationBadge } from "../components/badges";
import { Icon, Section } from "../components/ds";
import { ShortRead } from "../components/short-read/ShortRead";
import { Cmd, EmptyState, ErrorState, LoadingState, SkeletonBlock } from "../components/states";
import { Mono, PageHeader, Time } from "../components/ui";
import { truncate } from "../lib/format";

// Moved to the Safeguards page with its section; re-exported so existing imports keep working.
export { safeguardAction } from "../components/overview/SafeguardsNeedingAction";

/**
 * Overview: a short read, from persisted records only.
 *   1. Needs your attention: the top open findings, each as its deterministic short read, with Full details + Ask.
 *   2. One system-status line (links to Settings) and one latest-verification line (links to the safeguard).
 *   3. One muted line of record counts with the fixture / live split.
 * Runs needing review live on Agent Runs (#needs-review); safeguards needing action, confirmed findings and the
 * verification results table live on Safeguards (#needs-action); the observation health table lives on Settings.
 * Nothing refetches on its own: data loads once per visit.
 */

/** Findings list request used to rank open findings. The API orders by created_at desc; ranking happens here. */
const OPEN_FINDINGS_QUERY = { limit: 500 } as const;
export const ATTENTION_LIMIT = 3;
const CONFIDENCE_ORDER: Record<Confidence, number> = { low: 0, medium: 1, high: 2 };

export function OverviewPage() {
  const q = useOverview();

  return (
    <div>
      <PageHeader
        title="Overview"
        subtitle={q.data ? <>What needs attention now. Computed from persisted records at <Time iso={q.data.generated_at} />.</> : "What needs attention now. Computed from persisted records."}
      />
      {q.isPending ? <OverviewSkeleton /> : q.isError ? <ErrorState error={q.error} what="the overview" /> : <OverviewBody data={q.data} />}
    </div>
  );
}

function OverviewSkeleton() {
  return (
    <div className="flex flex-col gap-6" aria-busy="true">
      {Array.from({ length: 2 }, (_, i) => (
        <div key={i}>
          <div className="skeleton mb-3 h-4 w-40" />
          <div className="rounded-md border border-line p-3">
            <SkeletonBlock lines={3} />
          </div>
        </div>
      ))}
    </div>
  );
}

// --- ranking helpers (exported for tests) ------------------------------------------------------------------------

export function isOpenFinding(f: { status: string }): boolean {
  return (OPEN_FINDING_STATUSES as readonly string[]).includes(f.status);
}

/** Open findings ordered by severity desc, then confidence desc, then most recently created. */
export function rankOpenFindings<T extends Pick<FindingListItem, "status" | "severity" | "confidence" | "created_at">>(findings: T[]): T[] {
  return findings
    .filter(isOpenFinding)
    .sort(
      (a, b) =>
        SEVERITY_ORDER[b.severity] - SEVERITY_ORDER[a.severity] ||
        CONFIDENCE_ORDER[b.confidence] - CONFIDENCE_ORDER[a.confidence] ||
        b.created_at.localeCompare(a.created_at),
    );
}

// --- body --------------------------------------------------------------------------------------------------------

function OverviewBody({ data }: { data: OverviewResponse }) {
  const noRuns = data.totals.runs === 0;
  return (
    <div className="flex flex-col gap-8">
      {noRuns ? <FirstRunEmptyState /> : <AttentionSection data={data} />}
      <div className="flex flex-col gap-2 border-t border-line pt-4">
        <SystemStatusLine components={data.observation_health.components} />
        <LatestVerificationLine data={data} />
        <ElsewhereLine data={data} />
      </div>
      <RecordCounts data={data} />
    </div>
  );
}

// --- 1. attention + Ask popup --------------------------------------------------------------------------------------

function AttentionSection({ data }: { data: OverviewResponse }) {
  const navigate = useNavigate();
  const findings = useFindings(OPEN_FINDINGS_QUERY);
  const ranked = findings.data ? rankOpenFindings(findings.data.items) : [];
  const top = ranked.slice(0, ATTENTION_LIMIT);
  const listTruncated = findings.data ? findings.data.total > findings.data.items.length : false;

  /** The finding the Ask panel is about. Kept after close so reopening keeps the typed question and the answer. */
  const [askFor, setAskFor] = useState<FindingListItem | null>(null);
  const [askOpen, setAskOpen] = useState(false);
  const opener = useRef<HTMLElement | null>(null);
  const openAsk = (f: FindingListItem) => {
    opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setAskFor(f);
    setAskOpen(true);
  };
  const closeAsk = () => {
    setAskOpen(false);
    opener.current?.focus?.();
  };

  return (
    <Section
      id="attention"
      title="Needs your attention"
      description="Top open findings, highest severity first. Each is a short read; open Full details for the evidence."
      actions={
        <Link to="/findings?status=open" className="text-[12px] text-fg-1 hover:text-fg-0 hover:underline">
          All open findings{findings.data ? ` (${ranked.length}${listTruncated ? "+" : ""})` : ""}
        </Link>
      }
    >
      {findings.isPending ? (
        <div className="rounded-md border border-line">
          <LoadingState label="Loading open findings…" />
        </div>
      ) : findings.isError ? (
        <div className="rounded-md border border-line p-3">
          <ErrorState error={findings.error} what="open findings" />
          {data.new_findings.items.length > 0 ? (
            <p className="mt-3 text-[12px] text-fg-2">
              Newest findings instead (not ranked):{" "}
              {data.new_findings.items.map((f, i) => (
                <span key={f.id}>
                  {i > 0 ? " · " : null}
                  <Link to={`/findings/${encodeURIComponent(f.id)}`} className="text-fg-1 hover:underline">
                    {truncate(f.title, 60)}
                  </Link>
                </span>
              ))}
            </p>
          ) : null}
        </div>
      ) : top.length === 0 ? (
        <div className="rounded-md border border-line">
          <EmptyState title="No open findings">
            Every recorded finding has been confirmed, resolved or dismissed. New discrepancies appear here after a supervised run: start one from{" "}
            <Link to="/runs" className="text-fg-1 underline decoration-line-strong underline-offset-2">
              Agent Runs &gt; Start supervised run
            </Link>
            .{listTruncated ? " Only the most recent findings were checked." : null}
          </EmptyState>
        </div>
      ) : (
        <ul className="flex flex-col gap-5" aria-label="Open findings">
          {top.map((f) => (
            <li key={f.id} data-testid="attention-item">
              <div className="mb-1.5 flex flex-wrap items-center gap-2">
                <SeverityBadge severity={f.severity} />
                <Link to={`/findings/${encodeURIComponent(f.id)}`} className="min-w-0 flex-1 truncate font-medium text-fg-0 hover:underline" title={f.title}>
                  {f.title}
                </Link>
                <FixtureBadge isFixture={f.is_fixture} compact />
              </div>
              <ShortRead findingId={f.id} onAsk={() => openAsk(f)} askLabel="Ask" />
            </li>
          ))}
          {ranked.length > top.length ? (
            <li className="text-[12px] text-fg-2">
              {ranked.length - top.length} more open {ranked.length - top.length === 1 ? "finding" : "findings"}.{" "}
              <Link to="/findings?status=open" className="text-fg-1 hover:underline">
                View all
              </Link>
            </li>
          ) : null}
        </ul>
      )}

      {askFor ? (
        <AskAboutIssuePanel
          key={askFor.id}
          open={askOpen}
          onClose={closeAsk}
          finding={{ id: askFor.id, title: askFor.title, severity: askFor.severity, is_fixture: askFor.is_fixture }}
          // The safeguards panel lives on the finding page (full view): take the user there to create it.
          onCreateSafeguard={() => navigate(`/findings/${encodeURIComponent(askFor.id)}?view=full`)}
          header={<ShortRead findingId={askFor.id} />}
        />
      ) : null}
    </Section>
  );
}

// --- 2. one-line status + latest verification --------------------------------------------------------------------

const KEY_COMPONENTS = ["neo4j", "ai-and"];

function SystemStatusLine({ components }: { components: ComponentStatus[] }) {
  const collectors = components.filter((c) => c.id in EVENT_SOURCE_BASIS);
  const activeCollectors = collectors.filter((c) => c.status === "connected" || c.status === "configured");
  const key = KEY_COMPONENTS.map((id) => components.find((c) => c.id === id)).filter((c): c is ComponentStatus => !!c);
  const problems = components.filter((c) => c.status === "degraded" || c.status === "error");
  return (
    <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[12.5px] text-fg-2" data-testid="system-status">
      <span className="font-medium text-fg-1">System</span>
      {components.length === 0 ? (
        <span>No components reported</span>
      ) : (
        <>
          {collectors.length > 0 ? (
            <span title={collectors.map((c) => `${c.name}: ${c.status}`).join("\n")}>
              Collectors {activeCollectors.length}/{collectors.length} active
              {activeCollectors.length > 0 ? ` (${activeCollectors.map((c) => c.name).join(", ")})` : ""}
            </span>
          ) : null}
          {key.map((c) => (
            <span key={c.id} className="inline-flex items-center gap-1" title={c.detail}>
              {c.name} <IntegrationStatusBadge status={c.status} />
            </span>
          ))}
          {problems.length > 0 ? (
            <span className="text-warn" title={problems.map((p) => `${p.name}: ${p.detail}`).join("\n")}>
              {problems.length} degraded or error: {problems.map((p) => p.name).join(", ")}
            </span>
          ) : null}
        </>
      )}
      <Link to="/settings" className="inline-flex items-center gap-0.5 text-fg-1 hover:text-fg-0 hover:underline">
        Settings <Icon name="chevronRight" size={11} />
      </Link>
    </p>
  );
}

function LatestVerificationLine({ data }: { data: OverviewResponse }) {
  const v = [...data.recent_verification_results.items].sort((a, b) => (b.ended_at ?? "").localeCompare(a.ended_at ?? ""))[0];
  if (!v) {
    return (
      <p className="text-[12.5px] text-fg-2" data-testid="latest-verification">
        <span className="mr-3 font-medium text-fg-1">Latest verification</span>
        None completed yet. Verification runs start from an approved safeguard's page.
      </p>
    );
  }
  const o = outcomesForRun(v);
  const basis = (b: string | null) => (b ? ` (${b})` : "");
  return (
    <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[12.5px] text-fg-2" data-testid="latest-verification">
      <span className="mr-1 font-medium text-fg-1">Latest verification</span>
      <FixtureBadge isFixture={v.is_fixture} compact />
      <Link to={`/safeguards/${encodeURIComponent(v.safeguard_id)}`} className="text-fg-1 hover:text-fg-0 hover:underline" title={v.safeguard_title}>
        {truncate(v.safeguard_title, 60)}
      </Link>
      {v.result ? <VerificationBadge status={v.result} /> : <TriState value={null} />}
      <span title={o.security_outcome.reason}>
        security:{" "}
        <Badge tone={o.security_outcome.value === "blocked" ? "verified" : o.security_outcome.value === "allowed" ? "risk" : "unknown"}>
          {o.security_outcome.value}
          {basis(o.security_outcome.basis)}
        </Badge>
      </span>
      <span title={o.task_outcome.reason}>
        task:{" "}
        <Badge tone={o.task_outcome.value === "succeeded" ? "verified" : o.task_outcome.value === "failed" ? "risk" : "unknown"}>
          {o.task_outcome.value}
          {basis(o.task_outcome.basis)}
        </Badge>
      </span>
      <span>
        ended <Time iso={v.ended_at} />
      </span>
    </p>
  );
}

/** Where the panels that used to be on the Overview now live, with their real counts. */
function ElsewhereLine({ data }: { data: OverviewResponse }) {
  return (
    <p className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[12.5px] text-fg-2" data-testid="elsewhere">
      <Link to="/runs#needs-review" className="hover:text-fg-0 hover:underline">
        Runs needing review <span className="font-mono text-fg-1">{data.runs_needing_review.count}</span>
      </Link>
      <Link to="/safeguards#needs-action" className="hover:text-fg-0 hover:underline">
        Safeguards awaiting approval <span className="font-mono text-fg-1">{data.safeguards_awaiting_approval.count}</span>
      </Link>
      <Link to="/runs" className="hover:text-fg-0 hover:underline">
        Recent runs <span className="font-mono text-fg-1">{data.recent_runs.count}</span>
      </Link>
    </p>
  );
}

/** One small muted line: record counts with the fixture / live split. Not KPI cards. */
function RecordCounts({ data }: { data: OverviewResponse }) {
  const rows: Array<[string, keyof EntityTotals]> = [
    ["runs", "runs"],
    ["events", "events"],
    ["findings", "findings"],
    ["safeguards", "safeguards"],
    ["verification runs", "verification_runs"],
  ];
  const { contains_fixture_data } = data.data_mode;
  return (
    <p aria-label="Record counts" className="text-[11.5px] text-fg-2" data-testid="record-counts">
      {contains_fixture_data ? <FixtureBadge isFixture /> : null} <span className="mr-1 text-fg-1">Recorded</span>
      {rows.map(([label, key], i) => (
        <span key={key} className="whitespace-nowrap">
          {i > 0 ? <span className="mx-1 text-line-strong">·</span> : null}
          <span className="font-mono">{data.totals[key]}</span> {label} <span title="live · fixture">(live {data.breakdown.live[key]} · fixture {data.breakdown.fixture[key]})</span>
        </span>
      ))}
      {contains_fixture_data ? <span>. Fixture records are hand-authored samples and never count as live observations.</span> : null}
    </p>
  );
}

// --- empty state -------------------------------------------------------------------------------------------------

function FirstRunEmptyState() {
  return (
    <Section id="get-started" title="No runs recorded yet" description="Nothing has been observed, so there is nothing to review.">
      <div className="max-w-[80ch] space-y-3 rounded-md border border-line p-4 text-fg-1">
        <p>
          A supervised run is created when Underwatch starts an agent task and records both what the agent reports and what independent
          observers capture.
        </p>
        <ol className="list-inside list-decimal space-y-1.5">
          <li>
            <span className="text-fg-0">Live runs</span> require the Claude Code adapter and at least one independent observer. Start one from{" "}
            <Link to="/runs" className="text-fg-0 underline decoration-line-strong underline-offset-2 hover:decoration-fg-1">
              Agent Runs &gt; Start supervised run
            </Link>{" "}
            (Docker harness; sessions run outside Underwatch are not observed).
          </li>
          <li>
            <span className="text-fg-0">Fixture runs</span> (hand-authored samples, badged FIXTURE everywhere) can be loaded to explore the UI:{" "}
            <Cmd>pnpm seed:fixtures</Cmd>
          </li>
        </ol>
        <p className="text-[12px] text-fg-2">
          Check{" "}
          <Link to="/settings" className="text-fg-1 underline decoration-line-strong underline-offset-2 hover:decoration-fg-1">
            Settings
          </Link>{" "}
          to see which observers are connected before starting a live run.
        </p>
      </div>
    </Section>
  );
}

// --- used by Settings ----------------------------------------------------------------------------------------------

export function ComponentTable({ components }: { components: ComponentStatus[] }) {
  if (components.length === 0) return <EmptyState title="No components reported" />;
  return (
    <div className="overflow-x-auto">
      <table className="data">
        <thead>
          <tr>
            <th>Component</th>
            <th>Status</th>
            <th>Detail</th>
            <th>Configured via</th>
          </tr>
        </thead>
        <tbody>
          {components.map((c) => (
            <tr key={c.id}>
              <td className="whitespace-nowrap text-fg-0">{c.name}</td>
              <td>
                <IntegrationStatusBadge status={c.status} />
              </td>
              <td className="text-fg-1">{c.detail}</td>
              <td>{c.configured_via ? <Mono className="text-fg-1">{c.configured_via}</Mono> : <span className="text-fg-2">—</span>}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
