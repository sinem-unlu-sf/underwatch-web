import type { FindingGraphResponse, GraphBasis, GraphEdge, GraphNode, GraphNodeLabel, InvestigationTurn } from "@kw/schema";
import { useQueryClient } from "@tanstack/react-query";
import cytoscape, { type Core, type ElementDefinition } from "cytoscape";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Link } from "react-router";
import { queryKeys, useFindingGraph, useFindingInvestigations, useInvestigation } from "../../api/queries";
import { Badge, FixtureBadge } from "../badges";
import { ErrorState } from "../states";
import { Mono, Panel } from "../ui";

/**
 * Evidence graph for one finding (Neo4j projection, or the relational fallback when Neo4j is unavailable). Edge style
 * encodes HOW a link was established: observed = solid, reported (agent claim) = dashed purple, derived (Underwatch
 * records/analysis) = dashed grey, inferred (heuristic) = dotted amber, ai (Ask Witness citation) = dotted blue.
 * Nodes cited by the latest Ask Witness answer are ringed; a citation means "in the bundle the model saw", not "true".
 */

const BASIS_EDGE: Record<GraphBasis, { color: string; style: "solid" | "dashed" | "dotted"; label: string }> = {
  observed: { color: "#5cb8e6", style: "solid", label: "observed (independent observer)" },
  reported: { color: "#c6a0f0", style: "dashed", label: "reported (agent claim)" },
  derived: { color: "#8e8c85", style: "dashed", label: "derived (Underwatch records / analysis)" },
  inferred: { color: "#e3a740", style: "dotted", label: "inferred (heuristic, not established)" },
  ai: { color: "#7fc4ff", style: "dotted", label: "ai (Ask Witness citation, app-validated in bundle)" },
  user: { color: "#b6b3ab", style: "dashed", label: "user" },
};

const NODE_STYLE: Record<GraphNodeLabel, { color: string; shape: string }> = {
  AgentAction: { color: "#c6a0f0", shape: "ellipse" },
  ObservedEvent: { color: "#5cb8e6", shape: "ellipse" },
  DerivedEvent: { color: "#8e8c85", shape: "ellipse" },
  Finding: { color: "#f2645c", shape: "diamond" },
  Resource: { color: "#b6b3ab", shape: "round-rectangle" },
  Process: { color: "#6f7a8a", shape: "hexagon" },
  Evidence: { color: "#5e5d58", shape: "rectangle" },
  Safeguard: { color: "#52c47e", shape: "round-triangle" },
  SafeguardVersion: { color: "#2f7a4d", shape: "round-triangle" },
  VerificationRun: { color: "#e3a740", shape: "round-pentagon" },
  Investigation: { color: "#7fc4ff", shape: "star" },
  Run: { color: "#4a5059", shape: "round-rectangle" },
  Task: { color: "#4a5059", shape: "round-rectangle" },
  Policy: { color: "#4a5059", shape: "round-tag" },
  PolicyVersion: { color: "#4a5059", shape: "round-tag" },
};

const OPTIONAL_GROUPS: Record<string, { labels: GraphNodeLabel[]; text: string }> = {
  safeguards: { labels: ["Safeguard", "SafeguardVersion", "VerificationRun"], text: "safeguards" },
  evidence: { labels: ["Evidence"], text: "evidence records" },
  context: { labels: ["Run", "Task", "Policy", "PolicyVersion"], text: "run & policy" },
  ai: { labels: ["Investigation"], text: "Ask Witness" },
};

const timelineHref = (runId: string, eventId: string) => `/runs/${encodeURIComponent(runId)}?event=${encodeURIComponent(eventId)}`;
const isEvent = (l: GraphNodeLabel) => l === "AgentAction" || l === "ObservedEvent" || l === "DerivedEvent";

/** Ids the application validated as in-bundle in the latest answered turn (never raw model output). */
function citedIds(turns: readonly InvestigationTurn[] | undefined): Set<string> {
  const last = [...(turns ?? [])].reverse().find((t) => t.answer !== null);
  const ids = new Set<string>();
  if (!last?.answer) return ids;
  for (const id of last.answer.evidence_references) ids.add(id);
  for (const c of [...last.answer.verified_facts, ...last.answer.hypotheses]) for (const id of c.evidence_ids) ids.add(id);
  return ids;
}

function short(s: string, n = 28): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

export function EvidenceGraphPanel({
  findingId,
  onOpenEvidence,
  highlightIds,
  explanation,
}: {
  findingId: string;
  onOpenEvidence?: (id: string) => void;
  /** Addendum C: node ids named by a key-relationship path ("Open graph" from the summary view); outlined, never added. */
  highlightIds?: readonly string[];
  /** Rendered right after the canvas and legend, before the inspector and traversal details. */
  explanation?: ReactNode;
}) {
  const qc = useQueryClient();
  const highlightKey = (highlightIds ?? []).join("|");
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const highlight = useMemo(() => new Set(highlightIds ?? []), [highlightKey]);
  const graph = useFindingGraph(findingId);
  const invs = useFindingInvestigations(findingId);
  const latest = useMemo(() => {
    const items = invs.data?.items ?? [];
    return items.length === 0 ? null : [...items].sort((a, b) => b.updated_at.localeCompare(a.updated_at))[0]!;
  }, [invs.data]);
  const detail = useInvestigation(latest?.id ?? null);
  const cited = useMemo(() => citedIds(detail.data?.turns), [detail.data]);

  // The projection of a new Ask Witness turn / safeguard runs in the background: refetch shortly after one appears.
  const stamp = `${latest?.id ?? ""}:${latest?.updated_at ?? ""}`;
  const firstStamp = useRef(stamp);
  useEffect(() => {
    if (stamp === firstStamp.current) return;
    const t = setTimeout(() => void qc.invalidateQueries({ queryKey: queryKeys.findingGraph(findingId) }), 800);
    return () => clearTimeout(t);
  }, [stamp, findingId, qc]);

  const [hidden, setHidden] = useState<Set<string>>(() => new Set(["evidence"]));
  const [selected, setSelected] = useState<{ kind: "node"; node: GraphNode } | { kind: "edge"; edge: GraphEdge } | null>(null);

  const aside = graph.data ? (
    <span className="flex items-center gap-1.5 text-[11px]">
      <Badge tone={graph.data.source === "neo4j" ? "neutral" : "warn"}>{graph.data.source === "neo4j" ? "Neo4j" : "relational fallback"}</Badge>
      <button type="button" className="text-focus hover:underline" onClick={() => void graph.refetch()}>
        refresh
      </button>
    </span>
  ) : (
    <span className="text-[11px]">Neo4j</span>
  );

  return (
    <Panel title="Evidence graph" aside={aside}>
      {graph.isPending ? (
        <div className="h-[420px] animate-pulse rounded-[3px] bg-surface-2" aria-label="Loading evidence graph" />
      ) : graph.isError ? (
        <ErrorState error={graph.error} what="the evidence graph" />
      ) : (
        <GraphBody
          data={graph.data}
          cited={cited}
          hidden={hidden}
          setHidden={setHidden}
          selected={selected}
          setSelected={setSelected}
          onOpenEvidence={onOpenEvidence}
          latestInvestigation={latest?.id ?? null}
          highlight={highlight}
          explanation={explanation}
        />
      )}
    </Panel>
  );
}

export function GraphBody({
  data,
  cited,
  hidden,
  setHidden,
  selected,
  setSelected,
  onOpenEvidence,
  latestInvestigation,
  highlight,
  compact = false,
  focus,
  explanation,
}: {
  data: FindingGraphResponse;
  cited: Set<string>;
  hidden: Set<string>;
  setHidden: (f: (s: Set<string>) => Set<string>) => void;
  selected: { kind: "node"; node: GraphNode } | { kind: "edge"; edge: GraphEdge } | null;
  setSelected: (s: { kind: "node"; node: GraphNode } | { kind: "edge"; edge: GraphEdge } | null) => void;
  onOpenEvidence?: (id: string) => void;
  latestInvestigation: string | null;
  highlight?: ReadonlySet<string>;
  /** Quick Read: a smaller canvas without the group toggles and traversal insights. */
  compact?: boolean;
  /** Restrict the canvas to these real node ids (plus the finding). Never adds nodes. */
  focus?: ReadonlySet<string>;
  explanation?: ReactNode;
}) {
  const container = useRef<HTMLDivElement>(null);
  const cyRef = useRef<Core | null>(null);
  const [renderError, setRenderError] = useState<string | null>(null);

  const hiddenLabels = useMemo(() => new Set([...hidden].flatMap((g) => OPTIONAL_GROUPS[g]?.labels ?? [])), [hidden]);
  const nodes = useMemo(
    () => data.nodes.filter((n) => n.id === data.finding_id || (focus ? focus.has(n.id) : !hiddenLabels.has(n.label))),
    [data, hiddenLabels, focus],
  );
  const nodeIds = useMemo(() => new Set(nodes.map((n) => n.id)), [nodes]);
  const edges = useMemo(() => data.edges.filter((e) => nodeIds.has(e.from) && nodeIds.has(e.to)), [data, nodeIds]);
  const byId = useMemo(() => new Map(data.nodes.map((n) => [n.id, n])), [data]);
  const edgeById = useMemo(() => new Map(data.edges.map((e) => [e.id, e])), [data]);

  useEffect(() => {
    if (!container.current) return;
    const elements: ElementDefinition[] = [
      ...nodes.map((n) => ({
        data: { id: n.id, short: short(n.title), color: NODE_STYLE[n.label].color, shape: NODE_STYLE[n.label].shape },
        classes: [n.id === data.finding_id ? "center" : "", cited.has(n.id) ? "cited" : "", highlight?.has(n.id) ? "highlight" : ""].filter(Boolean).join(" "),
      })),
      ...edges.map((e) => {
        const b = BASIS_EDGE[e.basis ?? "derived"];
        return { data: { id: `e:${e.id}`, source: e.from, target: e.to, type: e.type, color: b.color, style: b.style } };
      }),
    ];
    let cy: Core;
    try {
      cy = cytoscape({
        container: container.current,
        elements,
        minZoom: 0.2,
        maxZoom: 3,
        wheelSensitivity: 0.3,
        style: [
          {
            selector: "node",
            style: {
              "background-color": "data(color)",
              shape: "data(shape)" as never,
              label: "data(short)",
              color: "#92929D",
              "font-size": 9,
              "text-valign": "bottom",
              "text-margin-y": 3,
              width: 16,
              height: 16,
              "border-width": 1,
              "border-color": "#2a2a30",
              "transition-property": "opacity, border-color" as never,
              "transition-duration": 0.15 as never,
              "text-wrap": "ellipsis",
              "text-max-width": "110px",
            },
          },
          { selector: "node.center", style: { width: 26, height: 26, "border-width": 3, "border-color": "#EDEDF0" } },
          { selector: "node.cited", style: { "border-width": 4, "border-color": "#7fc4ff" } },
          { selector: "node.highlight", style: { "border-width": 4, "border-color": "#e3a740", "border-style": "double" as never } },
          { selector: "node:selected", style: { "border-width": 4, "border-color": "#8B8CF6", color: "#EDEDF0" } },
          { selector: "node.hover-n", style: { color: "#EDEDF0", "border-color": "#8B8CF6", "border-width": 2 } },
          { selector: ".faded", style: { opacity: 0.22 } },
          {
            selector: "edge",
            style: {
              width: 1.3,
              "line-color": "data(color)",
              "line-style": "data(style)" as never,
              "target-arrow-shape": "triangle",
              "target-arrow-color": "data(color)",
              "arrow-scale": 0.7,
              "curve-style": "bezier",
            },
          },
          { selector: "edge.hover-e", style: { width: 2.4, label: "data(type)", "font-size": 8, color: "#EDEDF0", "text-background-color": "#111114", "text-background-opacity": 1 } },
          { selector: "edge:selected", style: { width: 3, "line-color": "#8B8CF6", "target-arrow-color": "#8B8CF6", label: "data(type)", "font-size": 8, color: "#EDEDF0", "text-background-color": "#111114", "text-background-opacity": 1 } },
        ],
        layout: { name: "breadthfirst", roots: [data.finding_id], directed: false, spacingFactor: 1.15, padding: 12, animate: false } as never,
      });
    } catch (err) {
      setRenderError(err instanceof Error ? err.message : "graph renderer unavailable");
      return;
    }
    setRenderError(null);
    cy.on("tap", "node", (evt) => {
      const n = byId.get(evt.target.id());
      if (n) setSelected({ kind: "node", node: n });
    });
    cy.on("tap", "edge", (evt) => {
      const e = edgeById.get(String(evt.target.id()).slice(2));
      if (e) setSelected({ kind: "edge", edge: e });
    });
    cy.on("tap", (evt) => {
      if (evt.target === cy) setSelected(null);
    });
    // Hover: emphasise the hovered element and everything directly connected to it; fade the rest.
    const clearHover = () => cy.elements().removeClass("faded hover-n hover-e");
    cy.on("mouseover", "node", (evt) => {
      const hood = evt.target.closedNeighborhood();
      cy.elements().not(hood).addClass("faded");
      hood.nodes().addClass("hover-n");
      hood.edges().addClass("hover-e");
    });
    cy.on("mouseover", "edge", (evt) => {
      const hood = evt.target.union(evt.target.connectedNodes());
      cy.elements().not(hood).addClass("faded");
      evt.target.addClass("hover-e");
      evt.target.connectedNodes().addClass("hover-n");
    });
    cy.on("mouseout", "node, edge", clearHover);
    cyRef.current = cy;
    return () => {
      cy.destroy();
      cyRef.current = null;
    };
  }, [nodes, edges, cited, highlight, data.finding_id, byId, edgeById, setSelected]);

  const basesPresent = [...new Set(edges.map((e) => e.basis ?? "derived"))] as GraphBasis[];

  /** Select from the canvas controls or the list alternative; mirrors a tap on the canvas. */
  const pick = (sel: { kind: "node"; node: GraphNode } | { kind: "edge"; edge: GraphEdge }) => {
    setSelected(sel);
    const cy = cyRef.current;
    if (!cy) return;
    cy.elements().unselect();
    const el = cy.getElementById(sel.kind === "node" ? sel.node.id : `e:${sel.edge.id}`);
    if (el.nonempty()) {
      el.select();
      cy.animate({ center: { eles: el } }, { duration: 160 });
    }
  };
  const zoomBy = (factor: number) => {
    const cy = cyRef.current;
    if (!cy) return;
    const z = Math.min(cy.maxZoom(), Math.max(cy.minZoom(), cy.zoom() * factor));
    cy.zoom({ level: z, renderedPosition: { x: cy.width() / 2, y: cy.height() / 2 } });
  };
  const fit = () => cyRef.current?.fit(undefined, 12);
  const canvasHeight = compact ? "h-[260px]" : "h-[420px]";

  return (
    <div className="flex flex-col gap-2">
      {compact ? null : <p className="text-[12px] text-fg-1">{data.detail}</p>}
      <div className={`flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-fg-2 ${compact ? "hidden" : ""}`}>
        <span className="label">Show</span>
        {Object.entries(OPTIONAL_GROUPS).map(([key, g]) => (
          <label key={key} className="flex items-center gap-1">
            <input
              type="checkbox"
              checked={!hidden.has(key)}
              onChange={() =>
                setHidden((s) => {
                  const next = new Set(s);
                  if (next.has(key)) next.delete(key);
                  else next.add(key);
                  return next;
                })
              }
            />
            {g.text}
          </label>
        ))}
        {data.truncated ? <Badge tone="warn">truncated</Badge> : null}
        {highlight && highlight.size > 0 ? (
          <span className="flex items-center gap-1">
            <span className="inline-block h-2.5 w-2.5 rounded-full border-2 border-warn" /> on the selected key relationship ({[...highlight].filter((id) => nodeIds.has(id)).length} shown)
          </span>
        ) : null}
        {cited.size > 0 ? (
          <span className="flex items-center gap-1">
            <span className="inline-block h-2.5 w-2.5 rounded-full border-2 border-focus" /> cited by latest Ask Witness answer ({cited.size})
          </span>
        ) : null}
      </div>
      {renderError ? (
        <div className="hatch rounded-[3px] p-2 text-[12px] text-unknown">
          Graph renderer unavailable ({renderError}). {nodes.length} node(s), {edges.length} relationship(s) listed in the inspector below.
        </div>
      ) : null}
      <div className={`relative ${renderError ? "hidden" : ""}`}>
        <div
          ref={container}
          className={`${canvasHeight} w-full rounded-md border border-line bg-surface-0`}
          role="img"
          aria-label={`Evidence graph with ${nodes.length} nodes and ${edges.length} relationships. A list of every node and relationship follows.`}
        />
        <div className="absolute top-2 right-2 flex gap-1" role="group" aria-label="Graph view controls">
          <button type="button" className="btn btn-sm btn-icon" aria-label="Zoom in" title="Zoom in" onClick={() => zoomBy(1.25)}>
            +
          </button>
          <button type="button" className="btn btn-sm btn-icon" aria-label="Zoom out" title="Zoom out" onClick={() => zoomBy(0.8)}>
            −
          </button>
          <button type="button" className="btn btn-sm" title="Fit the whole graph in view" onClick={fit}>
            Fit
          </button>
        </div>
        <p className="mt-1 text-[11px] text-fg-2">Hover a node to see what it connects to; click a node or relationship to inspect it. Scroll or pinch to zoom, drag to pan.</p>
      </div>
      <div className="flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-fg-2">
        {basesPresent.map((b) => (
          <span key={b} className="flex items-center gap-1">
            <svg width="22" height="6" aria-hidden="true">
              <line x1="0" y1="3" x2="22" y2="3" stroke={BASIS_EDGE[b].color} strokeWidth="2" strokeDasharray={BASIS_EDGE[b].style === "solid" ? undefined : BASIS_EDGE[b].style === "dashed" ? "5 3" : "1.5 2.5"} />
            </svg>
            {BASIS_EDGE[b].label}
          </span>
        ))}
      </div>
      {explanation}
      <Inspector
        selected={selected}
        cited={cited}
        findingId={data.finding_id}
        onOpenEvidence={onOpenEvidence}
        byId={byId}
        latestInvestigation={latestInvestigation}
        edges={edges}
        onPick={pick}
      />
      <GraphList nodes={nodes} edges={edges} byId={byId} selected={selected} onPick={pick} highlight={highlight} cited={cited} />
      {compact ? null : <Insights data={data} />}
    </div>
  );
}

/** Accessible alternative to the canvas: every shown node and relationship as a keyboard-reachable list. */
function GraphList({
  nodes,
  edges,
  byId,
  selected,
  onPick,
  highlight,
  cited,
}: {
  nodes: GraphNode[];
  edges: GraphEdge[];
  byId: Map<string, GraphNode>;
  selected: { kind: "node"; node: GraphNode } | { kind: "edge"; edge: GraphEdge } | null;
  onPick: (sel: { kind: "node"; node: GraphNode } | { kind: "edge"; edge: GraphEdge }) => void;
  highlight?: ReadonlySet<string>;
  cited: Set<string>;
}) {
  const selId = selected?.kind === "node" ? selected.node.id : selected?.kind === "edge" ? `e:${selected.edge.id}` : null;
  const item = "w-full rounded-[4px] px-1.5 py-0.5 text-left hover:bg-surface-2 aria-pressed:bg-surface-2 aria-pressed:text-fg-0";
  return (
    <details className="rounded-md border border-line px-2 py-1.5 text-[12px]">
      <summary className="cursor-pointer text-[11.5px] text-fg-2">
        List view: {nodes.length} node{nodes.length === 1 ? "" : "s"}, {edges.length} relationship{edges.length === 1 ? "" : "s"}
      </summary>
      <div className="mt-1.5 grid gap-3 md:grid-cols-2">
        <div>
          <div className="label mb-1">Nodes</div>
          <ul className="max-h-[240px] space-y-0.5 overflow-y-auto">
            {nodes.map((n) => (
              <li key={n.id}>
                <button type="button" className={item} aria-pressed={selId === n.id} onClick={() => onPick({ kind: "node", node: n })}>
                  <span className="text-fg-2">{n.label}</span> <span className="text-fg-1">{short(n.title, 60)}</span>
                  {n.basis ? <span className="text-fg-2"> · {n.basis}</span> : null}
                  {highlight?.has(n.id) ? <span className="text-warn"> · on key relationship</span> : null}
                  {cited.has(n.id) ? <span className="text-focus"> · cited</span> : null}
                </button>
              </li>
            ))}
          </ul>
        </div>
        <div>
          <div className="label mb-1">Relationships</div>
          {edges.length === 0 ? (
            <p className="text-fg-2">No relationships among the shown nodes.</p>
          ) : (
            <ul className="max-h-[240px] space-y-0.5 overflow-y-auto">
              {edges.map((e) => (
                <li key={e.id}>
                  <button type="button" className={item} aria-pressed={selId === `e:${e.id}`} onClick={() => onPick({ kind: "edge", edge: e })}>
                    <span className="text-fg-1">{short(byId.get(e.from)?.title ?? e.from, 32)}</span>{" "}
                    <span className="font-mono text-[11px] text-fg-2">{e.type}</span>{" "}
                    <span className="text-fg-1">{short(byId.get(e.to)?.title ?? e.to, 32)}</span>
                    <span className="text-fg-2"> · {e.basis ?? "unknown basis"}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </details>
  );
}

function Inspector({
  selected,
  cited,
  findingId,
  onOpenEvidence,
  byId,
  latestInvestigation,
  edges,
  onPick,
}: {
  selected: { kind: "node"; node: GraphNode } | { kind: "edge"; edge: GraphEdge } | null;
  cited: Set<string>;
  findingId: string;
  onOpenEvidence?: (id: string) => void;
  byId: Map<string, GraphNode>;
  latestInvestigation: string | null;
  edges: GraphEdge[];
  onPick: (sel: { kind: "node"; node: GraphNode } | { kind: "edge"; edge: GraphEdge }) => void;
}) {
  if (!selected) return <div className="text-[12px] text-fg-2">Select a node or relationship to inspect it.</div>;
  if (selected.kind === "edge") {
    const e = selected.edge;
    return (
      <div className="rounded-[3px] border border-line bg-surface-2 p-2 text-[12px]">
        <div className="flex flex-wrap items-center gap-1.5">
          <Mono>{e.type}</Mono>
          <Badge tone={e.basis === "observed" ? "neutral" : e.basis === "inferred" ? "warn" : "unknown"}>{e.basis ?? "unknown basis"}</Badge>
        </div>
        <div className="mt-1 flex flex-wrap items-center gap-1 text-fg-1">
          <NodeLink id={e.from} byId={byId} onPick={onPick} /> <span aria-hidden>→</span>
          <span className="sr-only">to</span> <NodeLink id={e.to} byId={byId} onPick={onPick} />
        </div>
        <div className="mt-1 text-[11px] text-fg-2">{BASIS_EDGE[e.basis ?? "derived"].label}</div>
      </div>
    );
  }
  const n = selected.node;
  const runId = typeof n.props.run_id === "string" ? n.props.run_id : null;
  const props = Object.entries(n.props).filter(([k, v]) => k !== "id" && v !== null && v !== "");
  return (
    <div className="rounded-[3px] border border-line bg-surface-2 p-2 text-[12px]">
      <div className="flex flex-wrap items-center gap-1.5">
        <FixtureBadge isFixture={n.is_fixture} compact />
        <Badge tone="neutral">{n.label}</Badge>
        {n.basis ? <Badge tone={n.basis === "observed" ? "neutral" : "unknown"}>{n.basis}</Badge> : null}
        {cited.has(n.id) ? <Badge tone="neutral">cited by latest answer</Badge> : null}
        <span className="font-medium text-fg-0">{n.title}</span>
      </div>
      <div className="mt-1">
        <Mono className="text-[11px] text-fg-2">{n.id}</Mono>
      </div>
      <div className="mt-1.5 flex flex-wrap gap-3 text-[12px]">
        {isEvent(n.label) && runId ? (
          <Link to={timelineHref(runId, n.id)} className="text-focus hover:underline">
            open in run timeline
          </Link>
        ) : null}
        {n.label === "Finding" && n.id !== findingId ? (
          <Link to={`/findings/${encodeURIComponent(n.id)}`} className="text-focus hover:underline">
            open finding
          </Link>
        ) : null}
        {n.label === "Safeguard" ? (
          <Link to={`/safeguards/${encodeURIComponent(n.id)}`} className="text-focus hover:underline">
            open safeguard
          </Link>
        ) : null}
        {n.label === "Evidence" && onOpenEvidence ? (
          <button type="button" className="text-focus hover:underline" onClick={() => onOpenEvidence(n.id)}>
            open evidence record
          </button>
        ) : null}
        {n.label === "Run" ? (
          <Link to={`/runs/${encodeURIComponent(n.id)}`} className="text-focus hover:underline">
            open run
          </Link>
        ) : runId && !isEvent(n.label) ? (
          <Link to={`/runs/${encodeURIComponent(runId)}`} className="text-focus hover:underline">
            open run
          </Link>
        ) : null}
      </div>
      <Connected node={n} edges={edges} byId={byId} onPick={onPick} />
      {n.label === "Investigation" ? (
        <p className="mt-1.5 text-[11px] text-fg-2">
          AI investigation record (advisory). It is stored separately from evidence; its USES_EVIDENCE links point only at ids the application found in the bundle sent to the model.
          {n.id === latestInvestigation ? " This is the latest investigation." : ""}
        </p>
      ) : null}
      {n.label === "Safeguard" && n.props.application_mechanism === "claude_md_instruction" ? (
        <p className="mt-1.5 text-[11px] text-warn">CLAUDE.md instruction: guidance to the agent, not an enforced control.</p>
      ) : null}
      {props.length > 0 ? (
        <dl className="mt-2 grid grid-cols-[max-content_1fr] gap-x-3 gap-y-0.5 text-[11px]">
          {props.slice(0, 24).map(([k, v]) => (
            <div key={k} className="contents">
              <dt className="text-fg-2">{k}</dt>
              <dd className="min-w-0 font-mono break-all text-fg-1">{String(v)}</dd>
            </div>
          ))}
        </dl>
      ) : null}
    </div>
  );
}

/** Multi-hop answers a flat event list cannot give directly. Neo4j only. */
function Insights({ data }: { data: FindingGraphResponse }) {
  if (!data.insights) {
    return <div className="hatch rounded-[3px] p-2 text-[12px] text-unknown">Process ancestry and cross-run traversal need Neo4j; not available in the relational fallback.</div>;
  }
  const { ancestry, cross_run } = data.insights;
  const nodeRun = new Map(data.nodes.map((n) => [n.id, typeof n.props.run_id === "string" ? n.props.run_id : null]));
  return (
    <div className="grid gap-2 md:grid-cols-2">
      <div className="rounded-[3px] border border-line p-2">
        <div className="label mb-1">Process ancestry (observed event → agent tool call)</div>
        {ancestry.length === 0 ? (
          <div className="text-[12px] text-fg-2">No observed event of this finding has an attributed process.</div>
        ) : (
          <ul className="space-y-2 text-[12px]">
            {ancestry.map((a) => {
              const run = nodeRun.get(a.event_id) ?? null;
              return (
                <li key={a.event_id}>
                  <div className="text-fg-0">
                    {run ? (
                      <Link to={timelineHref(run, a.event_id)} className="hover:underline">
                        {a.event_summary}
                      </Link>
                    ) : (
                      a.event_summary
                    )}
                  </div>
                  <div className="mt-0.5 flex flex-wrap items-center gap-1 font-mono text-[11px] text-fg-1">
                    {a.origin_tool_call ? (
                      <>
                        <span className="text-reported">{a.origin_tool_call.tool_name ?? "tool"} call</span>
                        <span className="text-fg-2" title={`correlation basis: ${a.origin_tool_call.relation_basis ?? "?"}`}>
                          ⇢
                        </span>
                      </>
                    ) : null}
                    {a.chain.map((h, i) => (
                      <span key={h.process_id} className="flex items-center gap-1">
                        {i > 0 ? <span className={h.spawned_basis === "observed" ? "text-observed" : "text-fg-2"}>→</span> : null}
                        <span>
                          {h.name ?? "?"}
                          <span className="text-fg-2">({h.pid ?? "?"})</span>
                        </span>
                      </span>
                    ))}
                  </div>
                  {a.origin_tool_call ? (
                    <div className="text-[11px] text-fg-2">
                      Started by agent tool call “{short(a.origin_tool_call.summary, 60)}” (link basis: {a.origin_tool_call.relation_basis ?? "unknown"}).
                    </div>
                  ) : (
                    <div className="text-[11px] text-unknown">{a.unresolved_reason ?? "No originating tool call found."}</div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
      <div className="rounded-[3px] border border-line p-2">
        <div className="label mb-1">Same resource in other runs</div>
        {cross_run.length === 0 ? (
          <div className="text-[12px] text-fg-2">No finding in another run touched the same file or host.</div>
        ) : (
          <ul className="space-y-1.5 text-[12px]">
            {cross_run.map((m) => (
              <li key={`${m.resource_id}:${m.finding_id}`}>
                <div className="flex flex-wrap items-center gap-1">
                  <FixtureBadge isFixture={m.is_fixture} compact />
                  <Link to={`/findings/${encodeURIComponent(m.finding_id)}`} className="text-focus hover:underline">
                    {m.finding_title}
                  </Link>
                </div>
                <div className="text-[11px] text-fg-2">
                  <Mono className="text-[11px]">{m.resource_key}</Mono> · {m.event_bases.join("/")} event(s) · policy {m.policy_version_id ?? "?"}
                  {m.policy_version_id && m.this_policy_version_id && m.policy_version_id !== m.this_policy_version_id ? " (different from this run)" : ""}
                  {m.linked_by_recurrence ? " · linked as recurrence" : ""}
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function NodeLink({ id, byId, onPick }: { id: string; byId: Map<string, GraphNode>; onPick: (sel: { kind: "node"; node: GraphNode }) => void }) {
  const n = byId.get(id);
  if (!n) return <Mono className="text-[11px]">{id}</Mono>;
  return (
    <button type="button" className="text-focus hover:underline" onClick={() => onPick({ kind: "node", node: n })}>
      {n.title}
    </button>
  );
}

/** Direct connections of the inspected node, so the graph can be walked without the canvas. */
function Connected({
  node,
  edges,
  byId,
  onPick,
}: {
  node: GraphNode;
  edges: GraphEdge[];
  byId: Map<string, GraphNode>;
  onPick: (sel: { kind: "node"; node: GraphNode } | { kind: "edge"; edge: GraphEdge }) => void;
}) {
  const links = edges.filter((e) => e.from === node.id || e.to === node.id);
  if (links.length === 0) return null;
  return (
    <div className="mt-2">
      <div className="label mb-0.5">Connected ({links.length})</div>
      <ul className="space-y-0.5 text-[11.5px]">
        {links.slice(0, 12).map((e) => {
          const other = e.from === node.id ? e.to : e.from;
          return (
            <li key={e.id} className="flex flex-wrap items-center gap-1">
              <button type="button" className="font-mono text-[11px] text-fg-2 hover:underline" onClick={() => onPick({ kind: "edge", edge: e })}>
                {e.from === node.id ? `${e.type} →` : `← ${e.type}`}
              </button>
              <NodeLink id={other} byId={byId} onPick={onPick} />
              <span className="text-fg-2">({e.basis ?? "unknown basis"})</span>
            </li>
          );
        })}
        {links.length > 12 ? <li className="text-fg-2">{links.length - 12} more in the list view below.</li> : null}
      </ul>
    </div>
  );
}
