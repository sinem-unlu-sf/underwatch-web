import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { EventCorrelation, FindingDetailResponse, FindingGraphResponse, KeyRelationshipsSummary, type Safeguard } from "@kw/schema";
import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useEffect, type ReactNode } from "react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { safeguardProgression } from "../components/finding-brief/SafeguardProgression";
import { FINDING_VIEW_STORAGE_KEY } from "../components/finding-brief/useFindingView";
// Real responses captured from the running API for fixture finding fx-04 (hand-labeled fixture data), validated
// against the shared contract below so the test cannot drift from what the server serves.
import fx04Raw from "../test/fixtures/finding-fx04.json";
import fx04SummaryRaw from "../test/fixtures/finding-fx04-graph-summary.json";
// Correlation records for the same fixture run, copied verbatim from fixtures/runs/fx-04-env-read-via-bash.json.
import fx04CorrelationsRaw from "../test/fixtures/run-fx04-correlations.json";
import { FindingDetailPage } from "./FindingDetailPage";

const fx04 = FindingDetailResponse.parse(fx04Raw);
const fx04Summary = KeyRelationshipsSummary.parse(fx04SummaryRaw);
const fx04Correlations = EventCorrelation.array().parse(fx04CorrelationsRaw);

// --- network-bound children are stubbed; the page composition is what is under test ------------------------------

const graphProps: Array<{ highlightIds?: readonly string[] }> = [];
vi.mock("../components/graph/EvidenceGraphPanel", () => ({
  EvidenceGraphPanel: (p: { highlightIds?: readonly string[]; explanation?: ReactNode }) => {
    graphProps.push(p);
    return (
      <section aria-label="Evidence graph panel">
        Evidence graph ({(p.highlightIds ?? []).length} highlighted)
        {p.explanation}
      </section>
    );
  },
  GraphBody: () => <div aria-label="Compact graph" />,
}));
const askMounts = { count: 0 };
vi.mock("../components/askwitness/AskWitnessPanel", () => ({
  AskWitnessPanel: (p: { compact?: boolean; embedded?: boolean; maxSuggestions?: number }) => {
    useEffect(() => {
      askMounts.count += 1;
    }, []);
    return (
      <section aria-label={p.embedded ? "Contextual Ask Witness" : "Ask Witness panel"}>
        Ask Witness {p.compact ? "compact" : "full"}
        {p.embedded ? ` embedded, ${p.maxSuggestions} suggestions` : ""}
      </section>
    );
  },
}));
vi.mock("../components/safeguards/FindingSafeguardsPanel", () => ({
  FindingSafeguardsPanel: (p: { safeguards: Safeguard[] }) => <section aria-label="Safeguards panel">Safeguards ({p.safeguards.length})</section>,
}));

let detail: FindingDetailResponse = fx04;
let graph: { data?: FindingGraphResponse; isPending: boolean; isError: boolean; error: unknown } = { isPending: false, isError: false, error: null };
vi.mock("../api/queries", async (orig) => {
  const actual = await orig<typeof import("../api/queries")>();
  return {
    ...actual,
    useFinding: () => ({ isPending: false, isError: false, data: detail }),
    useFindingGraph: () => ({ ...graph, refetch: () => undefined }),
    useRunEvents: () => runEvents,
  };
});

function graphWith(summary: KeyRelationshipsSummary | undefined): FindingGraphResponse {
  return FindingGraphResponse.parse({
    finding_id: fx04.finding.id,
    source: summary?.source ?? "relational",
    detail: summary?.detail ?? "test",
    nodes: [],
    edges: [],
    truncated: false,
    insights: null,
    ...(summary ? { key_relationships: summary } : {}),
  });
}

let runEvents: { data?: { items: unknown[]; total: number; correlations: EventCorrelation[] }; isError: boolean } = { isError: false };

let location = "";
function LocationProbe() {
  const l = useLocation();
  location = `${l.pathname}${l.search}`;
  return null;
}

function renderPage(path = `/findings/${fx04.finding.id}`) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/findings/:id" element={<FindingDetailPage />} />
        </Routes>
        <LocationProbe />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

/**
 * Every panel the full technical view had before the redesign. "Reported vs observed" is now split across the Agent report
 * and Observed evidence categories (same lanes, same events, same empty-state wording), and its derived-events block
 * moved under Interpretation.
 */
const EXISTING_PANEL_HEADINGS = [
  "Why it was flagged",
  "Agent-reported events",
  "Independently observed events",
  "Derived by Underwatch (not raw evidence)",
  "Recommended next step",
  `Evidence references (${fx04.evidence.length})`,
  "Missing information",
  "Actions",
  "Status history",
  "Run",
];
/** The four categories of Full Technical Details (UI PRD, Addendum C), plus the graph subsection and safeguards. */
const CATEGORY_HEADINGS = ["Agent report", "Observed evidence", "Applicable policy", "Interpretation", "Evidence graph", "Safeguards"];

beforeEach(() => {
  detail = fx04;
  graph = { isPending: false, isError: false, error: null, data: graphWith(fx04Summary) };
  graphProps.length = 0;
  runEvents = { isError: false, data: { items: [], total: 0, correlations: fx04Correlations } };
  askMounts.count = 0;
  window.localStorage.clear();
  Element.prototype.scrollIntoView = vi.fn();
});
afterEach(() => vi.clearAllMocks());

describe("Finding page: Quick Read (default)", () => {
  it("shows the brief with Problem / Why it matters / How to fix and honest action statuses", () => {
    renderPage();
    expect(screen.getByRole("radio", { name: "Quick Read" })).toHaveAttribute("aria-checked", "true");
    const brief = screen.getByRole("region", { name: "Problem" }).closest("section#finding-brief")!;
    expect(brief).toBeTruthy();
    expect(screen.getByRole("region", { name: "Problem" })).toHaveTextContent(fx04.brief!.problem);
    expect(screen.getByRole("region", { name: "Why it matters" })).toHaveTextContent(fx04.brief!.why_it_matters);
    const fix = screen.getByRole("region", { name: "How to fix" });
    const rows = within(fix).getAllByRole("listitem");
    expect(rows).toHaveLength(fx04.brief!.how_to_fix.length);
    // Status labels come from stored records; a verified safeguard that is still not applied says so.
    expect(within(fix).getByText("Verified for tested scenario")).toBeInTheDocument();
    expect(within(fix).getAllByText("safeguard not applied").length).toBeGreaterThan(0);
    expect(within(fix).getByText("Proposed (recommendation only)")).toBeInTheDocument();
    expect(within(fix).queryByText(/^done$/i)).toBeNull();
    // Uncertainty and the same-records footnote.
    expect(screen.getByLabelText("Uncertainty")).toHaveTextContent("hand-labeled fixture records");
    expect(screen.getByText(/Built from the same records as the full report/)).toBeInTheDocument();
  });

  it("renders evidence chips that open the evidence inspector for the same record ids", () => {
    renderPage();
    const chips = within(screen.getByRole("group", { name: "Key evidence" })).getAllByRole("button");
    const es = fx04.brief!.evidence_summary;
    expect(chips.map((c) => c.getAttribute("title"))).toEqual([...es.key_event_ids, ...es.key_evidence_ids]);
  });

  it("shows key relationships with basis badges, links and an Ask about this issue entry (no inline chatbot)", () => {
    renderPage();
    const items = document.querySelectorAll("li[data-kind]");
    expect(items).toHaveLength(fx04Summary.items.length);
    expect(document.querySelector('li[data-kind="origin_chain"][data-basis="inferred"]')).not.toBeNull();
    expect(screen.getAllByText(/a hypothesis, not proof/).length).toBeGreaterThan(0);
    expect(screen.getAllByRole("link", { name: "Tool call" })[0]).toHaveAttribute("href", expect.stringContaining("/runs/run_fx_fx_04_env_read_via_bash?event="));
    expect(screen.getAllByRole("button", { name: "Ask about this issue" }).length).toBeGreaterThan(0);
    expect(screen.queryByLabelText("Ask Witness panel")).toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("puts the most relevant relationship near the top: after Problem, before Why it matters", () => {
    renderPage();
    const top = screen.getByTestId("relevant-relationship");
    expect(within(top).getByRole("heading", { name: "Most relevant relationship" })).toBeInTheDocument();
    expect(top).toHaveTextContent(fx04Summary.items[0]!.text);
    const problem = screen.getByRole("region", { name: "Problem" });
    const why = screen.getByRole("region", { name: "Why it matters" });
    expect(problem.compareDocumentPosition(top) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(top.compareDocumentPosition(why) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("omits the relevant-relationship block when no relationship data exists", () => {
    graph = { isPending: false, isError: false, error: null, data: graphWith(undefined) };
    renderPage();
    expect(screen.queryByTestId("relevant-relationship")).toBeNull();
  });

  it("shows the safeguard progression from stored safeguard rows", () => {
    renderPage();
    const line = screen.getByLabelText("Safeguard progression");
    expect(line.querySelector('[data-step="propose"]')).toHaveAttribute("data-state", "reached");
    expect(line.querySelector('[data-step="review"]')).toHaveAttribute("data-state", "not_reached");
    expect(line.querySelector('[data-step="verify"]')).toHaveAttribute("data-state", "reached");
    expect(line).toHaveTextContent("verified for tested scenario");
  });

  it("keeps status actions available and hides the detailed panels", () => {
    renderPage();
    expect(screen.getByRole("button", { name: "Confirm" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Actions" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Agent report" })).toBeNull();
    expect(screen.queryByLabelText("Evidence graph panel")).toBeNull();
  });

  it("is honest when the brief or the relationships summary is unavailable", () => {
    detail = { ...fx04, brief: undefined };
    graph = { isPending: false, isError: false, error: null, data: graphWith(undefined) };
    renderPage();
    expect(screen.getByText(/A concise brief could not be built for this finding/)).toBeInTheDocument();
    expect(screen.getByText(/did not return a key-relationships summary/)).toBeInTheDocument();
  });

  it("lists what Neo4j-only relationships could not be computed in fallback mode", () => {
    graph = {
      isPending: false,
      isError: false,
      error: null,
      data: graphWith({ ...fx04Summary, source: "relational", detail: "From Underwatch records, Neo4j unavailable.", unavailable: ["process ancestry back to the tool call"] }),
    };
    renderPage();
    expect(screen.getAllByText(/Neo4j unavailable/).length).toBeGreaterThan(0);
    expect(screen.getByText(/Not computed from this source: process ancestry/)).toBeInTheDocument();
  });
});

describe("Finding page: level switch", () => {
  it("switches to the full view, remembers the choice and writes ?view=full", async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(screen.getByRole("radio", { name: "Full Technical Details" }));
    expect(screen.getByRole("radio", { name: "Full Technical Details" })).toHaveAttribute("aria-checked", "true");
    expect(window.localStorage.getItem(FINDING_VIEW_STORAGE_KEY)).toBe("full");
    expect(location).toContain("view=full");
    await user.click(screen.getByRole("radio", { name: "Quick Read" }));
    expect(window.localStorage.getItem(FINDING_VIEW_STORAGE_KEY)).toBe("summary");
    expect(screen.getByRole("region", { name: "How to fix" })).toBeInTheDocument();
  });

  it("honours ?view=full and the stored preference", () => {
    const { unmount } = renderPage(`/findings/${fx04.finding.id}?view=full`);
    expect(screen.getByRole("heading", { name: "Agent report" })).toBeInTheDocument();
    unmount();
    window.localStorage.setItem(FINDING_VIEW_STORAGE_KEY, "full");
    renderPage();
    expect(screen.getByRole("heading", { name: "Agent report" })).toBeInTheDocument();
  });

  it("supports ?view=quick and arrow keys on the switch", async () => {
    window.localStorage.setItem(FINDING_VIEW_STORAGE_KEY, "full");
    renderPage(`/findings/${fx04.finding.id}?view=quick`);
    const quick = screen.getByRole("radio", { name: "Quick Read" });
    expect(quick).toHaveAttribute("aria-checked", "true");
    fireEvent.keyDown(quick, { key: "ArrowRight" });
    expect(screen.getByRole("radio", { name: "Full Technical Details" })).toHaveAttribute("aria-checked", "true");
    expect(location).toContain("view=full");
  });

  it("Open graph switches to the full view and highlights the relationship nodes", async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(screen.getByRole("button", { name: "Open graph" }));
    expect(screen.getByRole("radio", { name: "Full Technical Details" })).toHaveAttribute("aria-checked", "true");
    const last = graphProps[graphProps.length - 1]!;
    const firstStep = fx04Summary.items[0]!.steps[0]!.node_id;
    expect(last.highlightIds).toContain(firstStep);
    expect(Element.prototype.scrollIntoView).toHaveBeenCalled();
  });
});

describe("Finding page: reported vs observed comparison", () => {
  const BASH = "evt_d7305c0c4047f6456150ef74146e75c7b7dfeeeb8908bb2d8b48e1dbc5d6dd44";
  const READ = "evt_501a13269f27cbc1bcb942185e7d4480e623721f7e8ffe45577853dc2a834c5f";

  it("Quick Read shows one Agent said -> Kernel saw pair right under Problem, from stored correlations", async () => {
    const user = userEvent.setup();
    renderPage();
    const pair = screen.getByTestId("agent-said-kernel-saw");
    expect(within(pair).getByRole("heading", { name: "Agent said → Kernel saw" })).toBeInTheDocument();
    // The agent's Bash call, paired by the correlator with the kernel-observed read of .env.
    expect(pair).toHaveTextContent("Bash requested: cat .env");
    expect(pair).toHaveTextContent("read 33 bytes from .env");
    expect(within(pair).getByText("reported")).toBeInTheDocument();
    expect(within(pair).getByText("observed")).toBeInTheDocument();
    expect(pair).toHaveTextContent(/correlator \(derived\): Matched, high confidence/);
    const problem = screen.getByRole("region", { name: "Problem" });
    expect(problem.compareDocumentPosition(pair) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(pair.compareDocumentPosition(screen.getByTestId("relevant-relationship")) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // Each side opens the evidence inspector.
    await user.click(within(pair).getByRole("button", { name: /Inspect observed event/ }));
    expect(screen.getByLabelText("Evidence inspector")).toBeInTheDocument();
    await user.click(within(pair).getByRole("button", { name: "See full comparison" }));
    expect(screen.getByRole("radio", { name: "Full Technical Details" })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByTestId("reported-vs-observed")).toBeInTheDocument();
    expect(Element.prototype.scrollIntoView).toHaveBeenCalled();
  });

  it("Full view puts the side-by-side panel first, aligns correlated pairs and marks rows without a counterpart", async () => {
    const user = userEvent.setup();
    renderPage(`/findings/${fx04.finding.id}?view=full`);
    const panel = screen.getByTestId("reported-vs-observed");
    expect(within(panel).getByRole("heading", { name: "Reported vs observed" })).toBeInTheDocument();
    expect(within(panel).getByRole("columnheader", { name: "Agent reported" })).toBeInTheDocument();
    expect(within(panel).getByRole("columnheader", { name: "Independently observed" })).toBeInTheDocument();
    expect(panel.compareDocumentPosition(screen.getByRole("heading", { name: "Agent report" })) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    const rows = within(panel).getAllByTestId("comparison-row");
    const reportedCount = fx04.related_events.filter((e) => e.basis === "reported").length;
    expect(rows).toHaveLength(reportedCount); // every observed event here is correlated to a reported one
    const bashRow = rows.find((r) => within(r).queryByRole("button", { name: /Inspect reported event: Bash requested: cat .env/ }))!;
    expect(within(bashRow).getAllByRole("button", { name: /Inspect observed event/ })).toHaveLength(
      fx04Correlations.filter((c) => c.reported_event_id === BASH).length,
    );
    const readRow = rows.find((r) => within(r).queryByRole("button", { name: /Inspect reported event: Read requested: .env/ }))!;
    expect(readRow).toHaveTextContent("No matching observation: the correlator found none for this report.");
    expect(readRow).toHaveTextContent(fx04Correlations.find((c) => c.reported_event_id === READ)!.note!);
    await user.click(within(bashRow).getByRole("button", { name: /Inspect reported event/ }));
    expect(screen.getByLabelText("Evidence inspector")).toBeInTheDocument();
    // Category sections are unchanged below it.
    expect(screen.getByRole("heading", { name: "Agent-reported events" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Reported vs observed" })).toHaveAttribute("href", "#td-comparison");
  });

  it("marks observed events with no agent report, and says so honestly when correlations are unavailable", () => {
    runEvents = { isError: false, data: { items: [], total: 0, correlations: fx04Correlations.filter((c) => c.reported_event_id !== BASH) } };
    const { unmount } = renderPage(`/findings/${fx04.finding.id}?view=full`);
    expect(screen.getAllByText("Not reported by the agent: no correlated agent report.").length).toBe(
      fx04.related_events.filter((e) => e.basis === "observed").length,
    );
    unmount();
    runEvents = { isError: true };
    renderPage();
    const pair = screen.getByTestId("agent-said-kernel-saw");
    expect(pair).toHaveTextContent("Unknown: correlation records unavailable");
  });

  it("shows honest text when the finding has no reported or observed events", () => {
    detail = { ...fx04, related_events: [] };
    renderPage();
    expect(screen.getByTestId("agent-said-kernel-saw")).toHaveTextContent("No agent-reported or observed event is linked to this finding");
  });
});

describe("Finding page: Full Technical Details", () => {
  it("still renders every existing panel and feature", () => {
    renderPage(`/findings/${fx04.finding.id}?view=full`);
    for (const h of EXISTING_PANEL_HEADINGS) expect(screen.getByRole("heading", { name: h })).toBeInTheDocument();
    for (const h of CATEGORY_HEADINGS) expect(screen.getByRole("heading", { name: h })).toBeInTheDocument();
    // The relationship explanation sits inside the graph subsection, right after the graph.
    expect(within(screen.getByLabelText("Evidence graph panel")).getByRole("heading", { name: "Key relationships" })).toBeInTheDocument();
    expect(screen.getByRole("navigation", { name: "Technical details sections" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /Relevant policy/ })).toBeInTheDocument();
    expect(screen.getByLabelText("Evidence graph panel")).toBeInTheDocument();
    expect(screen.getByLabelText("Ask Witness panel")).toHaveTextContent("Ask Witness full");
    expect(screen.getByLabelText("Safeguards panel")).toHaveTextContent(`Safeguards (${fx04.safeguards.length})`);
    // Reported vs observed lanes and timeline links are intact.
    expect(screen.getByText("Agent-reported")).toBeInTheDocument();
    expect(screen.getAllByText("Independently observed").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByRole("link", { name: "view in timeline" }).length).toBe(fx04.related_events.length);
    expect(screen.getByRole("button", { name: "Confirm" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Create safeguard" })).toBeInTheDocument();
  });

  it("orders the categories Agent report, Observed evidence, Applicable policy, Interpretation with the graph first in Observed evidence", () => {
    renderPage(`/findings/${fx04.finding.id}?view=full`);
    const order = ["Agent report", "Observed evidence", "Evidence graph", "Independently observed events", "Applicable policy", "Interpretation"].map((n) =>
      screen.getByRole("heading", { name: n }),
    );
    for (let i = 1; i < order.length; i++) expect(order[i - 1]!.compareDocumentPosition(order[i]!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    const observed = screen.getByRole("region", { name: "Observed evidence" });
    expect(within(observed).getByLabelText("Evidence graph panel")).toBeInTheDocument();
    expect(within(screen.getByRole("region", { name: "Interpretation" })).getByLabelText("Ask Witness panel")).toHaveTextContent("Ask Witness full");
  });
});

describe("Finding page: Ask about this issue side panel", () => {
  it("opens on request, holds the compact per-finding Ask Witness, and closes without losing it", async () => {
    const user = userEvent.setup();
    renderPage();
    expect(screen.queryByRole("dialog")).toBeNull();
    const [headerButton] = screen.getAllByRole("button", { name: "Ask about this issue" });
    await user.click(headerButton!);
    const dialog = screen.getByRole("dialog", { name: "Ask about this issue" });
    expect(within(dialog).getByLabelText("Contextual Ask Witness")).toHaveTextContent("Ask Witness compact embedded, 4 suggestions");
    expect(headerButton).toHaveAttribute("aria-expanded", "true");
    expect(askMounts.count).toBe(1);

    await user.click(within(dialog).getByRole("button", { name: "Close Ask about this issue" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(headerButton).toHaveFocus();
    // Reopening shows the same instance: nothing was unmounted, so a typed question or answer is kept.
    await user.click(headerButton!);
    expect(screen.getByRole("dialog", { name: "Ask about this issue" })).toBeInTheDocument();
    expect(askMounts.count).toBe(1);
    // The finding page stays usable beside it.
    expect(screen.getByRole("region", { name: "Problem" })).toBeInTheDocument();
  });

  it("closes with Escape and keeps the panel across a switch to Full Technical Details", async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(screen.getAllByRole("button", { name: "Ask about this issue" })[0]!);
    await user.click(screen.getByRole("radio", { name: "Full Technical Details" }));
    expect(screen.getByRole("dialog", { name: "Ask about this issue" })).toBeInTheDocument();
    await user.keyboard("{Escape}");
    // Escape reaches the panel only when focus is inside it.
    screen.getByRole("heading", { name: "Ask about this issue" }).focus();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

describe("safeguardProgression", () => {
  it("never marks a step reached without a stored record", () => {
    expect(safeguardProgression([]).map((s) => s.state)).toEqual(["reached", "not_reached", "not_reached", "not_reached", "not_reached"]);
    const failed = { ...fx04.safeguards[0]!, approval_status: "approved" as const, verification_status: "failed_verification" as const };
    const steps = safeguardProgression([failed]);
    expect(steps.find((s) => s.key === "review")!.state).toBe("reached");
    expect(steps.find((s) => s.key === "verify")!.state).toBe("failed");
  });
});
