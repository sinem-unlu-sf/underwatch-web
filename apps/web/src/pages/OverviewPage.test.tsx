import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ASK_WITNESS_SUGGESTED_QUESTIONS, FindingsResponse, OverviewResponse, SafeguardsResponse, type FindingListItem, type RunListItem, type SafeguardListItem } from "@kw/schema";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fx04Raw from "../test/fixtures/finding-fx04.json";
import { OverviewPage, rankOpenFindings, safeguardAction } from "./OverviewPage";

// The Ask panel's investigation history is not under test here.
vi.mock("../api/queries", async (orig) => {
  const actual = await orig<typeof import("../api/queries")>();
  return {
    ...actual,
    useFindingInvestigations: () => ({ isPending: false, isError: false, data: { items: [] } }),
    useInvestigation: () => ({ isPending: false, isError: false, data: undefined }),
  };
});

/** A real captured finding detail response with a deterministic short read for the requested id. */
function detailWithShortRead(id: string) {
  const raw = structuredClone(fx04Raw) as Record<string, unknown> & { finding: Record<string, unknown>; run: { id: string } };
  return {
    ...raw,
    finding: { ...raw.finding, id },
    short_read: {
      short_read_version: "short-read/1",
      deterministic: true,
      finding_id: id,
      is_fixture: false,
      finding: `Short read sentence for ${id}.`,
      numbers: [{ text: `1 observed open for ${id}`, basis: "observed", evidence_ids: [] }],
      why: "The task did not need that file.",
      fix: "Deny the read; no safeguard proposed yet.",
      fix_status: "proposed",
      fix_status_label: "Proposed",
      fix_safeguard_id: null,
      fix_verification_run_id: null,
      word_count: 20,
      generated_from: { finding_id: id, run_id: raw.run.id, event_ids: [], evidence_ids: [], safeguard_ids: [], verification_run_ids: [] },
    },
  };
}

const T0 = "2026-10-17T01:00:00.000Z";
const T1 = "2026-10-17T02:00:00.000Z";
const T2 = "2026-10-17T03:00:00.000Z";

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
    ended_at: T1,
    status: "completed",
    coverage_status: "complete",
    created_at: T0,
    event_count: 10,
    finding_count: 1,
    open_finding_count: 1,
    max_open_severity: "high",
    ...over,
  };
}

function finding(id: string, over: Partial<FindingListItem> = {}): FindingListItem {
  return {
    id,
    run_id: "run_live1",
    is_fixture: false,
    category: "unreported_observed_action",
    title: `Finding ${id}`,
    description: `Why ${id} was flagged`,
    severity: "medium",
    confidence: "medium",
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
    run_label: "Run run_live1",
    ...over,
  };
}

function safeguard(id: string, over: Partial<SafeguardListItem> = {}): SafeguardListItem {
  return {
    id,
    finding_id: "fnd_a",
    is_fixture: false,
    type: "permission_rule",
    title: `Safeguard ${id}`,
    content: "deny Read(.env)",
    application_mechanism: "permissions.deny in .claude/settings.json",
    target_path: null,
    intended_effect: "Block .env reads",
    legitimate_workflow_impact: "None expected",
    approval_status: "approved",
    application_status: "applied",
    verification_status: "verified_for_tested_scenario",
    created_at: T0,
    approved_at: T0,
    approved_by: "reviewer",
    applied_at: T0,
    last_verification_run_id: null,
    finding_title: "Finding fnd_a",
    finding_status: "confirmed",
    run_id: "run_live1",
    last_verification: null,
    ...over,
  };
}

const totals = (n: number) => ({ runs: n, events: n, findings: n, safeguards: n, verification_runs: n });

function overview(over: Partial<OverviewResponse> = {}): OverviewResponse {
  return OverviewResponse.parse({
    generated_at: T2,
    data_mode: { fixture_runs: 1, live_runs: 1, contains_fixture_data: true },
    totals: totals(2),
    breakdown: { fixture: totals(1), live: totals(1) },
    recent_runs: { count: 2, items: [run("run_live1"), run("run_fx1", { is_fixture: true, coverage_status: "partial", label: "Fixture run" })] },
    runs_needing_review: { count: 1, items: [run("run_live1")] },
    new_findings: { count: 0, items: [] },
    confirmed_findings: { count: 0, items: [] },
    safeguards_awaiting_approval: { count: 0, items: [] },
    recent_verification_results: { count: 0, items: [] },
    observation_health: {
      overall: "degraded",
      components: [
        { id: "tetragon", name: "Kernel tracer", status: "connected", detail: "ok", configured_via: null },
        { id: "neo4j", name: "Neo4j", status: "degraded", detail: "slow responses", configured_via: "NEO4J_URI" },
      ],
    },
    ...over,
  });
}

// --- fetch mock --------------------------------------------------------------------------------------------------

let bodies: Record<string, unknown> = {};
let calls: string[] = [];

function reply(status: number, body: unknown): Response {
  const text = JSON.stringify(body);
  return { ok: status >= 200 && status < 300, status, text: async () => text } as unknown as Response;
}

beforeEach(() => {
  calls = [];
  bodies = {
    "/api/overview": overview(),
    "/api/findings": FindingsResponse.parse({
      items: [
        finding("fnd_low", { severity: "low", confidence: "high", created_at: T2, description: "", recommended_next_step: "Check the diff" }),
        finding("fnd_crit", { severity: "critical", confidence: "low", created_at: T0 }),
        finding("fnd_high_hi", { severity: "high", confidence: "high", created_at: T0 }),
        finding("fnd_high_lo", { severity: "high", confidence: "low", created_at: T1 }),
        finding("fnd_done", { severity: "critical", status: "resolved" }),
        finding("fnd_conf", { severity: "critical", status: "confirmed" }),
      ],
      total: 6,
    }),
    "/api/safeguards": SafeguardsResponse.parse({
      items: [
        safeguard("sg_ok"),
        safeguard("sg_prop", { approval_status: "proposed", application_status: "not_applied", verification_status: "not_tested", approved_at: null, approved_by: null, applied_at: null }),
        safeguard("sg_fail", { verification_status: "failed_verification" }),
        safeguard("sg_inc", { verification_status: "verification_inconclusive" }),
      ],
      total: 4,
    }),
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string) => {
      const url = new URL(input, "http://localhost");
      calls.push(url.pathname + url.search);
      const detail = /^\/api\/findings\/(fnd_[\w-]+)$/.exec(url.pathname);
      const body = bodies[url.pathname] ?? (detail ? detailWithShortRead(detail[1]!) : undefined);
      return body ? reply(200, body) : reply(404, { error: { code: "not_found", message: `no mock for ${url.pathname}` } });
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <OverviewPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("rankOpenFindings", () => {
  it("keeps only open statuses and orders by severity, then confidence, then recency", () => {
    const ranked = rankOpenFindings([
      finding("a", { severity: "low", confidence: "high" }),
      finding("b", { severity: "high", confidence: "low" }),
      finding("c", { severity: "high", confidence: "high" }),
      finding("d", { severity: "critical", status: "dismissed" }),
      finding("e", { severity: "high", confidence: "high", status: "under_review", created_at: T2 }),
    ]);
    expect(ranked.map((f) => f.id)).toEqual(["e", "c", "b", "a"]);
  });
});

describe("safeguardAction", () => {
  it("flags failed, inconclusive and proposed safeguards; verified + applied needs nothing", () => {
    expect(safeguardAction(safeguard("x"))).toBeNull();
    expect(safeguardAction(safeguard("x", { verification_status: "failed_verification" }))).toMatch(/failed/i);
    expect(safeguardAction(safeguard("x", { verification_status: "verification_inconclusive" }))).toMatch(/inconclusive/i);
    expect(safeguardAction(safeguard("x", { approval_status: "proposed" }))).toMatch(/proposed/i);
    expect(safeguardAction(safeguard("x", { application_status: "application_failed" }))).toMatch(/application failed/i);
  });
});

describe("OverviewPage", () => {
  it("shows the top 3 open findings as short reads with Full details and Ask, highest severity first", async () => {
    renderPage();
    const section = await screen.findByRole("region", { name: "Needs your attention" });
    const items = await within(section).findAllByTestId("attention-item");
    expect(items).toHaveLength(3);
    const titles = items.map((li) => within(li).getAllByRole("link")[0]!.textContent);
    expect(titles).toEqual(["Finding fnd_crit", "Finding fnd_high_hi", "Finding fnd_high_lo"]);
    expect(await within(items[0]!).findByRole("region", { name: "Short read" })).toHaveTextContent("Short read sentence for fnd_crit.");
    expect(within(items[0]!).getByRole("link", { name: /Full details/ })).toHaveAttribute("href", "/findings/fnd_crit");
    expect(within(items[0]!).getByRole("button", { name: "Ask" })).toBeInTheDocument();
    // Resolved and confirmed findings are not "open"; the 4th open finding is behind "View all".
    expect(within(section).queryByText("Finding fnd_done")).toBeNull();
    expect(within(section).getByText(/1 more open finding/)).toBeInTheDocument();
    expect(within(section).getByRole("link", { name: /All open findings/ })).toHaveAttribute("href", "/findings?status=open");
  });

  it("Ask opens a side panel with the short read, suggested questions and the chat input; closing keeps the Overview", async () => {
    const user = userEvent.setup();
    renderPage();
    const items = await screen.findAllByTestId("attention-item");
    await within(items[1]!).findByRole("region", { name: "Short read" });
    await user.click(within(items[1]!).getByRole("button", { name: "Ask" }));
    const panel = await screen.findByTestId("ask-about-issue-panel");
    expect(await within(panel).findByRole("region", { name: "Short read" })).toHaveTextContent("Short read sentence for fnd_high_hi.");
    expect(within(panel).getByRole("button", { name: ASK_WITNESS_SUGGESTED_QUESTIONS[0]! })).toBeInTheDocument();
    const input = within(panel).getByRole("textbox", { name: "Ask a question about this finding" });
    await user.type(input, "draft question");
    await user.click(within(panel).getByRole("button", { name: /Close Ask about this issue/ }));
    expect(panel).not.toBeVisible();
    expect(screen.getAllByTestId("attention-item")).toHaveLength(3);
    // Reopening the same finding keeps the typed question.
    await user.click(within(items[1]!).getByRole("button", { name: "Ask" }));
    expect(within(screen.getByTestId("ask-about-issue-panel")).getByRole("textbox", { name: "Ask a question about this finding" })).toHaveValue("draft question");
  });

  it("keeps runs, safeguards and verification off the Overview: one status line, one verification line, links elsewhere", async () => {
    renderPage();
    await screen.findByRole("region", { name: "Needs your attention" });
    expect(screen.queryByRole("region", { name: "Recent runs" })).toBeNull();
    expect(screen.queryByRole("region", { name: "Safeguards needing action" })).toBeNull();
    expect(screen.queryByText("Runs with open findings")).toBeNull();
    const status = screen.getByTestId("system-status");
    expect(status).toHaveTextContent(/Neo4j/);
    expect(status).toHaveTextContent(/1 degraded or error: Neo4j/);
    expect(within(status).getByRole("link", { name: /Settings/ })).toHaveAttribute("href", "/settings");
    expect(screen.getByTestId("latest-verification")).toHaveTextContent(/None completed yet/);
    const elsewhere = screen.getByTestId("elsewhere");
    expect(within(elsewhere).getByRole("link", { name: /Runs needing review 1/ })).toHaveAttribute("href", "/runs#needs-review");
    expect(within(elsewhere).getByRole("link", { name: /Safeguards awaiting approval 0/ })).toHaveAttribute("href", "/safeguards#needs-action");
    expect(screen.getByTestId("record-counts")).toHaveTextContent("(live 1 · fixture 1)");
    expect(screen.getByTestId("record-counts")).toHaveTextContent("FIXTURE");
    // The Overview no longer fetches the safeguards list (that section moved to the Safeguards page).
    expect(calls.some((c) => c.startsWith("/api/safeguards"))).toBe(false);
  });

  it("explains how to start a supervised run when nothing has been recorded", async () => {
    bodies["/api/overview"] = overview({
      data_mode: { fixture_runs: 0, live_runs: 0, contains_fixture_data: false },
      totals: totals(0),
      breakdown: { fixture: totals(0), live: totals(0) },
      recent_runs: { count: 0, items: [] },
      runs_needing_review: { count: 0, items: [] },
    });
    bodies["/api/findings"] = FindingsResponse.parse({ items: [], total: 0 });
    renderPage();
    expect(await screen.findByRole("heading", { name: "No runs recorded yet" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Start supervised run/ })).toHaveAttribute("href", "/runs");
    expect(screen.getByText("pnpm seed:fixtures")).toBeInTheDocument();
  });

  it("explains how to get new findings when runs exist but none are open", async () => {
    bodies["/api/findings"] = FindingsResponse.parse({ items: [finding("fnd_done", { status: "resolved" })], total: 1 });
    renderPage();
    expect(await screen.findByText("No open findings")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Start supervised run/ })).toHaveAttribute("href", "/runs");
  });

  it("loads once and never polls", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      renderPage();
      await screen.findByRole("region", { name: "Needs your attention" });
      await waitFor(() => expect(calls.filter((c) => c === "/api/findings?limit=500").length).toBe(1));
      await waitFor(() => expect(calls.filter((c) => /^\/api\/findings\/fnd_/.test(c)).length).toBe(3));
      const before = calls.length;
      await vi.advanceTimersByTimeAsync(5 * 60_000);
      expect(calls.length).toBe(before);
    } finally {
      vi.useRealTimers();
    }
  });
});
