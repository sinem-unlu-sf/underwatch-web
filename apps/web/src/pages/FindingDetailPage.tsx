import { FINDING_STATUS_LABELS, type BundleEvidenceRef, type Event, type FindingDetailResponse } from "@kw/schema";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Link, useParams } from "react-router";
import { useFinding, useRunEvents } from "../api/queries";
import { AskAboutIssuePanel } from "../components/askwitness/AskAboutIssuePanel";
import { AskWitnessPanel } from "../components/askwitness/AskWitnessPanel";
import { EvidenceRefDrawer } from "../components/askwitness/EvidenceRef";
import { FindingSafeguardsPanel, type CreateSafeguardRequest } from "../components/safeguards/FindingSafeguardsPanel";
import {
  Badge,
  BasisBadge,
  CategoryLabel,
  FindingKindBadge,
  FindingStatusBadge,
  FixtureBadge,
  OutcomeBadge,
  RedactionBadge,
  SeverityBadge,
  SourceBadge,
} from "../components/badges";
import { FindingActions } from "../components/FindingActions";
import { BriefCard } from "../components/finding-brief/BriefCard";
import { ShortRead } from "../components/short-read/ShortRead";
import { KeyRelationshipsStrip } from "../components/finding-brief/KeyRelationshipsStrip";
import { RelevantRelationship } from "../components/finding-brief/RelevantRelationship";
import { SafeguardProgression } from "../components/finding-brief/SafeguardProgression";
import { useFindingView, type FindingView } from "../components/finding-brief/useFindingView";
import { ViewSwitch } from "../components/finding-brief/ViewSwitch";
import { AgentSaidKernelSaw, ReportedVsObservedPanel } from "../components/finding-brief/ReportedVsObserved";
import { EvidenceGraphPanel } from "../components/graph/EvidenceGraphPanel";
import { BackToFindings } from "../components/findings-modes/BackToFindings";
import { PolicyPanel } from "../components/PolicyPanel";
import { Section } from "../components/ds/Section";
import { Icon, type IconName } from "../components/ds/Icon";
import { EmptyState, ErrorState, PageSkeleton } from "../components/states";
import { KeyValue, Mono, PageHeader, Panel, Time } from "../components/ui";
import { humanize, truncate } from "../lib/format";

export function FindingDetailPage() {
  const { id = "" } = useParams();
  const q = useFinding(id);

  if (q.isPending) return <PageSkeleton />;
  if (q.isError) {
    return (
      <div>
        <PageHeader title="Finding" subtitle={<Mono>{id}</Mono>} />
        <ErrorState error={q.error} what="this finding" />
        <Link to="/findings" className="ml-3 text-focus hover:underline">
          Back to findings
        </Link>
      </div>
    );
  }
  return <FindingWorkspace data={q.data} />;
}

const timelineHref = (runId: string, eventId?: string) =>
  `/runs/${encodeURIComponent(runId)}${eventId ? `?event=${encodeURIComponent(eventId)}` : ""}`;

function FindingWorkspace({ data }: { data: FindingDetailResponse }) {
  const { finding: f, run } = data;
  const reported = data.related_events.filter((e) => e.basis === "reported");
  const observed = data.related_events.filter((e) => e.basis === "observed");
  const derived = data.related_events.filter((e) => e.basis === "derived");
  const [createReq, setCreateReq] = useState<CreateSafeguardRequest | null>(null);
  /**
   * Addendum C: two levels of detail over the SAME response. Summary is the default; Full renders every existing panel
   * unchanged. Switching is presentation only.
   */
  const [view, setViewRaw] = useFindingView();
  const [graphHighlight, setGraphHighlight] = useState<string[]>([]);
  const [scrollTarget, setScrollTarget] = useState<string | null>(null);
  const setView = (v: FindingView) => {
    // A consumed "Create safeguard" request must not re-fire when the safeguards panel remounts later.
    if (v !== "full") setCreateReq(null);
    setViewRaw(v);
  };
  const showFull = (target?: string) => {
    setView("full");
    if (target) setScrollTarget(target);
  };
  const openGraph = (highlight: string[]) => {
    setGraphHighlight(highlight);
    showFull("evidence-graph");
  };
  useEffect(() => {
    if (!scrollTarget || view !== "full") return;
    document.getElementById(scrollTarget)?.scrollIntoView?.({ block: "start" });
    setScrollTarget(null);
  }, [scrollTarget, view]);
  /** The safeguards panel lives in the full view; a request from the summary view opens it there (it scrolls itself). */
  const requestSafeguard = (investigationId: string | null) => {
    if (view !== "full") setViewRaw("full");
    setCreateReq((r) => ({ investigationId, n: (r?.n ?? 0) + 1 }));
  };
  const [openEvidence, setOpenEvidence] = useState<string | null>(null);
  /** Stored correlation records (run-wide) align reported and observed events in the comparison; never guessed client-side. */
  const runEvents = useRunEvents(run.id, { finding_id: f.id });
  const correlationStatus = runEvents.data ? "ready" : runEvents.isError ? "error" : "loading";
  const correlations = runEvents.data?.correlations ?? null;
  /** "Ask about this issue": user-opened only; closing hides the panel but keeps its conversation state. */
  const [askOpen, setAskOpen] = useState(false);
  const askButton = useRef<HTMLButtonElement>(null);
  const closeAsk = () => {
    setAskOpen(false);
    askButton.current?.focus();
  };
  const askFinding = { id: f.id, title: f.title, severity: f.severity, is_fixture: f.is_fixture };
  /** Mirrors the server's proposal gate (dismissed finding, or nothing to base a safeguard on). */
  const proposeBlocked =
    f.status === "dismissed"
      ? "This finding was dismissed. Reopen it before proposing a safeguard."
      : data.related_events.length === 0 && data.evidence.length === 0
        ? "No related events or evidence, so there is nothing to base a safeguard on."
        : null;
  /** Page-local index so evidence ids cited by safeguards open the same drawer as Ask Witness citations. */
  const pageIndex = useMemo(() => {
    const m = new Map<string, BundleEvidenceRef>();
    m.set(f.id, { evidence_id: f.id, kind: "finding", basis: "derived", source: null, timestamp: f.created_at, summary: f.title, run_id: run.id });
    for (const e of data.related_events)
      m.set(e.id, { evidence_id: e.id, kind: "event", basis: e.basis, source: e.source, timestamp: e.timestamp, summary: e.summary, run_id: run.id });
    for (const ev of data.evidence)
      m.set(ev.id, { evidence_id: ev.id, kind: "evidence", basis: null, source: ev.source_type, timestamp: ev.timestamp, summary: ev.source_reference, run_id: ev.run_id });
    return m;
  }, [data, f, run.id]);

  return (
    <div>
      <BackToFindings className="mb-2 inline-block" />
      <PageHeader
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <ViewSwitch view={view} onChange={setView} />
            <button
              ref={askButton}
              type="button"
              className="btn btn-sm"
              aria-expanded={askOpen}
              onClick={() => (askOpen ? closeAsk() : setAskOpen(true))}
            >
              Ask about this issue
            </button>
          </div>
        }
        title={
          <>
            <FixtureBadge isFixture={f.is_fixture} />
            <span>{f.title}</span>
          </>
        }
      >
        <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1.5">
          <span className="flex items-center gap-1.5">
            <span className="label">Status</span>
            <FindingStatusBadge status={f.status} />
          </span>
          <span className="flex items-center gap-1.5">
            <span className="label">Severity</span>
            <SeverityBadge severity={f.severity} />
          </span>
          <span className="flex items-center gap-1.5">
            <span className="label">Confidence</span>
            <Badge tone="muted">{f.confidence}</Badge>
          </span>
          <span className="flex items-center gap-1.5">
            <span className="label">Category</span>
            <CategoryLabel category={f.category} />
            <FindingKindBadge finding={f} />
          </span>
        </div>
        <div className="mt-1.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-[12px] text-fg-2">
          <Mono>{f.id}</Mono>
          <span>
            run{" "}
            <Link to={`/runs/${encodeURIComponent(run.id)}`} className="text-fg-1 hover:underline">
              {run.label ?? run.id}
            </Link>
          </span>
          <span>
            created <Time iso={f.created_at} />
          </span>
          <span>
            updated <Time iso={f.updated_at} />
          </span>
          {f.recurrence_of_finding_id ? (
            <span className="text-warn">
              possible recurrence of{" "}
              <Link to={`/findings/${encodeURIComponent(f.recurrence_of_finding_id)}`} className="font-mono hover:underline">
                {f.recurrence_of_finding_id}
              </Link>
            </span>
          ) : null}
        </div>
      </PageHeader>

      <div className="grid gap-3 xl:grid-cols-[minmax(0,1fr)_380px]">
        <div className="flex min-w-0 flex-col gap-3">
          {view === "summary" ? (
            <>
              {data.short_read ? (
                <>
                  {/* Short read (<= 150 words) is the Quick Read's main content; the longer brief stays one click away. */}
                  <ShortRead
                    shortRead={data.short_read}
                    onOpenEvidence={setOpenEvidence}
                    canOpenEvidence={(id) => pageIndex.has(id)}
                    onShowFull={() => showFull()}
                    onAsk={() => setAskOpen(true)}
                    askLabel="Ask about this issue"
                    afterFinding={
                      <div className="flex flex-col gap-2">
                        <AgentSaidKernelSaw
                          events={data.related_events}
                          correlations={correlations}
                          correlationStatus={correlationStatus}
                          onOpenEvidence={setOpenEvidence}
                          onSeeComparison={() => showFull("td-comparison")}
                        />
                        <RelevantRelationship findingId={f.id} onOpenGraph={openGraph} onOpenEvidence={setOpenEvidence} />
                      </div>
                    }
                  />
                  <details className="rounded-md border border-line px-3 py-2">
                    <summary className="cursor-pointer text-[12px] text-fg-1">Longer explanation: problem, why it matters, every fix step, evidence and uncertainty</summary>
                    <div className="mt-2">
                      <BriefCard
                        brief={data.brief}
                        safeguards={data.safeguards}
                        evidenceIndex={pageIndex}
                        onOpenEvidence={setOpenEvidence}
                        onShowFull={() => showFull()}
                      />
                    </div>
                  </details>
                </>
              ) : (
                <BriefCard
                  brief={data.brief}
                  safeguards={data.safeguards}
                  evidenceIndex={pageIndex}
                  onOpenEvidence={setOpenEvidence}
                  onShowFull={() => showFull()}
                  afterProblem={
                    <>
                      <AgentSaidKernelSaw
                        events={data.related_events}
                        correlations={correlations}
                        correlationStatus={correlationStatus}
                        onOpenEvidence={setOpenEvidence}
                        onSeeComparison={() => showFull("td-comparison")}
                      />
                      <RelevantRelationship findingId={f.id} onOpenGraph={openGraph} onOpenEvidence={setOpenEvidence} />
                    </>
                  }
                />
              )}
              <SafeguardProgression safeguards={data.safeguards} onOpenSafeguards={() => showFull("safeguards")} />
              <KeyRelationshipsStrip findingId={f.id} onOpenGraph={openGraph} onOpenEvidence={setOpenEvidence} />
              <div className="flex flex-wrap items-center gap-2 rounded-md border border-line px-3 py-2 text-[12px]">
                <span className="min-w-0 flex-1 text-fg-1">Questions about this finding? Ask Witness answers from this finding's records only.</span>
                <button type="button" className="btn btn-sm" aria-expanded={askOpen} onClick={() => setAskOpen(true)}>
                  Ask about this issue
                </button>
              </div>
            </>
          ) : (
            <>
              <TechnicalNav />

              <ReportedVsObservedPanel
                events={data.related_events}
                correlations={correlations}
                correlationStatus={correlationStatus}
                onOpenEvidence={setOpenEvidence}
              />

              <Category
                id="td-agent-report"
                kind="reported"
                title="Agent report"
                description="What the agent said it did. A claim, not proof: compare it with the observed evidence below."
              >
                <Panel title="Agent-reported events" aside={<span className="text-[11px]">{reported.length} of {data.related_events.length} related events</span>} bodyClassName="">
                  <Lane
                    title="Agent-reported"
                    tone="reported"
                    events={reported}
                    runId={run.id}
                    emptyText="No agent-reported event is linked. The agent did not report this action, or its report was not captured."
                  />
                </Panel>
              </Category>

              <Category
                id="td-observed"
                kind="observed"
                title="Observed evidence"
                description="Captured independently of the agent's account: system events, the evidence graph and the underlying records."
              >
                <Section
                  id="evidence-graph"
                  level={3}
                  title="Evidence graph"
                  description="How this finding's events, processes, resources and records connect, from Neo4j (or the relational fallback). Real records only."
                >
                  <EvidenceGraphPanel
                    findingId={f.id}
                    onOpenEvidence={setOpenEvidence}
                    highlightIds={graphHighlight}
                    explanation={<KeyRelationshipsStrip findingId={f.id} onOpenGraph={openGraph} onOpenEvidence={setOpenEvidence} />}
                  />
                </Section>

                <Panel title="Independently observed events" aside={<span className="text-[11px]">{observed.length} of {data.related_events.length} related events</span>} bodyClassName="">
                  <Lane
                    title="Independently observed"
                    tone="observed"
                    events={observed}
                    runId={run.id}
                    emptyText="No independently observed event is linked. The action was not observed, or no collector covered it."
                  />
                </Panel>

                <Panel title={`Evidence references (${data.evidence.length})`} bodyClassName="">
                  {data.evidence.length === 0 ? (
                    <EmptyState title="No evidence records referenced">A finding without evidence cannot be verified; treat it with caution.</EmptyState>
                  ) : (
                    <div className="overflow-x-auto">
                      <table className="data">
                        <thead>
                          <tr>
                            <th>Evidence</th>
                            <th>Type</th>
                            <th>Reference</th>
                            <th>Redaction</th>
                            <th>Excerpt</th>
                            <th>Timeline</th>
                          </tr>
                        </thead>
                        <tbody>
                          {data.evidence.map((ev) => {
                            const linked = data.related_events.filter((e) => e.evidence_id === ev.id);
                            return (
                              <tr key={ev.id}>
                                <td>
                                  <span className="flex items-center gap-1.5">
                                    <FixtureBadge isFixture={ev.is_fixture} compact />
                                    <Mono className="text-[11px]">{ev.id}</Mono>
                                  </span>
                                </td>
                                <td className="whitespace-nowrap text-fg-1">{humanize(ev.source_type)}</td>
                                <td>
                                  <Mono className="text-[11px]">{ev.source_reference}</Mono>
                                </td>
                                <td>
                                  <RedactionBadge status={ev.redaction_status} />
                                </td>
                                <td className="max-w-[280px]">
                                  {ev.excerpt !== null ? (
                                    <Mono className="text-[11px] text-fg-1">{truncate(ev.excerpt, 140)}</Mono>
                                  ) : (
                                    <span className="hatch inline-block rounded-[2px] px-1 text-[11px] text-unknown">no excerpt</span>
                                  )}
                                </td>
                                <td className="whitespace-nowrap">
                                  {linked.length > 0 ? (
                                    linked.map((e) => (
                                      <div key={e.id}>
                                        <Link to={timelineHref(run.id, e.id)} className="text-focus hover:underline">
                                          view {e.basis} event
                                        </Link>
                                      </div>
                                    ))
                                  ) : (
                                    <Link to={timelineHref(run.id)} className="text-fg-1 hover:underline" title="No related event points at this evidence record">
                                      open run timeline
                                    </Link>
                                  )}
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  )}
                </Panel>

                <Panel title="Missing information">
                  {f.missing_information.length === 0 ? (
                    <span className="text-fg-2">The finding records no evidence gaps.</span>
                  ) : (
                    <ul className="space-y-1">
                      {f.missing_information.map((m, i) => (
                        <li key={i} className="hatch rounded-[2px] px-2 py-1 text-fg-1">
                          {m}
                        </li>
                      ))}
                    </ul>
                  )}
                </Panel>
              </Category>

              <Category
                id="td-policy"
                kind="policy"
                title="Applicable policy"
                description="The policy version this run was checked against, with the rule this finding relates to highlighted."
              >
                <PolicyPanel policy={data.policy} highlightRuleId={f.policy_rule_id} title={f.policy_rule_id ? `Relevant policy · rule ${f.policy_rule_id}` : "Relevant policy"} />
              </Category>

              <Category
                id="td-interpretation"
                kind="derived"
                title="Interpretation"
                description="Underwatch analysis and AI answers. Derived or inferred from the records above; not raw evidence."
              >
                <Panel title="Why it was flagged">
                  <p className="whitespace-pre-wrap text-fg-0">{f.description || <span className="text-fg-2">No description recorded.</span>}</p>
                </Panel>

                {derived.length > 0 ? (
                  <Panel title="Derived by Underwatch (not raw evidence)" aside={<span className="text-[11px]">{derived.length} derived events</span>}>
                    <div className="space-y-1.5">
                      {derived.map((e) => (
                        <EventSummaryCard key={e.id} event={e} runId={run.id} />
                      ))}
                    </div>
                  </Panel>
                ) : null}

                <Panel title="Recommended next step">
                  <p className="whitespace-pre-wrap text-fg-0">{f.recommended_next_step || <span className="text-fg-2">None recorded.</span>}</p>
                </Panel>

                <AskWitnessPanel finding={askFinding} onCreateSafeguard={requestSafeguard} />
              </Category>

              <Section
                id="td-safeguards"
                title="Safeguards"
                description="Proposed and applied safeguards and their verification. Security outcome and task outcome are reported separately; verified means verified for the tested scenario."
              >
                <FindingSafeguardsPanel findingId={f.id} safeguards={data.safeguards} request={createReq} onOpenEvidence={setOpenEvidence} />
              </Section>
            </>
          )}
        </div>

        <div className="flex min-w-0 flex-col gap-3">
          <Panel title="Actions">
            <FindingActions findingId={f.id} runId={run.id} status={f.status} serverAllowed={data.allowed_transitions} />
            <div className="mt-3 border-t border-line pt-3">
              <button type="button" className="btn" onClick={() => requestSafeguard(null)} disabled={proposeBlocked !== null}>
                Create safeguard
              </button>
              <p className="mt-1 text-[11px] text-fg-2">
                {proposeBlocked ?? "Generates proposals for review. Nothing is applied without a diff and your approval."}
              </p>
            </div>
          </Panel>

          <Panel title="Status history" bodyClassName="">
            {data.status_history.length === 0 ? (
              <EmptyState title="No status history recorded" />
            ) : (
              <ol className="divide-y divide-line">
                {data.status_history.map((h) => (
                  <li key={h.id} className="px-3 py-2">
                    <div className="flex flex-wrap items-center gap-1.5 text-[12px]">
                      {h.from ? (
                        <>
                          <span className="text-fg-2">{FINDING_STATUS_LABELS[h.from]}</span>
                          <span className="text-fg-2">→</span>
                        </>
                      ) : (
                        <span className="text-fg-2">created as</span>
                      )}
                      <FindingStatusBadge status={h.to} />
                      <FixtureBadge isFixture={h.is_fixture} compact />
                    </div>
                    <div className="mt-0.5 text-[11px] text-fg-2">
                      <Time iso={h.at} /> · {h.actor_type} <span className="font-mono">{h.actor}</span>
                    </div>
                    {h.note ? <p className="mt-1 text-[12px] whitespace-pre-wrap text-fg-1">{h.note}</p> : null}
                  </li>
                ))}
              </ol>
            )}
          </Panel>


          <Panel title="Run">
            <KeyValue
              items={[
                ["Run", <Link to={`/runs/${encodeURIComponent(run.id)}`} className="hover:underline">{run.label ?? <Mono>{run.id}</Mono>}</Link>],
                ["Task", <span className="text-fg-1">{truncate(run.task_description, 180)}</span>],
                ["Started", <Time iso={run.started_at} />],
                ["Coverage", <Badge tone={run.coverage_status === "unknown" ? "unknown" : run.coverage_status === "complete" ? "neutral" : "warn"}>{run.coverage_status}</Badge>],
              ]}
            />
          </Panel>
        </div>
      </div>
      <AskAboutIssuePanel open={askOpen} onClose={closeAsk} finding={askFinding} onCreateSafeguard={requestSafeguard} />
      {openEvidence ? <EvidenceRefDrawer id={openEvidence} evidenceRef={pageIndex.get(openEvidence)} onClose={() => setOpenEvidence(null)} /> : null}
    </div>
  );
}

const TECH_SECTIONS: Array<{ id: string; label: string }> = [
  { id: "td-comparison", label: "Reported vs observed" },
  { id: "td-agent-report", label: "Agent report" },
  { id: "td-observed", label: "Observed evidence" },
  { id: "evidence-graph", label: "Evidence graph" },
  { id: "td-policy", label: "Applicable policy" },
  { id: "td-interpretation", label: "Interpretation" },
  { id: "td-safeguards", label: "Safeguards" },
];

/** In-page jump links for the Full Technical Details categories (plain anchors; no scroll hijacking). */
function TechnicalNav() {
  return (
    <nav aria-label="Technical details sections" className="flex flex-wrap gap-x-1 gap-y-1 border-b border-line pb-2 text-[12px]">
      {TECH_SECTIONS.map((t) => (
        <a
          key={t.id}
          href={`#${t.id}`}
          onClick={(e) => {
            const el = document.getElementById(t.id);
            if (!el) return;
            e.preventDefault();
            el.scrollIntoView?.({ block: "start" });
          }}
          className="rounded-[5px] px-2 py-0.5 text-fg-2 transition-colors duration-120 hover:bg-surface-2 hover:text-fg-0"
        >
          {t.label}
        </a>
      ))}
    </nav>
  );
}

type CategoryKind = "reported" | "observed" | "policy" | "derived";
const CATEGORY_ICON: Record<CategoryKind, IconName> = { reported: "quote", observed: "eye", policy: "shield", derived: "derive" };
const CATEGORY_TONE: Record<CategoryKind, string> = {
  reported: "border-reported/45 text-reported",
  observed: "border-observed/45 text-observed",
  policy: "border-accent/45 text-accent",
  derived: "border-line-strong text-fg-1",
};

/** One of the four Full Technical Details categories: labelled heading (symbol + text), one-line description, content. */
function Category({ id, kind, title, description, children }: { id: string; kind: CategoryKind; title: string; description: string; children: ReactNode }) {
  return (
    <Section
      id={id}
      title={
        <span className="flex items-center gap-2">
          <span className={`inline-flex h-5 w-5 items-center justify-center rounded-[5px] border ${CATEGORY_TONE[kind]}`} aria-hidden>
            <Icon name={CATEGORY_ICON[kind]} size={12} />
          </span>
          {title}
        </span>
      }
      description={description}
      className="pt-2"
    >
      <div className="flex flex-col gap-3">{children}</div>
    </Section>
  );
}

function Lane({
  title,
  tone,
  events,
  runId,
  emptyText,
  className = "",
}: {
  title: string;
  tone: "reported" | "observed";
  events: Event[];
  runId: string;
  emptyText: string;
  className?: string;
}) {
  return (
    <div className={`p-3 ${className}`}>
      <div className="label mb-1.5 flex items-center gap-1.5">
        <span className={`inline-block h-2 w-2 rounded-full ${tone === "reported" ? "bg-reported" : "bg-observed"}`} aria-hidden />
        {title}
      </div>
      {events.length === 0 ? (
        <div className="hatch rounded-[3px] px-2 py-1.5 text-[12px] text-unknown">{emptyText}</div>
      ) : (
        <div className="space-y-1.5">
          {events.map((e) => (
            <EventSummaryCard key={e.id} event={e} runId={runId} />
          ))}
        </div>
      )}
    </div>
  );
}

function EventSummaryCard({ event: e, runId }: { event: Event; runId: string }) {
  const accent = e.basis === "reported" ? "border-l-reported" : e.basis === "observed" ? "border-l-observed" : "border-l-line-strong border-dashed";
  return (
    <div className={`rounded-[3px] border border-l-[3px] border-line bg-surface-2 px-2 py-1.5 ${accent}`}>
      <div className="flex flex-wrap items-center gap-1">
        <BasisBadge basis={e.basis} />
        <Badge tone="muted" mono>
          {e.event_type}
        </Badge>
        <OutcomeBadge outcome={e.outcome} />
        <span className="ml-auto">
          <SourceBadge source={e.source} />
        </span>
      </div>
      <div className="mt-1 text-[12px]">{e.summary}</div>
      {e.target_resource ? <div className="font-mono text-[11px] break-all text-fg-1">{e.target_resource}</div> : null}
      {e.limitations.length > 0 ? (
        <ul className="mt-1 list-inside list-disc text-[11px] text-fg-2">
          {e.limitations.map((l, i) => (
            <li key={i}>{l}</li>
          ))}
        </ul>
      ) : null}
      <div className="mt-1 flex flex-wrap items-center gap-2 text-[11px] text-fg-2">
        <Time iso={e.timestamp} />
        {e.process_id !== null ? <span className="font-mono">pid {e.process_id}</span> : null}
        {e.attribution_confidence ? <Badge tone={e.attribution_confidence === "low" ? "unknown" : "muted"}>attribution: {e.attribution_confidence}</Badge> : null}
        <Link to={timelineHref(runId, e.id)} className="ml-auto text-focus hover:underline">
          view in timeline
        </Link>
      </div>
    </div>
  );
}
