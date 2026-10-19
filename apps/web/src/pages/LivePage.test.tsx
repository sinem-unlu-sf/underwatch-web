import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LiveFeedResponse } from "../api/live";
import { LivePage } from "./LivePage";

const T0 = "2026-10-17T05:00:00.000Z";

function reply(status: number, body: unknown): Response {
  const text = JSON.stringify(body);
  return { ok: status >= 200 && status < 300, status, text: async () => text } as unknown as Response;
}

function item(seq: number, lane: "agent" | "kernel", over: Partial<LiveFeedResponse["items"][number]> = {}) {
  return { seq, lane, at: T0, kind: "message" as const, text: `${lane} event ${seq}`, outcome: null, detail: null, ...over };
}

// The live feed is scripted as a sequence of responses keyed by the `after` value the client sends.
let liveByAfter: Record<number, LiveFeedResponse>;
let startResponse: unknown;
let findingsResponse: unknown;
let runDetailSupervisedStatus: string;
let calls: string[];

function startBody(runId: string) {
  return {
    run: { id: runId, is_fixture: false, label: null, agent_type: "claude_code", adapter: "claude-code", task_description: "t", repository_id: null, repository_revision: null, policy_version: null, started_at: T0, ended_at: null, status: "running", coverage_status: "unknown", created_at: T0 },
    supervised: { run_id: runId, client_request_id: "crid-00000001", workspace_id: null, task: "Fix the typo", model: "m", status: "running", stage: "agent_running", error: null, policy_sha256: null, workspace_snapshot_sha256: null, artifacts: [], capture: null, ingest: null, limitations: [], started_at: T0, ended_at: null },
    replayed: false,
  };
}

beforeEach(() => {
  calls = [];
  runDetailSupervisedStatus = "running";
  startResponse = startBody("run_live_x");
  findingsResponse = { items: [], total: 0 };
  // Default empty feed (overridden per test).
  liveByAfter = { 0: { run_id: "run_live_x", available: true, status: "starting", started_at: T0, items: [], alerts: [], next_after: 0, kernel: { observing: true, note: "Kernel observer active" } } };
  try {
    window.sessionStorage.clear();
  } catch {
    /* ignore */
  }
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string, init?: RequestInit) => {
      const url = new URL(input, "http://localhost");
      calls.push(url.pathname + url.search + (init?.method === "POST" ? " [POST]" : ""));
      if (url.pathname === "/api/runs" && init?.method === "POST") return reply(201, startResponse);
      if (url.pathname === "/api/runs/run_live_x/live") {
        const after = Number(url.searchParams.get("after") ?? 0);
        const keys = Object.keys(liveByAfter).map(Number).sort((a, b) => a - b);
        // Return the scripted response whose key is <= after and closest.
        const key = keys.filter((k) => k <= after).pop() ?? 0;
        return reply(200, liveByAfter[key] ?? liveByAfter[0]);
      }
      if (url.pathname === "/api/runs/run_live_x") {
        const sb = startBody("run_live_x") as any;
        return reply(200, {
          run: sb.run,
          policy: null,
          coverage: null,
          counts: { events: 0, events_by_basis: { reported: 0, observed: 0, derived: 0 }, evidence: 0, findings: 0, findings_by_status: { new: 0, under_review: 0, confirmed: 0, resolved: 0, dismissed: 0, unresolved: 0 }, open_findings: 0 },
          supervised: { ...sb.supervised, status: runDetailSupervisedStatus },
        });
      }
      if (url.pathname === "/api/runs/run_live_x/findings") return reply(200, findingsResponse);
      if (url.pathname === "/api/runs") return reply(200, { items: [], total: 0 });
      return reply(404, { error: { code: "not_found", message: `no mock for ${url.pathname}` } });
    }),
  );
  vi.useFakeTimers({ shouldAdvanceTime: true });
});

afterEach(() => {
  vi.runOnlyPendingTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={["/live"]}>
        <LivePage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

async function flush(ms = 1000) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

describe("LivePage", () => {
  it("does not poll the live endpoint while idle", async () => {
    renderPage();
    await flush(2500);
    expect(calls.some((c) => c.includes("/live"))).toBe(false);
    expect(screen.getByText(/No run yet/)).toBeInTheDocument();
  });

  it("starts a run, polls and appends agent + kernel items, renders alerts, then shows findings when finished", async () => {
    liveByAfter = {
      0: { run_id: "run_live_x", available: true, status: "running", started_at: T0, items: [item(1, "agent", { text: "Reading README.md" }), item(2, "kernel", { text: "open(README.md)", kind: "file", outcome: "allowed" })], alerts: [], next_after: 2, kernel: { observing: true, note: "Kernel observer active" } },
      2: {
        run_id: "run_live_x",
        available: true,
        status: "running",
        started_at: T0,
        items: [item(3, "agent", { text: "Editing README.md" }), item(4, "kernel", { text: "open(.env)", kind: "file", outcome: "denied" })],
        alerts: [{ seq: 5, at: T0, severity: "high", rule: "R1", source: "kernel", text: "Kernel observed an attempt to read .env" }],
        next_after: 5,
        kernel: { observing: true, note: "Kernel observer active" },
      },
      5: { run_id: "run_live_x", available: true, status: "finished", started_at: T0, items: [], alerts: [], next_after: 5, kernel: { observing: true, note: "Kernel observer active" } },
    };
    findingsResponse = { items: [{ id: "fnd_abc", run_id: "run_live_x", run_label: null, is_fixture: false, category: "permission_violation", title: "Attempted secret read", description: "d", severity: "high", confidence: "high", status: "confirmed", policy_id: null, policy_rule_id: "R1", recommended_next_step: "x", missing_information: [], related_event_ids: [], evidence_ids: [], recurrence_of_finding_id: null, created_at: T0, updated_at: T0 }], total: 1 };

    renderPage();
    const textarea = screen.getByLabelText("Task for the coding agent");
    fireEvent.change(textarea, { target: { value: "Fix the typo in README" } });
    fireEvent.click(screen.getByRole("button", { name: "Run" }));

    await waitFor(() => expect(calls.some((c) => c.includes("[POST]"))).toBe(true));
    // First poll: after=0 returns seq 1 & 2.
    await flush(1000);
    await waitFor(() => expect(screen.getByText("Reading README.md")).toBeInTheDocument());
    expect(within(screen.getByTestId("lane-agent")).getByText("Reading README.md")).toBeInTheDocument();
    expect(within(screen.getByTestId("lane-kernel")).getByText("open(README.md)")).toBeInTheDocument();

    // Second poll: after=2 returns seq 3 & 4 plus an alert.
    await flush(1000);
    await waitFor(() => expect(screen.getByText("Editing README.md")).toBeInTheDocument());
    expect(screen.getByText("Kernel observed an attempt to read .env")).toBeInTheDocument();
    expect(screen.getByText("kernel-observed")).toBeInTheDocument();
    expect(screen.getByText("rule R1")).toBeInTheDocument();

    // Items from both polls are retained (appended, not replaced).
    expect(screen.getByText("Reading README.md")).toBeInTheDocument();
    expect(screen.getByText("open(.env)")).toBeInTheDocument();

    // Third poll: finished -> stop polling, settle ingestion, show findings.
    runDetailSupervisedStatus = "complete";
    await flush(1000);
    await waitFor(() => expect(screen.getByText("Run finished")).toBeInTheDocument());
    await flush(2000);
    await waitFor(() => expect(screen.getByText("Attempted secret read")).toBeInTheDocument());
    expect(screen.getByRole("link", { name: "Open run" })).toHaveAttribute("href", "/runs/run_live_x");

    // Polling has stopped: no further /live calls after finish.
    const liveCallsAtFinish = calls.filter((c) => c.includes("/live")).length;
    await flush(3000);
    expect(calls.filter((c) => c.includes("/live")).length).toBe(liveCallsAtFinish);
  });

  it("shows an honest notice when the run has no live stream", async () => {
    liveByAfter = { 0: { run_id: "run_live_x", available: false, status: "running", started_at: null, items: [], alerts: [], next_after: 0, kernel: { observing: false, note: "" } } };
    renderPage();
    fireEvent.change(screen.getByLabelText("Task for the coding agent"), { target: { value: "Do a thing" } });
    fireEvent.click(screen.getByRole("button", { name: "Run" }));
    await waitFor(() => expect(calls.some((c) => c.includes("[POST]"))).toBe(true));
    await flush(1000);
    await waitFor(() => expect(screen.getByText("No live stream for this run")).toBeInTheDocument());
    expect(screen.getByRole("link", { name: "Open the run" })).toHaveAttribute("href", "/runs/run_live_x");
  });
});
