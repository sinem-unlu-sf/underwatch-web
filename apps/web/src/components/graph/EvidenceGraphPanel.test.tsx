import type { FindingGraphResponse, GraphEdge, GraphNode } from "@kw/schema";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";
import { GraphBody } from "./EvidenceGraphPanel";

const node = (id: string, label: GraphNode["label"], title: string, extra: GraphNode["props"] = {}): GraphNode => ({
  id,
  label,
  title,
  basis: label === "ObservedEvent" ? "observed" : label === "AgentAction" ? "reported" : "derived",
  is_fixture: true,
  props: { run_id: "run_x", ...extra },
});

const base: FindingGraphResponse = {
  finding_id: "fnd_a",
  source: "neo4j",
  detail: "Neo4j projection: 3 node(s)",
  nodes: [node("fnd_a", "Finding", "Forbidden .env read"), node("evt_obs", "ObservedEvent", "cat opened .env"), node("evt_tool", "AgentAction", "Bash requested: cat .env")],
  edges: [
    { id: "SUPPORTED_BY:1", from: "fnd_a", to: "evt_obs", type: "SUPPORTED_BY", basis: "derived" },
    { id: "OBSERVED_AS:1", from: "evt_tool", to: "evt_obs", type: "OBSERVED_AS", basis: "inferred" },
  ],
  truncated: false,
  insights: {
    ancestry: [
      {
        event_id: "evt_obs",
        event_summary: "cat (pid 74201) opened .env for reading",
        chain: [
          { process_id: "prc_1", pid: 74000, name: "claude", spawned_basis: null },
          { process_id: "prc_2", pid: 74200, name: "bash", spawned_basis: "observed" },
          { process_id: "prc_3", pid: 74201, name: "cat", spawned_basis: "observed" },
        ],
        origin_tool_call: { event_id: "evt_tool", summary: "Bash requested: cat .env", tool_name: "Bash", relation_basis: "derived", hops_to_event_process: 1 },
        unresolved_reason: null,
      },
    ],
    cross_run: [
      {
        resource_id: "res_1",
        resource_key: "/workspace/demo-repo/.env",
        finding_id: "fnd_b",
        finding_title: "Attempted read of .env blocked by policy",
        finding_status: "new",
        run_id: "run_y",
        event_ids: ["evt_y"],
        event_bases: ["reported"],
        policy_version_id: "pol_1",
        this_policy_version_id: "pol_1",
        linked_by_recurrence: false,
        is_fixture: true,
      },
    ],
  },
};

function renderBody(data: FindingGraphResponse, cited = new Set<string>()) {
  return render(
    <MemoryRouter>
      <GraphBody data={data} cited={cited} hidden={new Set()} setHidden={() => undefined} selected={null} setSelected={() => undefined} latestInvestigation={null} />
    </MemoryRouter>,
  );
}

describe("EvidenceGraphPanel body", () => {
  it("shows the multi-hop ancestry back to the tool call, cross-run matches, and the basis legend", () => {
    renderBody(base, new Set(["evt_obs"]));
    expect(screen.getByText("cat (pid 74201) opened .env for reading").closest("a")).toHaveAttribute("href", "/runs/run_x?event=evt_obs");
    expect(screen.getByText(/Started by agent tool call/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Attempted read of .env blocked by policy" })).toHaveAttribute("href", "/findings/fnd_b");
    expect(screen.getByText("inferred (heuristic, not established)")).toBeInTheDocument();
    expect(screen.getByText(/cited by latest Ask Witness answer \(1\)/)).toBeInTheDocument();
  });

  it("says when traversal is unavailable in the relational fallback", () => {
    renderBody({ ...base, source: "relational", detail: "Neo4j unavailable (graph_unavailable); built from the relational store.", insights: null });
    expect(screen.getByText(/Neo4j unavailable/)).toBeInTheDocument();
    expect(screen.getByText(/Process ancestry and cross-run traversal need Neo4j/)).toBeInTheDocument();
  });
});

type Sel = { kind: "node"; node: GraphNode } | { kind: "edge"; edge: GraphEdge } | null;
function Stateful({ data, focus, compact }: { data: FindingGraphResponse; focus?: Set<string>; compact?: boolean }) {
  const [selected, setSelected] = useState<Sel>(null);
  const [hidden, setHidden] = useState<Set<string>>(() => new Set());
  return (
    <MemoryRouter>
      <GraphBody
        data={data}
        cited={new Set()}
        hidden={hidden}
        setHidden={setHidden}
        selected={selected}
        setSelected={setSelected}
        latestInvestigation={null}
        focus={focus}
        compact={compact}
        explanation={<p>Key relationship explanation</p>}
      />
    </MemoryRouter>
  );
}

describe("EvidenceGraphPanel interactions", () => {
  it("offers zoom / fit controls and an accessible list of every node and relationship", async () => {
    const user = userEvent.setup();
    render(<Stateful data={base} />);
    expect(screen.getByRole("button", { name: "Zoom in" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Zoom out" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Fit" })).toBeInTheDocument();
    await user.click(screen.getByText("List view: 3 nodes, 2 relationships"));
    await user.click(screen.getByRole("button", { name: /ObservedEvent cat opened \.env/ }));
    // The inspector shows the node, its run timeline link, and its direct connections (walkable without the canvas).
    expect(screen.getByRole("link", { name: "open in run timeline" })).toHaveAttribute("href", "/runs/run_x?event=evt_obs");
    expect(screen.getByText("Connected (2)")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "← SUPPORTED_BY" }));
    expect(screen.getAllByText("SUPPORTED_BY").length).toBeGreaterThan(0);
    // Edge inspector links back to both endpoint nodes.
    await user.click(screen.getAllByRole("button", { name: "Forbidden .env read" })[0]!);
    expect(screen.getByText("fnd_a", { selector: "span" })).toBeInTheDocument();
  });

  it("renders the relationship explanation after the canvas and before the inspector", () => {
    render(<Stateful data={base} />);
    const explanation = screen.getByText("Key relationship explanation");
    const inspectorHint = screen.getByText("Select a node or relationship to inspect it.");
    expect(explanation.compareDocumentPosition(inspectorHint) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("compact focus mode draws only the real nodes on the path and skips the traversal panels", async () => {
    const user = userEvent.setup();
    render(<Stateful data={base} focus={new Set(["evt_obs"])} compact />);
    await user.click(screen.getByText("List view: 2 nodes, 1 relationship"));
    const list = screen.getByText("Nodes").parentElement!;
    expect(within(list).queryByText(/Bash requested/)).toBeNull();
    expect(screen.queryByText(/Process ancestry/)).toBeNull();
  });
});
