import type { BundleEvidenceRef } from "@kw/schema";
import { useEffect } from "react";
import { Link } from "react-router";
import { useEvidence } from "../../api/queries";
import { humanize, truncate } from "../../lib/format";
import { Badge, BasisBadge, FixtureBadge, RedactionBadge } from "../badges";
import { ErrorState, SkeletonBlock } from "../states";
import { KeyValue, Mono, Time } from "../ui";

export const timelineHref = (runId: string, eventId?: string) =>
  `/runs/${encodeURIComponent(runId)}${eventId ? `?event=${encodeURIComponent(eventId)}` : ""}`;

/**
 * A cited id that the APP found in the evidence bundle actually sent to the model. Clicking opens the evidence drawer.
 * Invalid (out-of-bundle) ids are never rendered with this component; see InvalidIdChip.
 */
export function EvidenceChip({ id, evidenceRef, onOpen }: { id: string; evidenceRef: BundleEvidenceRef | undefined; onOpen: (id: string) => void }) {
  const basis = evidenceRef?.basis ?? null;
  const tone =
    basis === "observed" ? "border-observed/50 text-observed" : basis === "reported" ? "border-reported/50 text-reported" : "border-line-strong text-fg-1";
  return (
    <button
      type="button"
      onClick={() => onOpen(id)}
      title={evidenceRef ? `${evidenceRef.kind}${basis ? ` · ${basis}` : ""}: ${evidenceRef.summary}` : "Open evidence"}
      className={`inline-flex max-w-full items-center gap-1 rounded-[3px] border bg-surface-2 px-1.5 py-px text-left font-mono break-all text-[11px] leading-4 hover:bg-surface-3 ${tone}`}
    >
      {id}
    </button>
  );
}

/** An id the model cited that is NOT in the bundle. Shown as plain struck text, never as a link. */
export function InvalidIdChip({ id }: { id: string }) {
  return (
    <span
      title="Cited by the model but not present in the evidence bundle sent to it. Ignored."
      className="inline-flex max-w-full items-center rounded-[3px] border border-dashed border-risk/55 break-all px-1.5 py-px font-mono text-[11px] leading-4 text-risk line-through"
    >
      {id}
    </span>
  );
}

/** Right-hand drawer for one cited evidence id (same placement/behavior as the run page's evidence inspector). */
export function EvidenceRefDrawer({ id, evidenceRef, onClose }: { id: string; evidenceRef: BundleEvidenceRef | undefined; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <aside
      aria-label="Evidence inspector"
      className="fixed inset-y-0 right-0 z-30 flex w-[min(500px,100vw)] flex-col border-l border-line-strong bg-surface-1 shadow-[0_0_0_9999px_rgba(0,0,0,0.25)]"
    >
      <div className="flex items-center gap-2 border-b border-line px-3 py-2">
        <h2 className="text-[12px] font-semibold tracking-wide text-fg-1 uppercase">Evidence inspector</h2>
        {evidenceRef?.basis ? <BasisBadge basis={evidenceRef.basis} /> : null}
        <button type="button" className="btn ml-auto" onClick={onClose}>
          Close <span className="text-fg-2">Esc</span>
        </button>
      </div>
      <div className="min-h-0 flex-1 space-y-3 overflow-auto p-3">
        <Mono>{id}</Mono>
        {evidenceRef ? (
          <>
            <KeyValue
              items={[
                ["Kind", humanize(evidenceRef.kind)],
                ["Basis", evidenceRef.basis ? <BasisBadge basis={evidenceRef.basis} /> : <span className="text-fg-2">derived (Underwatch analysis)</span>],
                ["Source", evidenceRef.source ? <Mono>{evidenceRef.source}</Mono> : <span className="text-fg-2">—</span>],
                ["Time", <Time iso={evidenceRef.timestamp} />],
                ["Summary", <span className="text-fg-1">{evidenceRef.summary}</span>],
              ]}
            />
            <p className="text-[11px] text-fg-2">This is the redacted index entry that was in the evidence bundle sent to ai&. The underlying record is below / linked.</p>
            {evidenceRef.kind === "event" && evidenceRef.run_id ? (
              <Link to={timelineHref(evidenceRef.run_id, id)} className="btn">
                Open event in run timeline
              </Link>
            ) : null}
            {evidenceRef.kind === "finding" ? (
              <Link to={`/findings/${encodeURIComponent(id)}`} className="btn">
                Open finding
              </Link>
            ) : null}
            {evidenceRef.kind === "evidence" ? <EvidenceRecord id={id} /> : null}
          </>
        ) : (
          <p className="text-fg-1">This id is not in the evidence index for this investigation.</p>
        )}
      </div>
    </aside>
  );
}

function EvidenceRecord({ id }: { id: string }) {
  const q = useEvidence(id);
  if (q.isPending) return <SkeletonBlock lines={4} />;
  if (q.isError) return <ErrorState error={q.error} what="the evidence record" />;
  const ev = q.data.evidence;
  return (
    <div className="space-y-2 rounded-[3px] border border-line bg-surface-2 p-2">
      <div className="flex flex-wrap items-center gap-1.5">
        <FixtureBadge isFixture={ev.is_fixture} />
        <Badge tone="muted">{humanize(ev.source_type)}</Badge>
        <RedactionBadge status={ev.redaction_status} />
      </div>
      <KeyValue
        items={[
          ["Reference", <Mono>{ev.source_reference}</Mono>],
          ["Timestamp", <Time iso={ev.timestamp} />],
          ["Excerpt", ev.excerpt !== null ? <Mono className="text-fg-1">{truncate(ev.excerpt, 600)}</Mono> : <span className="text-fg-2">no excerpt</span>],
        ]}
      />
      {q.data.referenced_by_event_ids.length > 0 ? (
        <div className="text-[12px] text-fg-2">
          Referenced by events:{" "}
          {q.data.referenced_by_event_ids.map((e) => (
            <Mono key={e} className="mr-1">
              {e}
            </Mono>
          ))}
        </div>
      ) : null}
    </div>
  );
}
