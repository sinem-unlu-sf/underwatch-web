import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { OverviewResponse, SafeguardsResponse, type RunListItem, type SafeguardListItem } from "@kw/schema";
import { render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RunsNeedingReviewSection } from "./RunsNeedingReview";
import { SafeguardsNeedingActionSection } from "./SafeguardsNeedingAction";

const T0 = "2026-10-17T01:00:00.000Z";
const totals = (n: number) => ({ runs: n, events: n, findings: n, safeguards: n, verification_runs: n });

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
    ended_at: T0,
    status: "completed",
    coverage_status: "complete",
    created_at: T0,
    event_count: 10,
    finding_count: 2,
    open_finding_count: 2,
    max_open_severity: "high",
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

let bodies: Record<string, unknown> = {};

beforeEach(() => {
  bodies = {
    "/api/overview": OverviewResponse.parse({
      generated_at: T0,
      data_mode: { fixture_runs: 1, live_runs: 1, contains_fixture_data: true },
      totals: totals(2),
      breakdown: { fixture: totals(1), live: totals(1) },
      recent_runs: { count: 0, items: [] },
      runs_needing_review: { count: 2, items: [run("run_live1"), run("run_fx1", { is_fixture: true, open_finding_count: 1 })] },
      new_findings: { count: 0, items: [] },
      confirmed_findings: { count: 0, items: [] },
      safeguards_awaiting_approval: { count: 0, items: [] },
      recent_verification_results: { count: 0, items: [] },
      observation_health: { overall: "connected", components: [] },
    }),
    "/api/safeguards": SafeguardsResponse.parse({
      items: [
        safeguard("sg_ok"),
        safeguard("sg_prop", { approval_status: "proposed", application_status: "not_applied", verification_status: "not_tested", approved_at: null, approved_by: null, applied_at: null }),
        safeguard("sg_fail", { verification_status: "failed_verification" }),
      ],
      total: 3,
    }),
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string) => {
      const url = new URL(input, "http://localhost");
      const body = bodies[url.pathname];
      const text = JSON.stringify(body ?? { error: { code: "not_found", message: "no mock" } });
      return { ok: !!body, status: body ? 200 : 404, text: async () => text } as unknown as Response;
    }),
  );
});

afterEach(() => vi.unstubAllGlobals());

function renderIt(node: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>{node}</MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("moved Overview panels", () => {
  it("Agent Runs > Needs review lists runs with open findings, live vs FIXTURE", async () => {
    renderIt(<RunsNeedingReviewSection />);
    const section = await screen.findByRole("region", { name: "Needs review" });
    const list = await within(section).findByRole("list", { name: "Runs needing review" });
    const rows = within(list).getAllByRole("listitem");
    expect(rows).toHaveLength(2);
    expect(within(rows[0]!).getByRole("link", { name: "Run run_live1" })).toHaveAttribute("href", "/runs/run_live1");
    expect(within(rows[0]!).getByText("2 open")).toBeInTheDocument();
    expect(within(rows[1]!).getByText("FIXTURE")).toBeInTheDocument();
  });

  it("Safeguards > needing action lists failed first and omits ones that need nothing", async () => {
    renderIt(<SafeguardsNeedingActionSection />);
    const section = await screen.findByRole("region", { name: "Safeguards needing action" });
    const list = await within(section).findByRole("list", { name: "Safeguards needing action" });
    const titles = within(list)
      .getAllByRole("link")
      .filter((a) => a.getAttribute("href")?.startsWith("/safeguards/"))
      .map((a) => a.textContent);
    expect(titles).toEqual(["Safeguard sg_fail", "Safeguard sg_prop"]);
    expect(await within(section).findByText("No completed verification runs")).toBeInTheDocument();
  });
});
