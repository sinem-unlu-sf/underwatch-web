import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { FindingsResponse, RunEventsResponse, RunFindingsResponse, RunsResponse, type Event, type FindingListItem, type RunListItem } from "@kw/schema";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EvidenceExplorerPage } from "./EvidenceExplorerPage";

const T0 = "2026-10-17T01:00:00.000Z";
const T1 = "2026-10-17T01:00:05.000Z";
const T2 = "2026-10-17T01:00:09.000Z";
const evt = (c: string) => `evt_${c.repeat(64)}`;
const EVT_REPORTED = evt("a");
const EVT_OBSERVED = evt("b");
const EVT_OTHER_RUN = evt("c");

function run(id: string, over: Partial<RunListItem> = {}): RunListItem {
  return {
    id,
    is_fixture: false,
    label: `Run ${id}`,
    agent_type: "claude_code",
    adapter: "claude-code",
    task_description: "Fix the README typo",
    repository_id: null,
    repository_revision: null,
    policy_version: null,
    started_at: T0,
    ended_at: T2,
    status: "completed",
    coverage_status: "complete",
    created_at: T0,
    event_count: 2,
    finding_count: 1,
    open_finding_count: 1,
    max_open_severity: "high",
    ...over,
  };
}

function event(id: string, runId: string, over: Partial<Event> = {}): Event {
  return {
    id,
    run_id: runId,
    is_fixture: false,
    basis: "reported",
    source: "claude_code_hooks",
    source_native_key: id,
    source_sequence: null,
    event_type: "tool_call",
    timestamp: T0,
    process_id: null,
    parent_process_id: null,
    process_name: null,
    tool_name: "Read",
    tool_use_id: null,
    target_resource: ".env",
    outcome: "denied",
    evidence_id: null,
    attribution_confidence: null,
    collection_status: "complete",
    unavailable_fields: [],
    limitations: [],
    summary: `summary ${id.slice(0, 5)}`,
    raw_summary: null,
    ...over,
  };
}

function finding(id: string, runId: string, over: Partial<FindingListItem> = {}): FindingListItem {
  return {
    id,
    run_id: runId,
    is_fixture: false,
    category: "unreported_observed_action",
    title: `Finding ${id}`,
    description: "why",
    severity: "high",
    confidence: "high",
    status: "new",
    policy_id: null,
    policy_rule_id: null,
    recommended_next_step: "Review",
    missing_information: [],
    related_event_ids: [],
    evidence_ids: [],
    recurrence_of_finding_id: null,
    created_at: T0,
    updated_at: T0,
    run_label: `Run ${runId}`,
    ...over,
  };
}

let bodies: Record<string, unknown>;
let calls: string[];

function reply(status: number, body: unknown): Response {
  const text = JSON.stringify(body);
  return { ok: status >= 200 && status < 300, status, text: async () => text } as unknown as Response;
}

beforeEach(() => {
  calls = [];
  const fnd = finding("fnd_env", "run_live1", { related_event_ids: [EVT_OBSERVED], title: "Forbidden .env read" });
  bodies = {
    "/api/runs": RunsResponse.parse({ items: [run("run_live1"), run("run_fx1", { is_fixture: true, label: "Fixture run" })], total: 2 }),
    "/api/runs/run_live1/events": RunEventsResponse.parse({
      items: [
        event(EVT_REPORTED, "run_live1", { summary: "Agent called Read on .env", timestamp: T0 }),
        event(EVT_OBSERVED, "run_live1", {
          basis: "observed",
          source: "process_tracer",
          event_type: "file_read",
          outcome: "succeeded",
          tool_name: null,
          process_name: "cat",
          summary: "cat opened .env",
          timestamp: T1,
        }),
      ],
      total: 2,
      correlations: [],
    }),
    "/api/runs/run_fx1/events": RunEventsResponse.parse({
      items: [event(EVT_OTHER_RUN, "run_fx1", { is_fixture: true, basis: "derived", source: "kw_policy_engine", event_type: "policy_evaluation", outcome: "blocked", summary: "Fixture policy decision", timestamp: T2 })],
      total: 1,
      correlations: [],
    }),
    "/api/runs/run_live1/findings": RunFindingsResponse.parse({ items: [fnd], total: 1 }),
    "/api/findings": FindingsResponse.parse({ items: [fnd], total: 1 }),
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string) => {
      const url = new URL(input, "http://localhost");
      calls.push(url.pathname + url.search);
      const body = bodies[url.pathname];
      return body ? reply(200, body) : reply(404, { error: { code: "not_found", message: `no mock for ${url.pathname}` } });
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function Where() {
  const loc = useLocation();
  return <div data-testid="location">{loc.pathname + loc.search}</div>;
}

function renderAt(path = "/evidence") {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route
            path="/evidence"
            element={
              <>
                <EvidenceExplorerPage />
                <Where />
              </>
            }
          />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const table = () => screen.getByRole("table");

describe("EvidenceExplorerPage", () => {
  it("lists real events from all runs with their basis, and loads each run's events from the existing endpoint", async () => {
    renderAt();
    expect(await screen.findByText("Agent called Read on .env")).toBeInTheDocument();
    expect(screen.getByText("cat opened .env")).toBeInTheDocument();
    expect(screen.getByText("Fixture policy decision")).toBeInTheDocument();
    expect(calls).toContain("/api/runs/run_live1/events");
    expect(calls).toContain("/api/runs/run_fx1/events");
    // Fixture data stays labelled.
    expect(within(table()).getAllByText(/fixture/i).length).toBeGreaterThan(0);
  });

  it("filters by basis and by text, and offers to clear the filters", async () => {
    const user = userEvent.setup();
    renderAt();
    await screen.findByText("Agent called Read on .env");

    await user.selectOptions(screen.getByLabelText("Basis"), "observed");
    expect(screen.queryByText("Agent called Read on .env")).toBeNull();
    expect(screen.getByText("cat opened .env")).toBeInTheDocument();
    expect(screen.getByTestId("location").textContent).toContain("basis=observed");

    await user.click(screen.getAllByRole("button", { name: "Clear filters" })[0]!);
    await user.type(screen.getByRole("searchbox"), "policy");
    expect(screen.getByText("Fixture policy decision")).toBeInTheDocument();
    expect(screen.queryByText("cat opened .env")).toBeNull();
  });

  it("shows an honest empty state when no event matches", async () => {
    const user = userEvent.setup();
    renderAt();
    await screen.findByText("Agent called Read on .env");
    await user.type(screen.getByRole("searchbox"), "no-such-thing");
    expect(await screen.findByText("No events match these filters")).toBeInTheDocument();
  });

  it("opens a selected event in the evidence inspector with links to the run timeline and related findings", async () => {
    const user = userEvent.setup();
    renderAt("/evidence?run=run_live1");
    await user.click(await screen.findByText("cat opened .env"));

    expect(await screen.findByRole("complementary", { name: "Evidence inspector" })).toBeInTheDocument();
    expect(screen.getByTestId("location").textContent).toContain(`event=${EVT_OBSERVED}`);
    expect(screen.getByRole("link", { name: "Open in run timeline" })).toHaveAttribute("href", `/runs/run_live1?event=${EVT_OBSERVED}`);
    const related = await screen.findByRole("link", { name: "Forbidden .env read" });
    expect(related).toHaveAttribute("href", "/findings/fnd_env");
    // Only the chosen run was loaded.
    expect(calls).not.toContain("/api/runs/run_fx1/events");
  });

  it("shows the API error instead of an empty list when runs cannot be loaded", async () => {
    bodies = {};
    vi.stubGlobal("fetch", vi.fn(async () => reply(401, { error: { code: "unauthorized", message: "token required" } })));
    renderAt();
    await waitFor(() => expect(screen.queryByText("No runs recorded yet")).toBeNull());
    expect(await screen.findByText("token required")).toBeInTheDocument();
    expect(screen.getByText("Paste access token")).toBeInTheDocument();
  });

  it("Graph tab: picks a real finding and asks the existing graph endpoint for its neighbourhood", async () => {
    const user = userEvent.setup();
    renderAt("/evidence?tab=graph");
    const select = await screen.findByRole("combobox", { name: "Finding" });
    await waitFor(() => expect(select).not.toBeDisabled());
    await user.selectOptions(select, "fnd_env");
    expect(screen.getByTestId("location").textContent).toContain("finding=fnd_env");
    expect(screen.getByRole("link", { name: "Open finding" })).toHaveAttribute("href", "/findings/fnd_env");
    await waitFor(() => expect(calls.some((c) => c.startsWith("/api/findings/fnd_env/graph"))).toBe(true));
  });
});
