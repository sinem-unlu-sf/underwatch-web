import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { FindingStatus, RunDetailResponse, RunEventsResponse, RunFindingsResponse, RunsResponse, type Event, type RunListItem } from "@kw/schema";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RunDetailPage } from "./RunDetailPage";
import { RunsPage } from "./RunsPage";

const T0 = "2026-10-17T01:00:00.000Z";
const T1 = "2026-10-17T01:05:00.000Z";
const EVT_R = `evt_${"a".repeat(64)}`;
const EVT_O = `evt_${"b".repeat(64)}`;

function runItem(id: string, over: Partial<RunListItem> = {}): RunListItem {
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
    ended_at: T1,
    status: "completed",
    coverage_status: "partial",
    created_at: T0,
    event_count: 2,
    finding_count: 0,
    open_finding_count: 0,
    max_open_severity: null,
    ...over,
  };
}

function event(id: string, over: Partial<Event>): Event {
  return {
    id,
    run_id: "run_live1",
    is_fixture: false,
    basis: "reported",
    source: "claude_code_hooks",
    source_native_key: id.slice(0, 12),
    source_sequence: 1,
    event_type: "file_read",
    timestamp: T0,
    process_id: null,
    parent_process_id: null,
    process_name: null,
    tool_name: null,
    tool_use_id: null,
    target_resource: "README.md",
    outcome: "allowed",
    evidence_id: null,
    attribution_confidence: null,
    collection_status: "complete",
    unavailable_fields: [],
    limitations: [],
    summary: `summary ${id.slice(0, 8)}`,
    raw_summary: null,
    ...over,
  } as Event;
}

let bodies: Record<string, unknown> = {};
let calls: string[] = [];

function reply(status: number, body: unknown): Response {
  const text = JSON.stringify(body);
  return { ok: status >= 200 && status < 300, status, text: async () => text } as unknown as Response;
}

beforeEach(() => {
  calls = [];
  // jsdom has no layout: the timeline scrolls the selected card into view.
  Element.prototype.scrollIntoView = vi.fn();
  const zeroStatus = Object.fromEntries(FindingStatus.options.map((s) => [s, 0]));
  bodies = {
    "/api/runs": RunsResponse.parse({
      items: [runItem("run_live1"), runItem("run_fx1", { is_fixture: true, label: "Fixture run", finding_count: 2, open_finding_count: 1, max_open_severity: "high" })],
      total: 2,
    }),
    "/api/runs/run_live1": RunDetailResponse.parse({
      run: {
        id: "run_live1",
        is_fixture: false,
        label: "Run run_live1",
        agent_type: "claude_code",
        adapter: "claude-code",
        task_description: "Fix the README typo",
        repository_id: null,
        repository_revision: null,
        policy_version: null,
        started_at: T0,
        ended_at: T1,
        status: "completed",
        coverage_status: "unknown",
        created_at: T0,
      },
      policy: null,
      coverage: null,
      counts: {
        events: 2,
        events_by_basis: { reported: 1, observed: 1, derived: 0 },
        evidence: 0,
        findings: 0,
        findings_by_status: zeroStatus,
        open_findings: 0,
      },
    }),
    "/api/runs/run_live1/events": RunEventsResponse.parse({
      items: [
        event(EVT_R, { basis: "reported", summary: "Agent says it read README.md" }),
        event(EVT_O, { basis: "observed", source: "kernel_tracer", summary: "Kernel saw open of .env", target_resource: ".env", timestamp: T1 }),
      ],
      total: 2,
      correlations: [],
    }),
    "/api/runs/run_live1/findings": RunFindingsResponse.parse({ items: [], total: 0 }),
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

function renderAt(path: string) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/runs" element={<RunsPage />} />
          <Route path="/runs/:id" element={<RunDetailPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("RunsPage", () => {
  it("lists runs with live / FIXTURE labels, findings and coverage, and links to each run", async () => {
    renderAt("/runs");
    const table = await screen.findByRole("table", { name: /agent runs/i });
    const rows = within(table).getAllByRole("row");
    expect(rows).toHaveLength(3); // header + 2
    expect(within(rows[1]!).getByText("live")).toBeTruthy();
    expect(within(rows[2]!).getByText("FIXTURE")).toBeTruthy();
    expect(within(rows[2]!).getByText("1 open")).toBeTruthy();
    expect(within(rows[1]!).getByRole("link", { name: "Run run_live1" }).getAttribute("href")).toBe("/runs/run_live1");
    expect(screen.getByRole("heading", { name: "2 runs" })).toBeTruthy();
  });

  it("keeps the Start supervised run panel with its read-only restrictions list", async () => {
    renderAt("/runs");
    expect(screen.getByRole("button", { name: /start supervised run/i })).toBeTruthy();
    expect(screen.getByText(/restrictions for this run/i)).toBeTruthy();
    expect(screen.getByText(/R1 deny/)).toBeTruthy();
    await screen.findByRole("table", { name: /agent runs/i });
  });

  it("sends filters to the API from the URL", async () => {
    renderAt("/runs?q=readme&fixture=exclude&has_findings=true");
    await screen.findByRole("table", { name: /agent runs/i });
    const runsCall = calls.find((c) => c.startsWith("/api/runs?"));
    expect(runsCall).toContain("q=readme");
    expect(runsCall).toContain("fixture=exclude");
    expect(runsCall).toContain("has_findings=true");
    expect(screen.getByRole("button", { name: /clear filters/i })).toBeTruthy();
  });
});

describe("RunDetailPage", () => {
  it("shows the two provenance lanes, unknown coverage, and the Ask about this run entry", async () => {
    renderAt("/runs/run_live1");
    const timeline = await screen.findByRole("list", { name: /agent-reported and independently observed/i });
    expect(within(timeline).getAllByRole("listitem")).toHaveLength(2);
    expect(within(timeline).getByText("Agent says it read README.md")).toBeTruthy();
    expect(within(timeline).getByText("Kernel saw open of .env")).toBeTruthy();
    expect(screen.getByText(/no coverage report was recorded/i)).toBeTruthy();
    expect(screen.getByRole("button", { name: /ask about this run/i })).toBeTruthy();
    expect(screen.getByText(/not proof of correct behavior/i)).toBeTruthy();
  });

  it("opens the evidence inspector from a ?event= deep link and closes it with Escape", async () => {
    renderAt(`/runs/run_live1?event=${EVT_O}`);
    const inspector = await screen.findByRole("complementary", { name: /evidence inspector/i });
    await waitFor(() => expect(within(inspector).getByText("Kernel saw open of .env")).toBeTruthy());
    expect(within(inspector).getByText(/no evidence record is attached/i)).toBeTruthy();
    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("complementary", { name: /evidence inspector/i })).toBeNull());
  });

  it("selecting a timeline event opens the inspector for it", async () => {
    renderAt("/runs/run_live1");
    const timeline = await screen.findByRole("list", { name: /agent-reported and independently observed/i });
    fireEvent.click(within(timeline).getByText("Agent says it read README.md"));
    const inspector = await screen.findByRole("complementary", { name: /evidence inspector/i });
    expect(within(inspector).getAllByText(EVT_R).length).toBeGreaterThan(0);
  });

  it("passes timeline filters from the URL to the events API", async () => {
    renderAt("/runs/run_live1?basis=observed");
    await screen.findByRole("list", { name: /agent-reported and independently observed/i });
    expect(calls.some((c) => c === "/api/runs/run_live1/events?basis=observed")).toBe(true);
  });
});
