import type { GraphBasis, KeyRelationship, KeyRelationshipsSummary } from "@kw/schema";
import { Link } from "react-router";
import { useFindingGraph } from "../../api/queries";
import { Badge, type Tone } from "../badges";
import { ErrorState, SkeletonBlock } from "../states";
import { Panel } from "../ui";
import { humanize } from "../../lib/format";

/**
 * Addendum C section 5: the most important graph relationships for this finding, in plain language. Reads the
 * `key_relationships` field of the SAME graph response the Evidence graph panel renders (one shared query), so it can
 * never show a node or edge the graph does not have. Basis badges keep observed / derived / inferred / reported apart.
 */

const BASIS_TONE: Record<GraphBasis, Tone> = {
  observed: "observed",
  reported: "reported",
  derived: "neutral",
  inferred: "warn",
  ai: "focus",
  user: "muted",
};
const BASIS_TITLE: Record<GraphBasis, string> = {
  observed: "Every hop was independently observed",
  reported: "Rests on the agent's own report (a claim)",
  derived: "Derived from Underwatch records / analysis",
  inferred: "At least one hop is heuristic: a lead to check, not proof",
  ai: "Ask Witness citation (in the bundle the model saw, not proof)",
  user: "Recorded by a user",
};

/** Node ids named by the summary's paths (used to highlight them in the full graph). */
export function relationshipNodeIds(summary: KeyRelationshipsSummary | undefined): string[] {
  return [...new Set((summary?.items ?? []).flatMap((r) => r.steps.map((s) => s.node_id)))];
}

export function KeyRelationshipsStrip({
  findingId,
  onOpenGraph,
  onOpenEvidence,
}: {
  findingId: string;
  onOpenGraph: (highlight: string[]) => void;
  onOpenEvidence: (id: string) => void;
}) {
  const graph = useFindingGraph(findingId);
  const summary = graph.data?.key_relationships;

  const aside = (
    <span className="flex items-center gap-1.5 text-[11px]">
      {graph.data ? <Badge tone={graph.data.source === "neo4j" ? "neutral" : "warn"}>{graph.data.source === "neo4j" ? "Neo4j" : "relational fallback"}</Badge> : null}
      <button type="button" className="btn" onClick={() => onOpenGraph(relationshipNodeIds(summary))}>
        Open graph
      </button>
    </span>
  );

  return (
    <Panel title="Key relationships" aside={aside}>
      {graph.isPending ? (
        <SkeletonBlock lines={3} />
      ) : graph.isError ? (
        <ErrorState error={graph.error} what="the graph relationships" />
      ) : !summary ? (
        <div role="status" className="hatch rounded-[3px] px-2 py-1.5 text-[12px] text-unknown">
          This server did not return a key-relationships summary. The full evidence graph is still available under Open graph.
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          <p className="text-[11.5px] text-fg-2">{summary.detail}</p>
          {summary.unavailable.length > 0 ? (
            <div role="status" className="hatch rounded-[3px] px-2 py-1 text-[11.5px] text-unknown">
              Not computed from this source: {summary.unavailable.join("; ")}
            </div>
          ) : null}
          {summary.items.length === 0 ? (
            <p className="text-[12px] text-fg-2">No relationships stand out for this finding. Open the graph to inspect every node.</p>
          ) : (
            <ul className="space-y-1.5">
              {summary.items.map((r) => (
                <RelationshipRow key={r.id} rel={r} onOpenEvidence={onOpenEvidence} onOpenGraph={() => onOpenGraph(r.steps.map((s) => s.node_id))} />
              ))}
            </ul>
          )}
          <p className="text-[11px] text-fg-2">
            {summary.omitted > 0 ? `${summary.omitted} more relationship${summary.omitted === 1 ? "" : "s"} in the full graph. ` : ""}
            {summary.note}
          </p>
        </div>
      )}
    </Panel>
  );
}

function RelationshipRow({ rel: r, onOpenEvidence, onOpenGraph }: { rel: KeyRelationship; onOpenEvidence: (id: string) => void; onOpenGraph: () => void }) {
  return (
    <li className="rounded-[3px] border border-line bg-surface-2 px-2 py-1.5" data-kind={r.kind} data-basis={r.basis}>
      <div className="flex flex-wrap items-center gap-1.5">
        <Badge tone={BASIS_TONE[r.basis]} title={BASIS_TITLE[r.basis]}>
          {r.basis}
        </Badge>
        <span className="text-[11px] text-fg-2">{humanize(r.kind)}</span>
        {r.source === "kw_records" ? <Badge tone="muted">Underwatch records</Badge> : null}
      </div>
      <p className="mt-0.5 text-[12.5px] text-fg-0">{r.text}</p>
      {r.basis === "inferred" || r.basis === "reported" ? <p className="text-[11px] text-warn">{r.basis_note}</p> : null}
      <div className="mt-0.5 flex flex-wrap items-center gap-x-2.5 gap-y-0.5 text-[11px]">
        {r.links.map((l) =>
          l.href ? (
            <Link key={`${l.kind}:${l.id}`} to={l.href} className="text-focus hover:underline">
              {l.label}
            </Link>
          ) : l.kind === "evidence" ? (
            <button key={`${l.kind}:${l.id}`} type="button" className="text-focus hover:underline" onClick={() => onOpenEvidence(l.id)}>
              {l.label}
            </button>
          ) : null,
        )}
        <button type="button" className="text-fg-2 hover:underline" onClick={onOpenGraph}>
          show in graph
        </button>
      </div>
    </li>
  );
}
