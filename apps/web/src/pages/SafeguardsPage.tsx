import {
  FixtureFilter,
  MECHANISMS,
  SAFEGUARD_TYPE_LABELS,
  SafeguardApplicationStatus,
  SafeguardApprovalStatus,
  SafeguardVerificationStatus,
  type SafeguardListItem,
  type SafeguardsQueryInput,
} from "@kw/schema";
import { Link } from "react-router";
import { useSafeguards } from "../api/queries";
import {
  ApplicationBadge,
  ApprovalBadge,
  FindingStatusBadge,
  FixtureBadge,
  TriState,
  VerificationBadge,
} from "../components/badges";
import { EmptyState, ErrorState, SkeletonBlock } from "../components/states";
import { Field, KeyValue, Mono, PageHeader, Panel, Time } from "../components/ui";
import { humanize } from "../lib/format";
import { pickEnum, useUrlFilters } from "../lib/searchParams";
import { outcomesForRun } from "@kw/schema";
import { OutcomePair } from "../components/safeguards/OutcomePair";
import { EnforcementPill, SafeguardWorkflow, workflowForListItem } from "../components/safeguards/Workflow";
import { CodeBlock } from "../components/ds/CodeBlock";
import { Icon } from "../components/ds/Icon";
import { SafeguardsNeedingActionSection } from "../components/overview/SafeguardsNeedingAction";

const FILTER_KEYS = ["approval_status", "application_status", "verification_status", "finding_id", "fixture"];

export function SafeguardsPage() {
  const { get, set, clear } = useUrlFilters();
  const findingId = get("finding_id");
  const query: SafeguardsQueryInput = {
    approval_status: pickEnum(get("approval_status"), SafeguardApprovalStatus.options),
    application_status: pickEnum(get("application_status"), SafeguardApplicationStatus.options),
    verification_status: pickEnum(get("verification_status"), SafeguardVerificationStatus.options),
    finding_id: findingId && /^fnd_[A-Za-z0-9_-]+$/.test(findingId) ? findingId : undefined,
    fixture: pickEnum(get("fixture"), FixtureFilter.options),
  };
  const filtered = FILTER_KEYS.some((k) => get(k) !== undefined);
  const q = useSafeguards(query);

  return (
    <div>
      <PageHeader
        title="Safeguards"
        subtitle="Proposed and applied protections derived from findings. Each shows the exact content that would be applied and how."
      />

      <SafeguardsNeedingActionSection />

      <WorkflowLegend />

      <div className="mb-5 border-b border-line pb-4">
        <div className="flex flex-wrap items-end gap-3">
          <Field label="Approval">
            <select className="field" value={query.approval_status ?? ""} onChange={(e) => set({ approval_status: e.target.value })}>
              <option value="">Any</option>
              {SafeguardApprovalStatus.options.map((s) => (
                <option key={s} value={s}>
                  {humanize(s)}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Application">
            <select className="field" value={query.application_status ?? ""} onChange={(e) => set({ application_status: e.target.value })}>
              <option value="">Any</option>
              {SafeguardApplicationStatus.options.map((s) => (
                <option key={s} value={s}>
                  {humanize(s)}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Verification">
            <select className="field" value={query.verification_status ?? ""} onChange={(e) => set({ verification_status: e.target.value })}>
              <option value="">Any</option>
              {SafeguardVerificationStatus.options.map((s) => (
                <option key={s} value={s}>
                  {humanize(s)}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Data">
            <select className="field" value={query.fixture ?? "include"} onChange={(e) => set({ fixture: e.target.value === "include" ? undefined : e.target.value })}>
              <option value="include">Fixture + live</option>
              <option value="exclude">Live only</option>
              <option value="only">Fixtures only</option>
            </select>
          </Field>
          {query.finding_id ? (
            <div className="flex flex-col gap-1">
              <span className="label">Finding</span>
              <span className="flex items-center gap-1">
                <Mono>{query.finding_id}</Mono>
                <button type="button" className="btn" onClick={() => set({ finding_id: undefined })}>
                  Remove
                </button>
              </span>
            </div>
          ) : null}
          {filtered ? (
            <button type="button" className="btn" onClick={() => clear(FILTER_KEYS)}>
              Clear filters
            </button>
          ) : null}
        </div>
        <p className="mt-2.5 text-[11.5px] text-fg-2">
          Open a safeguard to review its diff, approve, edit, reject, roll back or run verification. New safeguards are created from a finding
          (“Create safeguard” on the finding page).
        </p>
      </div>

      {q.isPending ? (
        <Panel>
          <SkeletonBlock lines={6} />
        </Panel>
      ) : q.isError ? (
        <Panel bodyClassName="">
          <ErrorState error={q.error} what="safeguards" />
        </Panel>
      ) : q.data.items.length === 0 ? (
        <Panel bodyClassName="">
          {filtered ? (
            <EmptyState title="No safeguards match these filters">
              <button type="button" className="btn mt-2" onClick={() => clear(FILTER_KEYS)}>
                Clear filters
              </button>
            </EmptyState>
          ) : (
            <EmptyState title="No safeguards recorded">
              A safeguard is proposed from a finding that has related evidence and is not dismissed: a CLAUDE.md instruction, a Claude Code permission rule, a hook/policy check, or a
              regression test. Use “Create safeguard” on a finding page.
            </EmptyState>
          )}
        </Panel>
      ) : (
        <div className="flex flex-col gap-6">
          <div className="text-[12px] text-fg-2" role="status">
            {q.data.total} safeguard{q.data.total === 1 ? "" : "s"}
          </div>
          {q.data.items.map((s) => (
            <SafeguardCard key={s.id} s={s} />
          ))}
        </div>
      )}
    </div>
  );
}

/** Legend for the five-step workflow and the mechanism table (from the shared MECHANISMS definition, not hard-coded claims). */
function WorkflowLegend() {
  return (
    <section aria-labelledby="sg-how-title" className="mb-6 grid gap-5 border-b border-line pb-5 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
      <div className="min-w-0">
        <h2 id="sg-how-title" className="text-[13px] font-semibold text-fg-0">
          How a safeguard moves
        </h2>
        <ol className="mt-2 flex flex-wrap items-center gap-x-1 gap-y-1.5 text-[12px] text-fg-1" aria-label="Safeguard workflow steps">
          {[
            ["Investigate", "a finding with related evidence"],
            ["Propose", "exact content + mechanism"],
            ["Review", "you approve, edit or reject"],
            ["Test", "controlled run in a container"],
            ["Verify", "result for the tested scenario"],
          ].map(([step, what], i) => (
            <li key={step} className="flex items-center gap-1">
              {i > 0 ? <Icon name="chevronRight" size={11} className="text-fg-disabled" /> : null}
              <span className="font-medium text-fg-0">
                <span className="mr-1 font-mono text-[10.5px] font-normal text-fg-2">{i + 1}</span>
                {step}
              </span>
              <span className="text-fg-2">({what})</span>
            </li>
          ))}
        </ol>
        <p className="mt-2 max-w-[80ch] text-[11.5px] text-fg-2">
          Each row shows its real position from recorded state. Approval is not verification; only a passing run counts as verified, and only for the
          scenario it tested. Inconclusive stays inconclusive.
        </p>
      </div>
      <div className="min-w-0">
        <h2 className="text-[13px] font-semibold text-fg-0">What each mechanism can enforce</h2>
        <ul className="mt-2 space-y-1 text-[12px]" aria-label="Safeguard mechanisms">
          {Object.values(MECHANISMS).map((m) => (
            <li key={m.type} className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
              <span className="min-w-[10rem] text-fg-1">{SAFEGUARD_TYPE_LABELS[m.type]}</span>
              <EnforcementPill m={m} />
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

function SafeguardCard({ s }: { s: SafeguardListItem }) {
  const v = s.last_verification;
  const m = MECHANISMS[s.type];
  return (
    <article className="border-b border-line pb-6 last:border-b-0" data-testid="safeguard-row" aria-labelledby={`sg-${s.id}-title`}>
      <header className="mb-3 space-y-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 id={`sg-${s.id}-title`} className="flex min-w-0 flex-wrap items-center gap-2">
            <FixtureBadge isFixture={s.is_fixture} />
            <Link to={`/safeguards/${encodeURIComponent(s.id)}`} className="text-[14px] font-semibold tracking-[-0.005em] text-fg-0 hover:text-focus hover:underline">
              {s.title}
            </Link>
          </h3>
          <span className="flex flex-wrap items-center gap-1.5">
            <ApprovalBadge status={s.approval_status} />
            <ApplicationBadge status={s.application_status} />
            <VerificationBadge status={s.verification_status} />
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
          <SafeguardWorkflow compact input={workflowForListItem(s)} label={`Workflow for ${s.title}`} />
          <EnforcementPill m={m} />
        </div>
      </header>
      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <div className="min-w-0 space-y-3">
          <KeyValue
            items={[
              ["Type", SAFEGUARD_TYPE_LABELS[s.type]],
              ["Mechanism", s.application_mechanism],
              ["Target", s.target_path ? <Mono>{s.target_path}</Mono> : <span className="text-fg-2">not specified</span>],
              [
                "Linked finding",
                <span className="flex flex-wrap items-center gap-1.5">
                  <Link to={`/findings/${encodeURIComponent(s.finding_id)}`} className="text-focus hover:underline">
                    {s.finding_title}
                  </Link>
                  <FindingStatusBadge status={s.finding_status} />
                </span>,
              ],
              [
                "Run",
                <Link to={`/runs/${encodeURIComponent(s.run_id)}`} className="text-fg-1 hover:underline">
                  <Mono>{s.run_id}</Mono>
                </Link>,
              ],
              ["Created", <Time iso={s.created_at} />],
              ["Approved", s.approved_at ? <><Time iso={s.approved_at} /> {s.approved_by ? <span className="text-fg-2">by {s.approved_by}</span> : null}</> : <span className="text-fg-2">not approved</span>],
              ["Applied", s.applied_at ? <Time iso={s.applied_at} /> : <span className="text-fg-2">not applied</span>],
            ]}
          />
          <div>
            <div className="label mb-1">Intended effect</div>
            <p className="text-fg-1">{s.intended_effect}</p>
          </div>
          <div>
            <div className="label mb-1">Impact on legitimate workflows</div>
            <p className="text-fg-1">{s.legitimate_workflow_impact}</p>
          </div>
        </div>
        <div className="min-w-0 space-y-4">
          <CodeBlock title="Exact content" code={s.content || "(empty)"} wrap maxHeight="18rem" />
          <div>
            <div className="label mb-1.5">Last verification</div>
            {v ? (
              <div className="space-y-2 rounded-md border border-line bg-surface-1 p-3">
                <div className="flex flex-wrap items-center gap-1.5">
                  <FixtureBadge isFixture={v.is_fixture} compact />
                  {v.result ? <VerificationBadge status={v.result} /> : <span className="text-fg-2">{v.status}</span>}
                  <Mono className="text-[11px] text-fg-2">{v.id}</Mono>
                </div>
                <div className="text-[12px] text-fg-1">
                  Scenario <Mono>{v.scenario_id}</Mono>: {v.scenario_description}
                </div>
                <OutcomePair outcomes={outcomesForRun(v)} compact />
                <div className="label">Legacy record fields (not a task outcome)</div>
                <div className="grid grid-cols-[minmax(0,max-content)_auto] items-center gap-x-3 gap-y-1 text-[12px]">
                  <span className="text-fg-2">Prohibited behavior attempted</span>
                  <TriState value={v.prohibited_behavior_attempted} />
                  <span className="text-fg-2">Prohibited behavior blocked</span>
                  <TriState value={v.prohibited_behavior_blocked} />
                  <span className="text-fg-2">Legitimate behavior worked</span>
                  <TriState value={v.legitimate_behavior_worked} />
                </div>
                {v.notes ? <p className="text-[12px] text-fg-1">{v.notes}</p> : null}
                <div className="text-[11px] text-fg-2">
                  <Time iso={v.started_at} /> → <Time iso={v.ended_at} />
                </div>
              </div>
            ) : (
              <div className="hatch rounded-md px-2 py-1.5 text-[12px] text-unknown">Not verified: no verification run recorded.</div>
            )}
          </div>
          <Link to={`/safeguards/${encodeURIComponent(s.id)}`} className="btn btn-sm">
            Open review
            <Icon name="chevronRight" size={12} />
          </Link>
        </div>
      </div>
    </article>
  );
}
