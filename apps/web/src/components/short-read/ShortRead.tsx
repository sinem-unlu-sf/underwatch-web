import type { BriefActionStatus, ShortRead as ShortReadData } from "@kw/schema";
import type { ReactNode } from "react";
import { Link } from "react-router";
import { useFinding } from "../../api/queries";
import { Icon } from "../ds/Icon";
import { StatusPill, type StatusKind } from "../ds/StatusPill";

/**
 * Short read (<= 150 words): the server's deterministic summary of one finding. One bold sentence, a few real counts,
 * one-line cause, one-line fix with its stored status. Nothing is computed here; every count links to its records.
 */

/** Honest status pill: green only for "verified for tested scenario". */
const FIX_PILL: Record<BriefActionStatus, StatusKind> = {
  proposed: "pending",
  safeguard_proposed: "pending",
  applied: "active",
  verified_for_tested_scenario: "verified",
  failed_verification: "failed",
  inconclusive: "inconclusive",
};

const BASIS_LABEL: Record<ShortReadData["numbers"][number]["basis"], string> = {
  reported: "agent-reported",
  observed: "independently observed",
  derived: "Underwatch analysis",
};

const TECH = /(\/[\w.-]+)+|\b(run|ver|sg|fnd|evt|ev)_[\w…]+/g;

/** Mono for paths and ids inside a sentence; the text itself is unchanged. */
function MonoTechnical({ text }: { text: string }) {
  const parts: ReactNode[] = [];
  let last = 0;
  for (const m of text.matchAll(TECH)) {
    const i = m.index ?? 0;
    if (i > last) parts.push(text.slice(last, i));
    parts.push(
      <span key={i} className="font-mono text-[0.92em] break-all">
        {m[0]}
      </span>,
    );
    last = i + m[0].length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return <>{parts}</>;
}

export interface ShortReadProps {
  /** Pass the object when the page already has the finding detail; otherwise pass findingId and it is fetched. */
  shortRead?: ShortReadData;
  findingId?: string;
  /** Optional "Ask" button (e.g. opens Ask Witness scoped to this finding). Omitted when not given. */
  onAsk?: () => void;
  askLabel?: string;
  /** Opens an event / evidence record (e.g. the evidence drawer). Without it, ids are shown, not linked. */
  onOpenEvidence?: (id: string) => void;
  /** Which ids onOpenEvidence can open; default: every non-run id. */
  canOpenEvidence?: (id: string) => boolean;
  /** "Full details" target: a callback (same page) or, by default, a link to /findings/:id. */
  onShowFull?: () => void;
  /** Rendered right after the finding sentence (e.g. "Agent said -> Kernel saw"). */
  afterFinding?: ReactNode;
  className?: string;
}

export function ShortRead({ shortRead, findingId, ...rest }: ShortReadProps) {
  if (shortRead) return <ShortReadView data={shortRead} {...rest} />;
  if (!findingId) return null;
  return <ShortReadFetch findingId={findingId} {...rest} />;
}

function ShortReadFetch({ findingId, ...rest }: Omit<ShortReadProps, "shortRead"> & { findingId: string }) {
  const q = useFinding(findingId);
  if (q.isPending) return <div className="skeleton h-24 rounded-md" role="status" aria-label="Loading short read" />;
  if (q.isError) return <p role="alert" className="text-[12px] text-risk">The short read could not be loaded: {(q.error as Error).message}</p>;
  if (!q.data.short_read) return <ShortReadMissing findingId={findingId} onShowFull={rest.onShowFull} />;
  return <ShortReadView data={q.data.short_read} {...rest} />;
}

function ShortReadMissing({ findingId, onShowFull }: { findingId: string; onShowFull?: () => void }) {
  return (
    <div role="status" className="hatch rounded-md px-3 py-2 text-[12px] text-unknown">
      A short read could not be built for this finding. Nothing is hidden: <FullDetails findingId={findingId} onShowFull={onShowFull} />
    </div>
  );
}

function FullDetails({ findingId, onShowFull }: { findingId: string; onShowFull?: () => void }) {
  const cls = "inline-flex items-center gap-1 text-[12px] text-accent hover:underline";
  return onShowFull ? (
    <button type="button" className={cls} onClick={onShowFull}>
      Full details <Icon name="chevronRight" size={12} />
    </button>
  ) : (
    <Link to={`/findings/${encodeURIComponent(findingId)}`} className={cls}>
      Full details <Icon name="chevronRight" size={12} />
    </Link>
  );
}

function EvidenceLinks({ ids, onOpenEvidence, canOpen }: { ids: string[]; onOpenEvidence?: (id: string) => void; canOpen: (id: string) => boolean }) {
  if (ids.length === 0) return null;
  const shown = ids.slice(0, 3);
  return (
    <span className="ml-1.5 inline-flex flex-wrap gap-1 align-middle">
      {shown.map((id) =>
        id.startsWith("run_") ? (
          <Link key={id} to={`/runs/${encodeURIComponent(id)}`} title={id} className="font-mono text-[10.5px] text-accent hover:underline">
            {id.slice(0, 12)}…
          </Link>
        ) : onOpenEvidence && canOpen(id) ? (
          <button key={id} type="button" title={`Open ${id}`} aria-label={`Open ${id}`} onClick={() => onOpenEvidence(id)} className="font-mono text-[10.5px] text-accent hover:underline">
            {id.length > 14 ? `${id.slice(0, 14)}…` : id}
          </button>
        ) : (
          <span key={id} title={id} className="font-mono text-[10.5px] text-fg-2">
            {id.length > 14 ? `${id.slice(0, 14)}…` : id}
          </span>
        ),
      )}
      {ids.length > shown.length ? <span className="text-[10.5px] text-fg-2">+{ids.length - shown.length}</span> : null}
    </span>
  );
}

function ShortReadView({
  data: s,
  onAsk,
  askLabel = "Ask about this",
  onOpenEvidence,
  canOpenEvidence,
  onShowFull,
  afterFinding,
  className = "",
}: Omit<ShortReadProps, "shortRead" | "findingId"> & { data: ShortReadData }) {
  const canOpen = canOpenEvidence ?? ((id: string) => !id.startsWith("run_"));
  return (
    <section
      aria-label="Short read"
      data-word-count={s.word_count}
      className={`rounded-md border border-line bg-surface px-4 py-3 ${className}`}
    >
      <div className="mb-1.5 flex flex-wrap items-center gap-2 text-[11px] text-fg-2">
        <span className="label">Short read</span>
        {s.is_fixture ? <StatusPill kind="fixture" /> : null}
        <span title="Built by Underwatch from stored records without AI">deterministic · no AI · {s.word_count} words</span>
      </div>

      <p className="text-[15px] leading-snug font-semibold text-fg-0 break-words">{s.finding}</p>

      {afterFinding ? <div className="mt-2">{afterFinding}</div> : null}

      <ul className="mt-2.5 space-y-1" aria-label="Numbers">
        {s.numbers.map((x, i) => (
          <li key={i} className="flex items-baseline gap-2 text-[12.5px] text-fg-1">
            <span aria-hidden className="text-fg-2">
              <Icon name={x.basis === "observed" ? "eye" : x.basis === "reported" ? "quote" : "derive"} size={11} />
            </span>
            <span className="min-w-0">
              <MonoTechnical text={x.text} />
              <span className="sr-only"> ({BASIS_LABEL[x.basis]})</span>
              <EvidenceLinks ids={x.evidence_ids} onOpenEvidence={onOpenEvidence} canOpen={canOpen} />
            </span>
          </li>
        ))}
      </ul>

      <dl className="mt-2.5 space-y-1.5 text-[12.5px]">
        <div className="flex gap-2">
          <dt className="label w-8 shrink-0 pt-0.5">Why</dt>
          <dd className="min-w-0 text-fg-0">
            <MonoTechnical text={s.why} />
          </dd>
        </div>
        <div className="flex gap-2">
          <dt className="label w-8 shrink-0 pt-0.5">Fix</dt>
          <dd className="flex min-w-0 flex-wrap items-center gap-1.5 text-fg-0">
            <span>
              <MonoTechnical text={s.fix} />
            </span>
            <StatusPill kind={FIX_PILL[s.fix_status]}>{s.fix_status_label}</StatusPill>
            {s.fix_safeguard_id ? (
              <Link to={`/safeguards/${encodeURIComponent(s.fix_safeguard_id)}`} className="font-mono text-[11px] text-accent hover:underline" title={s.fix_safeguard_id}>
                {s.fix_safeguard_id}
              </Link>
            ) : null}
          </dd>
        </div>
      </dl>

      <div className="mt-3 flex flex-wrap items-center gap-3 border-t border-line pt-2">
        <FullDetails findingId={s.finding_id} onShowFull={onShowFull} />
        {onAsk ? (
          <button type="button" className="btn btn-sm" onClick={onAsk}>
            {askLabel}
          </button>
        ) : null}
      </div>
    </section>
  );
}
