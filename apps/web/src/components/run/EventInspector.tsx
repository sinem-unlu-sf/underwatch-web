import { EVENT_SOURCE_LABELS, type Event, type EventCorrelation } from "@kw/schema";
import { useEffect, type ReactNode } from "react";
import { Link } from "react-router";
import { useEvidence } from "../../api/queries";
import { Badge, BasisBadge, CorrelationBadge, FixtureBadge, OutcomeBadge, RedactionBadge, Unavailable } from "../badges";
import { CodeBlock, CopyButton } from "../ds/CodeBlock";
import { Icon } from "../ds/Icon";
import { Kbd } from "../ds/Tooltip";
import { ErrorState, SkeletonBlock } from "../states";
import { Mono, Time } from "../ui";
import { humanize } from "../../lib/format";

interface InspectorProps {
  eventId: string;
  event: Event | null;
  correlations: EventCorrelation[];
  onSelect: (id: string) => void;
  onClose: () => void;
  onClearFilters: () => void;
}

/** Right-hand drawer: the selected event's normalized record plus the evidence record it points to. */
export function EventInspector({ eventId, event, correlations, onSelect, onClose, onClearFilters }: InspectorProps) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Leave Escape to a dialog layered above (e.g. the Ask Witness drawer) when it already handled the key.
      if (e.key === "Escape" && !e.defaultPrevented && !(e.target instanceof Element && e.target.closest('[role="dialog"]'))) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <aside
      aria-label="Evidence inspector"
      className="kw-fade-in fixed inset-y-0 right-0 z-30 flex w-[min(500px,100vw)] flex-col border-l border-line-strong bg-elevated shadow-[var(--shadow-overlay)]"
      style={{ paddingTop: "env(safe-area-inset-top, 0px)" }}
    >
      <div className="flex min-h-12 flex-wrap items-center gap-2 border-b border-line px-4 py-2">
        <Icon name="eye" size={14} className="text-fg-2" />
        <h2 className="text-[13px] font-semibold text-fg-0">Evidence inspector</h2>
        {event ? <BasisBadge basis={event.basis} /> : null}
        {event ? <FixtureBadge isFixture={event.is_fixture} /> : null}
        <button type="button" className="btn btn-ghost btn-sm ml-auto" onClick={onClose} aria-keyshortcuts="Escape">
          <Icon name="x" size={13} /> Close <Kbd>Esc</Kbd>
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-auto px-4 py-4">
        {event ? (
          <EventBody event={event} correlations={correlations} onSelect={onSelect} />
        ) : (
          <div className="space-y-2">
            <Mono>{eventId}</Mono>
            <p className="text-fg-1">
              This event is not in the current timeline. It may be hidden by the active filters, or it does not belong to this run.
            </p>
            <button type="button" className="btn" onClick={onClearFilters}>
              Clear timeline filters
            </button>
          </div>
        )}
      </div>
    </aside>
  );
}

function Row({ k, children }: { k: string; children: ReactNode }) {
  return (
    <div className="contents">
      <dt className="label pt-0.5">{k}</dt>
      <dd className="min-w-0">{children}</dd>
    </div>
  );
}

function EventBody({ event: e, correlations, onSelect }: { event: Event; correlations: EventCorrelation[]; onSelect: (id: string) => void }) {
  const unavailable = new Set(e.unavailable_fields);
  /** null means "does not apply" unless the source declared the field unavailable. */
  const val = (field: keyof Event, render: (v: NonNullable<Event[keyof Event]>) => ReactNode = (v) => <Mono>{String(v)}</Mono>) => {
    const v = e[field];
    if (v === null || v === undefined)
      return unavailable.has(field) ? <Unavailable label="not provided by source" /> : <span className="text-fg-2">n/a</span>;
    return render(v);
  };

  return (
    <div className="space-y-5">
      <section>
        <div className="text-[14px] leading-6 font-medium text-fg-0">{e.summary}</div>
        <div className="mt-1 flex items-start gap-1">
          <Mono className="min-w-0 pt-1 text-[11px] text-fg-2">{e.id}</Mono>
          <CopyButton value={e.id} label="Copy id" className="shrink-0" />
        </div>
      </section>

      <dl className="grid grid-cols-[max-content_minmax(0,1fr)] gap-x-4 gap-y-1.5">
        <Row k="Time">
          <Time iso={e.timestamp} />
        </Row>
        <Row k="Source">
          <Mono>{e.source}</Mono> <span className="text-[11px] text-fg-2">{EVENT_SOURCE_LABELS[e.source]}</span>
        </Row>
        <Row k="Native key">
          <Mono className="text-fg-1">{e.source_native_key}</Mono>
        </Row>
        <Row k="Sequence">{val("source_sequence")}</Row>
        <Row k="Type">
          <Mono>{e.event_type}</Mono>
        </Row>
        <Row k="Outcome">
          <OutcomeBadge outcome={e.outcome} />
        </Row>
        <Row k="Target">{val("target_resource")}</Row>
        <Row k="Process">{val("process_id")}</Row>
        <Row k="Parent process">{val("parent_process_id")}</Row>
        <Row k="Process name">{val("process_name")}</Row>
        <Row k="Tool">{val("tool_name")}</Row>
        <Row k="Tool use id">{val("tool_use_id")}</Row>
        <Row k="Attribution">
          {val("attribution_confidence", (v) => (
            <Badge tone={v === "low" ? "unknown" : "neutral"}>{String(v)}</Badge>
          ))}
        </Row>
        <Row k="Capture">
          <Badge tone={e.collection_status === "complete" ? "neutral" : e.collection_status === "error" ? "risk" : "warn"}>
            {e.collection_status}
          </Badge>
        </Row>
      </dl>

      {e.limitations.length > 0 ? (
        <section>
          <div className="label mb-1">What this event does not establish</div>
          <ul className="list-inside list-disc space-y-0.5 text-fg-1">
            {e.limitations.map((l, i) => (
              <li key={i}>{l}</li>
            ))}
          </ul>
        </section>
      ) : null}

      {e.unavailable_fields.length > 0 ? (
        <section>
          <div className="label mb-1">Fields the source could not provide</div>
          <div className="flex flex-wrap gap-1">
            {e.unavailable_fields.map((f) => (
              <span key={f} className="hatch rounded-[2px] px-1 font-mono text-[11px] text-unknown">
                {f}
              </span>
            ))}
          </div>
        </section>
      ) : null}

      {correlations.length > 0 ? (
        <section>
          <div className="label mb-1">Correlation</div>
          <ul className="space-y-1.5">
            {correlations.map((c) => {
              const other = e.id === c.reported_event_id ? c.observed_event_id : c.reported_event_id;
              return (
                <li key={c.id} className="rounded-sm border border-dashed border-line-strong p-2">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <Badge tone="neutral">derived</Badge>
                    <CorrelationBadge match={c.match} />
                    <span className="text-[11px] text-fg-2">confidence {c.confidence}</span>
                  </div>
                  {other ? (
                    <button type="button" className="mt-1 font-mono text-[11px] break-all text-focus hover:underline" onClick={() => onSelect(other)}>
                      → {e.id === c.reported_event_id ? "observed" : "reported"} {other}
                    </button>
                  ) : null}
                  {c.note ? <p className="mt-1 text-[12px] text-fg-1">{c.note}</p> : null}
                </li>
              );
            })}
          </ul>
        </section>
      ) : null}

      {e.raw_summary ? (
        <section>
          <div className="label mb-1">Raw record summary (redacted)</div>
          <CodeBlock code={e.raw_summary} wrap maxHeight="16rem" />
        </section>
      ) : null}

      <section>
        <div className="label mb-1">Evidence record</div>
        {e.evidence_id ? (
          <EvidenceBlock evidenceId={e.evidence_id} currentEventId={e.id} onSelect={onSelect} />
        ) : (
          <div className="hatch rounded-sm px-2 py-1.5 text-unknown">No evidence record is attached to this event.</div>
        )}
      </section>
    </div>
  );
}

function EvidenceBlock({ evidenceId, currentEventId, onSelect }: { evidenceId: string; currentEventId: string; onSelect: (id: string) => void }) {
  const q = useEvidence(evidenceId);
  if (q.isPending) return <SkeletonBlock lines={5} />;
  if (q.isError) return <ErrorState error={q.error} what="the evidence record" />;
  const { evidence: ev, referenced_by_event_ids, referenced_by_finding_ids } = q.data;
  const im = ev.integrity_metadata;

  return (
    <div className="space-y-3 rounded-md border border-line bg-surface-1 p-3">
      <div className="flex flex-wrap items-center gap-1.5">
        <Mono className="text-fg-1">{ev.id}</Mono>
        <FixtureBadge isFixture={ev.is_fixture} />
        <RedactionBadge status={ev.redaction_status} />
      </div>
      <dl className="grid grid-cols-[max-content_minmax(0,1fr)] gap-x-4 gap-y-1.5">
        <Row k="Type">{humanize(ev.source_type)}</Row>
        <Row k="Reference">
          <Mono>{ev.source_reference}</Mono>
        </Row>
        <Row k="Captured">
          <Time iso={ev.timestamp} />
        </Row>
        <Row k="SHA-256">
          {im.sha256 ? (
            <span className="flex items-start gap-1">
              <Mono className="min-w-0 pt-1 text-fg-1">{im.sha256}</Mono>
              <CopyButton value={im.sha256} label="Copy" className="shrink-0" />
            </span>
          ) : (
            <Unavailable label="not computed" />
          )}
        </Row>
        <Row k="Size">{im.size_bytes !== null ? <Mono>{im.size_bytes} bytes</Mono> : <span className="text-fg-2">unknown</span>}</Row>
        <Row k="Captured by">{im.captured_by ? <Mono>{im.captured_by}</Mono> : <span className="text-fg-2">not recorded</span>}</Row>
        {im.note ? <Row k="Integrity note">{im.note}</Row> : null}
      </dl>
      <div>
        <div className="label mb-1">Excerpt</div>
        {ev.excerpt !== null ? (
          <CodeBlock code={ev.excerpt} wrap maxHeight="20rem" />
        ) : (
          <div className="hatch rounded-sm px-2 py-1.5 text-unknown">
            {ev.redaction_status === "withheld" ? "Excerpt withheld by redaction policy." : "No excerpt captured."}
          </div>
        )}
      </div>
      {referenced_by_event_ids.filter((id) => id !== currentEventId).length > 0 ? (
        <div>
          <div className="label mb-1">Also referenced by events</div>
          <ul className="space-y-0.5">
            {referenced_by_event_ids
              .filter((id) => id !== currentEventId)
              .map((id) => (
                <li key={id}>
                  <button type="button" className="font-mono text-[11px] break-all text-focus hover:underline" onClick={() => onSelect(id)}>
                    {id}
                  </button>
                </li>
              ))}
          </ul>
        </div>
      ) : null}
      {referenced_by_finding_ids.length > 0 ? (
        <div>
          <div className="label mb-1">Referenced by findings</div>
          <ul className="space-y-0.5">
            {referenced_by_finding_ids.map((id) => (
              <li key={id}>
                <Link to={`/findings/${encodeURIComponent(id)}`} className="font-mono text-[11px] text-focus hover:underline">
                  {id}
                </Link>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
