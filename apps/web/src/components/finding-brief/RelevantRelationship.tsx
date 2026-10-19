import type { GraphBasis, GraphEdge, GraphNode, KeyRelationship } from "@kw/schema";
import { useMemo, useState } from "react";
import { Link } from "react-router";
import { useFindingGraph } from "../../api/queries";
import { StatusPill, type StatusKind } from "../ds/StatusPill";
import { GraphBody } from "../graph/EvidenceGraphPanel";
import { humanize } from "../../lib/format";

/**
 * Quick Read: the single most relevant relationship for this finding, drawn from the SAME graph response the full
 * Evidence graph renders (shared query, no extra fetch). The canvas shows only the real nodes on that path. When the
 * server returns no relationship (or the graph failed), this renders nothing; the Key relationships strip below states
 * why, honestly.
 */

/** Stable empty set: a new Set each render would rebuild the canvas and drop the selection. */
const NO_CITATIONS: Set<string> = new Set();

export const BASIS_PILL: Record<GraphBasis, { kind: StatusKind; label: string }> = {
  observed: { kind: "observed", label: "Observed" },
  reported: { kind: "reported", label: "Reported" },
  derived: { kind: "derived", label: "Derived" },
  inferred: { kind: "inferred", label: "Inferred" },
  ai: { kind: "inferred", label: "AI citation" },
  user: { kind: "neutral", label: "User" },
};

export function RelevantRelationship({
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
  const top: KeyRelationship | undefined = summary?.items[0];
  const pathIds = useMemo(() => (top ? [...new Set(top.steps.map((s) => s.node_id))] : []), [top]);
  const focus = useMemo(() => new Set(pathIds), [pathIds]);
  const [hidden, setHidden] = useState<Set<string>>(() => new Set());
  const [selected, setSelected] = useState<{ kind: "node"; node: GraphNode } | { kind: "edge"; edge: GraphEdge } | null>(null);

  if (!graph.data || !summary || !top) return null;
  const present = graph.data.nodes.filter((n) => focus.has(n.id) || n.id === graph.data!.finding_id).length;
  const canDraw = present >= 2;
  const pill = BASIS_PILL[top.basis];
  const more = summary.items.length - 1 + summary.omitted;

  return (
    <section aria-labelledby="relevant-relationship-title" className="border-t border-line pt-3" data-testid="relevant-relationship">
      <div className="mb-2">
        <h3 id="relevant-relationship-title" className="label">
          Most relevant relationship
        </h3>
        <p className="mt-0.5 text-[11.5px] text-fg-2">
          From the {graph.data.source === "neo4j" ? "Neo4j evidence graph" : "relational fallback graph (Neo4j unavailable)"} for this finding: only the real records on this path are drawn.
        </p>
      </div>
      {canDraw ? (
        <GraphBody
          data={graph.data}
          cited={NO_CITATIONS}
          hidden={hidden}
          setHidden={setHidden}
          selected={selected}
          setSelected={setSelected}
          onOpenEvidence={onOpenEvidence}
          latestInvestigation={null}
          highlight={focus}
          focus={focus}
          compact
          explanation={<RelationshipExplanation rel={top} pill={pill} onOpenEvidence={onOpenEvidence} />}
        />
      ) : (
        <RelationshipExplanation rel={top} pill={pill} onOpenEvidence={onOpenEvidence} />
      )}
      <div className="mt-2 flex flex-wrap items-center gap-2 text-[12px]">
        <button type="button" className="btn btn-sm" onClick={() => onOpenGraph(pathIds)}>
          Open full graph
        </button>
        {more > 0 ? <span className="text-fg-2">{more} more relationship{more === 1 ? "" : "s"} in the full graph.</span> : null}
      </div>
    </section>
  );
}

function RelationshipExplanation({
  rel: r,
  pill,
  onOpenEvidence,
}: {
  rel: KeyRelationship;
  pill: { kind: StatusKind; label: string };
  onOpenEvidence: (id: string) => void;
}) {
  return (
    <div className="rounded-md border border-line px-2.5 py-2" data-basis={r.basis}>
      <div className="flex flex-wrap items-center gap-1.5">
        <StatusPill kind={pill.kind} size="sm">
          {pill.label}
        </StatusPill>
        <span className="text-[11px] text-fg-2">{humanize(r.kind)}</span>
      </div>
      <p className="mt-1 text-[12.5px] text-fg-0">{r.text}</p>
      {r.basis === "inferred" || r.basis === "reported" ? <p className="mt-0.5 text-[11px] text-warn">{r.basis_note}</p> : null}
      {r.links.length > 0 ? (
        <div className="mt-1 flex flex-wrap items-center gap-x-2.5 gap-y-0.5 text-[11px]">
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
        </div>
      ) : null}
    </div>
  );
}
