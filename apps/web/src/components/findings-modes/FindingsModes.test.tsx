import { QueryClient, QueryClientProvider, focusManager, onlineManager } from "@tanstack/react-query";
import {
  DigestResponse,
  FindingsSnapshotResponse,
  RunDetailResponse,
  RunFindingsResponse,
  TasksResponse,
  type FindingListItem,
  type SnapshotFinding,
  type TaskContext,
} from "@kw/schema";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FindingsPage } from "../../pages/FindingsPage";

// --- fixtures (validated against the shared contract so the tests cannot drift from it) ---------------------------

const T0 = "2026-10-17T01:00:00.000Z";
const T1 = "2026-10-17T02:00:00.000Z";
const TASK_A = "tsk_aaaaaaaaaaaaaaaaaaaaaaaa";
const TASK_B = "tsk_bbbbbbbbbbbbbbbbbbbbbbbb";
const TASK_EMPTY = "tsk_cccccccccccccccccccccccc";
const HASH1 = "1".repeat(64);
const HASH2 = "2".repeat(64);
const dataMode = { fixture_runs: 3, live_runs: 0, contains_fixture_data: true };

function snapFinding(id: string, over: Partial<SnapshotFinding> = {}): SnapshotFinding {
  return {
    id,
    run_id: "run_a1",
    run_label: "Run A1",
    task_key: TASK_A,
    is_fixture: true,
    category: "unreported_observed_action",
    title: `Finding ${id}`,
    severity: "high",
    confidence: "medium",
    status: "new",
    created_at: T0,
    updated_at: T0,
    missing_information: [],
    evidence_ids: ["evd_1"],
    related_event_ids: [],
    reported_outcomes: [],
    observed_outcomes: ["denied"],
    ...over,
  };
}

function snapshot(findings: SnapshotFinding[], id = HASH1, generated = T0): FindingsSnapshotResponse {
  return FindingsSnapshotResponse.parse({
    snapshot_id: id,
    generated_at: generated,
    data_mode: dataMode,
    findings,
    total: findings.length,
    truncated: false,
    completeness: { status: "no_known_gaps", caveats: [] },
  });
}

function runSummary(id: string, findingCount: number) {
  return {
    id,
    label: id.replace("run_", "Run ").toUpperCase(),
    is_fixture: true,
    status: "completed" as const,
    coverage_status: "partial" as const,
    started_at: T0,
    ended_at: T1,
    finding_count: findingCount,
    open_finding_count: findingCount,
    max_open_severity: findingCount > 0 ? ("high" as const) : null,
  };
}

function task(key: string, description: string, runs: ReturnType<typeof runSummary>[]): TaskContext {
  const findings = runs.reduce((n, r) => n + r.finding_count, 0);
  return {
    key,
    task_description: description,
    repository_id: "repo-demo",
    runs,
    finding_count: findings,
    open_finding_count: findings,
    max_open_severity: findings > 0 ? "high" : null,
    last_activity_at: T1,
    contains_fixture_data: true,
  };
}

const TASKS = TasksResponse.parse({
  items: [
    task(TASK_A, "Refactor auth module", [runSummary("run_a1", 1), runSummary("run_a2", 1)]),
    task(TASK_B, "Upgrade dependencies", [runSummary("run_b1", 1)]),
    task(TASK_EMPTY, "Write docs", [runSummary("run_c1", 0)]),
  ],
  total: 3,
  data_mode: dataMode,
});

function listItem(id: string, runId: string, title: string): FindingListItem {
  return {
    id,
    run_id: runId,
    is_fixture: true,
    category: "outcome_mismatch",
    title,
    description: "",
    severity: "medium",
    confidence: "high",
    status: "new",
    policy_id: null,
    policy_rule_id: null,
    recommended_next_step: "",
    missing_information: [],
    related_event_ids: [],
    evidence_ids: [],
    recurrence_of_finding_id: null,
    created_at: T0,
    updated_at: T0,
    run_label: runId,
  };
}

const RUN_FINDINGS: Record<string, FindingListItem[]> = {
  run_a1: [listItem("fnd_a1", "run_a1", "Agent claimed tests passed")],
  run_a2: [listItem("fnd_a2", "run_a2", "Unreported network call")],
  run_b1: [listItem("fnd_b1", "run_b1", "Lockfile changed silently")],
  run_c1: [],
};

function runDetail(id: string) {
  return RunDetailResponse.parse({
    run: {
      id,
      is_fixture: true,
      label: id,
      agent_type: "claude_code",
      adapter: null,
      task_description: "x",
      repository_id: "repo-demo",
      repository_revision: null,
      policy_version: null,
      started_at: T0,
      ended_at: T1,
      status: "completed",
      coverage_status: "partial",
      created_at: T0,
    },
    policy: null,
    coverage: null,
    counts: {
      events: 3,
      events_by_basis: { reported: 1, observed: 2, derived: 0 },
      evidence: 1,
      findings: RUN_FINDINGS[id]?.length ?? 0,
      findings_by_status: { new: 1, under_review: 0, unresolved: 0, confirmed: 0, resolved: 0, dismissed: 0 },
      open_findings: 1,
    },
  });
}

function digest(over: { newer?: boolean; version?: number; latest?: number } = {}): DigestResponse {
  const f = snapFinding("fnd_d1", { reported_outcomes: ["succeeded"], observed_outcomes: ["denied"] });
  const version = over.version ?? 1;
  return DigestResponse.parse({
    snapshot: {
      id: `fsn_v${version}`,
      kind: "digest",
      scope_key: "2026-10-17@UTC",
      version,
      created_at: T0,
      content_hash: version === 1 ? HASH1 : HASH2,
      content: {
        scope: { date: "2026-10-17", tz: "UTC", start: "2026-10-17T00:00:00.000Z", end: "2026-10-18T00:00:00.000Z" },
        summary: {
          total_findings: 1,
          total_runs: 1,
          needs_attention: ["fnd_d1"],
          blocked: ["fnd_d1"],
          uncertain: [],
          coverage_gaps: [{ kind: "coverage_partial", run_id: "run_a1", detail: "no network collector" }],
        },
        groups_by_task: [
          { key: TASK_A, kind: "task", label: "Refactor auth module", finding_ids: ["fnd_d1"], run_ids: ["run_a1"], open_count: 1, max_severity: "high" },
        ],
        groups_by_category: [
          {
            key: "unreported_observed_action",
            kind: "category",
            label: "Unreported observed action",
            finding_ids: ["fnd_d1"],
            run_ids: ["run_a1"],
            open_count: 1,
            max_severity: "high",
          },
        ],
        runs: [],
        findings: [f],
        completeness: { status: "has_gaps", caveats: [{ kind: "coverage_partial", run_id: "run_a1", detail: "no network collector" }] },
        contains_fixture_data: true,
      },
    },
    latest_version: over.latest ?? version,
    newer_available: over.newer ?? false,
    changes: over.newer
      ? { new_finding_ids: ["fnd_new"], updated_finding_ids: [], removed_finding_ids: [] }
      : { new_finding_ids: [], updated_finding_ids: [], removed_finding_ids: [] },
    checked_at: T1,
    data_mode: dataMode,
  });
}

// --- fetch mock --------------------------------------------------------------------------------------------------

type Handler = (url: URL, init?: RequestInit) => { status?: number; body: unknown };
let handlers: Array<[RegExp, Handler]> = [];
let calls: Array<{ method: string; url: string }> = [];

function reply(status: number, body: unknown): Response {
  const text = JSON.stringify(body);
  return { ok: status >= 200 && status < 300, status, text: async () => text } as unknown as Response;
}

function countCalls(pattern: RegExp) {
  return calls.filter((c) => pattern.test(c.url)).length;
}

beforeEach(() => {
  calls = [];
  handlers = [
    [/^\/api\/tasks/, () => ({ body: TASKS })],
    [/^\/api\/runs\/([^/?]+)\/findings$/, (u) => ({ body: RunFindingsResponse.parse({ items: RUN_FINDINGS[u.pathname.split("/")[3]!] ?? [], total: 0 }) })],
    [/^\/api\/runs\/([^/?]+)$/, (u) => ({ body: runDetail(u.pathname.split("/")[3]!) })],
  ];
  try {
    window.localStorage.clear();
  } catch {
    // ignore
  }
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string, init?: RequestInit) => {
      const url = new URL(input, "http://localhost");
      calls.push({ method: init?.method ?? "GET", url: url.pathname + url.search });
      for (const [re, h] of handlers) {
        if (re.test(url.pathname)) {
          const r = h(url, init);
          return reply(r.status ?? 200, r.body);
        }
      }
      return reply(404, { error: { code: "not_found", message: `no mock for ${url.pathname}` } });
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function LocationProbe() {
  const loc = useLocation();
  return <output data-testid="location">{loc.pathname + loc.search}</output>;
}

/** Worst-case client defaults (focus + reconnect refetch ON) to prove the findings views opt out per query. */
function renderPage(url: string) {
  const qc = new QueryClient({ defaultOptions: { queries: { refetchOnWindowFocus: true, refetchOnReconnect: true, staleTime: 0, retry: false } } });
  const utils = render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[url]}>
        <Routes>
          <Route path="/findings" element={<FindingsPage />} />
        </Routes>
        <LocationProbe />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return { ...utils, qc };
}

const location = () => screen.getByTestId("location").textContent ?? "";

// --- tests -------------------------------------------------------------------------------------------------------

describe("mode switching", () => {
  it("defaults to By Task, switching updates the URL and persists the preference", async () => {
    handlers.push([/^\/api\/findings\/snapshot$/, () => ({ body: snapshot([snapFinding("fnd_x")]) })]);
    const user = userEvent.setup();
    const first = renderPage("/findings");
    expect(screen.getByRole("radio", { name: "By Task" })).toHaveAttribute("aria-checked", "true");

    await user.click(screen.getByRole("radio", { name: "Current State" }));
    expect(location()).toContain("mode=current");
    expect(window.localStorage.getItem("kw.findings.mode")).toBe("current");
    expect(await screen.findByText("Finding fnd_x")).toBeInTheDocument();

    await user.click(screen.getByRole("radio", { name: "Daily Digest" }));
    expect(location()).toMatch(/mode=digest/);
    expect(location()).toMatch(/date=\d{4}-\d{2}-\d{2}/);
    expect(location()).toMatch(/tz=/);
    first.unmount();

    // New session without ?mode= restores the stored preference.
    renderPage("/findings");
    expect(screen.getByRole("radio", { name: "Daily Digest" })).toHaveAttribute("aria-checked", "true");
  });
});

describe("By Task", () => {
  it("shows only the selected task/run context and never unrelated tasks", async () => {
    renderPage(`/findings?mode=task&task=${TASK_A}&run=run_a1`);
    expect(await screen.findByText("Agent claimed tests passed")).toBeInTheDocument();
    expect(screen.queryByText("Unreported network call")).not.toBeInTheDocument();
    expect(screen.queryByText("Lockfile changed silently")).not.toBeInTheDocument();
    expect(countCalls(/\/api\/runs\/run_b1/)).toBe(0);
    expect(screen.getByText("1 agent-reported")).toBeInTheDocument();
    expect(screen.getByText("2 independently observed")).toBeInTheDocument();
  });

  it("lists all runs of the task when no run is selected, and remembers the task", async () => {
    renderPage(`/findings?mode=task&task=${TASK_A}`);
    expect(await screen.findByText("Agent claimed tests passed")).toBeInTheDocument();
    expect(await screen.findByText("Unreported network call")).toBeInTheDocument();
    expect(screen.queryByText("Lockfile changed silently")).not.toBeInTheDocument();
    expect(window.localStorage.getItem("kw.findings.lastTask")).toBe(TASK_A);
  });

  it("shows a clear empty state for a task without findings", async () => {
    renderPage(`/findings?mode=task&task=${TASK_EMPTY}`);
    expect(await screen.findByText("No findings for this task")).toBeInTheDocument();
    expect(screen.queryByText("Agent claimed tests passed")).not.toBeInTheDocument();
  });

  it("switching tasks offers a return to the previous task", async () => {
    const user = userEvent.setup();
    renderPage(`/findings?mode=task&task=${TASK_A}`);
    const list = await screen.findByRole("list", { name: "Task list" });
    await user.click(within(list).getByText("Upgrade dependencies"));
    expect(location()).toContain(`task=${TASK_B}`);
    expect(await screen.findByText("Lockfile changed silently")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /Return to previous task/ }));
    expect(location()).toContain(`task=${TASK_A}`);
  });
});

describe("Current State", () => {
  it("does not refetch on window focus, reconnect, or over time; only on Refresh", async () => {
    handlers.push([/^\/api\/findings\/snapshot$/, () => ({ body: snapshot([snapFinding("fnd_1")]) })]);
    const user = userEvent.setup();
    renderPage("/findings?mode=current");
    expect(await screen.findByText("Finding fnd_1")).toBeInTheDocument();
    const snap = /\/api\/findings\/snapshot/;
    expect(countCalls(snap)).toBe(1);

    act(() => {
      focusManager.setFocused(false);
      focusManager.setFocused(true);
      window.dispatchEvent(new Event("focus"));
      document.dispatchEvent(new Event("visibilitychange"));
      onlineManager.setOnline(false);
      onlineManager.setOnline(true);
    });
    vi.useFakeTimers();
    act(() => {
      vi.advanceTimersByTime(30 * 60_000);
    });
    vi.useRealTimers();
    await new Promise((r) => setTimeout(r, 20));
    expect(countCalls(snap)).toBe(1);
    focusManager.setFocused(undefined);

    await user.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(countCalls(snap)).toBe(2));
  });

  it('says "No changes" when the snapshot is identical and "N new, M updated" when it changed', async () => {
    let n = 0;
    handlers.push([
      /^\/api\/findings\/snapshot$/,
      () => {
        n += 1;
        if (n <= 2) return { body: snapshot([snapFinding("fnd_1")]) };
        return { body: snapshot([snapFinding("fnd_2"), snapFinding("fnd_1", { status: "confirmed", updated_at: T1 })], HASH2, T1) };
      },
    ]);
    const user = userEvent.setup();
    renderPage("/findings?mode=current");
    expect(await screen.findByText("Finding fnd_1")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Refresh" }));
    expect(await screen.findByText(/No changes since your last refresh/)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Refresh" }));
    expect(await screen.findByText(/1 new, 1 updated since your last refresh/)).toBeInTheDocument();
    expect(screen.getByText("Finding fnd_2")).toBeInTheDocument();
    expect(screen.getByText("New since last refresh")).toBeInTheDocument();
    expect(screen.getByText("Updated since last refresh")).toBeInTheDocument();
  });

  it("keeps the previous snapshot and explains the failure when Refresh fails", async () => {
    let n = 0;
    handlers.push([
      /^\/api\/findings\/snapshot$/,
      () => {
        n += 1;
        return n === 1 ? { body: snapshot([snapFinding("fnd_1")]) } : { status: 500, body: { error: { code: "internal_error", message: "database is locked" } } };
      },
    ]);
    const user = userEvent.setup();
    renderPage("/findings?mode=current");
    expect(await screen.findByText("Finding fnd_1")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Refresh" }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Refresh failed");
    expect(alert).toHaveTextContent("database is locked");
    expect(screen.getByText("Finding fnd_1")).toBeInTheDocument();
  });

  it("filters in the browser without fetching, and expanded rows keep reported vs observed distinct", async () => {
    handlers.push([
      /^\/api\/findings\/snapshot$/,
      () => ({ body: snapshot([snapFinding("fnd_1"), snapFinding("fnd_2", { severity: "low", status: "dismissed" })]) }),
    ]);
    const user = userEvent.setup();
    renderPage("/findings?mode=current");
    expect(await screen.findByText("Finding fnd_2")).toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText("Status"), "open");
    expect(screen.queryByText("Finding fnd_2")).not.toBeInTheDocument();
    expect(countCalls(/\/api\/findings\/snapshot/)).toBe(1);

    await user.click(screen.getByRole("button", { name: "Expand Finding fnd_1" }));
    expect(screen.getByText("No linked agent-reported event")).toBeInTheDocument();
    expect(screen.getByText("denied")).toBeInTheDocument();
    const open = screen.getByRole("link", { name: "Open investigation →" });
    expect(open.getAttribute("href")).toMatch(/^\/findings\/fnd_1\?from=%2Ffindings%3F/);
  });
});

describe("Daily Digest", () => {
  it("renders caveats (never claims completeness) and the newer-findings notice", async () => {
    handlers.push([/^\/api\/digests\/2026-10-17$/, () => ({ body: digest({ newer: true }) })]);
    renderPage("/findings?mode=digest&date=2026-10-17&tz=UTC");
    expect(await screen.findByText(/Not complete: 1 caveat/)).toBeInTheDocument();
    expect(screen.getByText(/Newer findings available \(1 new, 0 updated\)/)).toBeInTheDocument();
    expect(screen.getByLabelText("Digest summary")).toHaveTextContent("1 need attention · 1 blocked · 0 uncertain · 1 coverage caveat");
    expect(screen.getByText(/Snapshot v1 from/)).toBeInTheDocument();
    expect(calls.find((c) => c.url.startsWith("/api/digests/"))?.url).toBe("/api/digests/2026-10-17?tz=UTC");
  });

  it("Refresh posts explicitly and shows the new version; groups expand to findings with evidence links", async () => {
    handlers.push([
      /^\/api\/digests\/2026-10-17\/refresh$/,
      () => ({ body: { ...digest({ version: 2 }), created: true } }),
    ]);
    handlers.push([/^\/api\/digests\/2026-10-17$/, () => ({ body: digest({ newer: true }) })]);
    const user = userEvent.setup();
    renderPage("/findings?mode=digest&date=2026-10-17&tz=UTC");
    await screen.findByText(/Newer findings available/);
    await user.click(screen.getByRole("button", { name: "Refresh" }));
    expect(await screen.findByText(/Created snapshot v2/)).toBeInTheDocument();
    expect(screen.getByText(/Snapshot v2 from/)).toBeInTheDocument();
    expect(screen.queryByText(/Newer findings available/)).not.toBeInTheDocument();
    expect(calls.filter((c) => c.method === "POST").map((c) => c.url)).toEqual(["/api/digests/2026-10-17/refresh?tz=UTC"]);

    await user.click(screen.getByRole("button", { name: /Refactor auth module/ }));
    await user.click(screen.getByRole("button", { name: "Expand Finding fnd_d1" }));
    expect(screen.getByText("succeeded")).toBeInTheDocument();
    expect(screen.getByText("denied")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Linked events in run timeline" })).toHaveAttribute("href", "/runs/run_a1?finding_id=fnd_d1");
  });
});

describe("verification additions (refresh, context preservation, error states)", () => {
  it("By Task never refetches on its own; its explicit Refresh re-reads tasks and the open task's runs", async () => {
    const user = userEvent.setup();
    renderPage(`/findings?mode=task&task=${TASK_A}`);
    expect(await screen.findByText("Agent claimed tests passed")).toBeInTheDocument();
    expect(countCalls(/^\/api\/tasks/)).toBe(1);
    const runFindingsCalls = countCalls(/^\/api\/runs\/run_a1\/findings/);
    act(() => {
      focusManager.setFocused(false);
      focusManager.setFocused(true);
      onlineManager.setOnline(false);
      onlineManager.setOnline(true);
    });
    await new Promise((r) => setTimeout(r, 20));
    focusManager.setFocused(undefined);
    expect(countCalls(/^\/api\/tasks/)).toBe(1);
    expect(countCalls(/^\/api\/runs\/run_a1\/findings/)).toBe(runFindingsCalls);

    await user.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(countCalls(/^\/api\/tasks/)).toBe(2));
    await waitFor(() => expect(countCalls(/^\/api\/runs\/run_a1\/findings/)).toBe(runFindingsCalls + 1));
    expect(countCalls(/^\/api\/runs\/run_b1/)).toBe(0);
    expect(await screen.findByText("Updated")).toBeInTheDocument();
  });

  it("By Task refresh failure keeps the previous task list and says why", async () => {
    let n = 0;
    handlers[0] = [/^\/api\/tasks/, () => (++n === 1 ? { body: TASKS } : { status: 500, body: { error: { code: "internal_error", message: "db busy" } } })];
    const user = userEvent.setup();
    renderPage(`/findings?mode=task&task=${TASK_A}`);
    const list = await screen.findByRole("list", { name: "Task list" });
    await user.click(screen.getByRole("button", { name: "Refresh" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/Refresh failed.*db busy/);
    expect(within(list).getByText("Upgrade dependencies")).toBeInTheDocument();
    expect(screen.getByText("Agent claimed tests passed")).toBeInTheDocument();
  });

  it("Current State refresh keeps filters and expanded rows; switching modes and back shows the cached snapshot without fetching", async () => {
    let n = 0;
    handlers.push([
      /^\/api\/findings\/snapshot$/,
      () => {
        n += 1;
        return n === 1
          ? { body: snapshot([snapFinding("fnd_1"), snapFinding("fnd_2", { status: "dismissed" })]) }
          : { body: snapshot([snapFinding("fnd_1"), snapFinding("fnd_2", { status: "dismissed" }), snapFinding("fnd_3")], HASH2, T1) };
      },
    ]);
    const user = userEvent.setup();
    renderPage("/findings?mode=current");
    expect(await screen.findByText("Finding fnd_1")).toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText("Status"), "open");
    await user.click(screen.getByRole("button", { name: "Expand Finding fnd_1" }));
    await user.click(screen.getByRole("button", { name: "Refresh" }));
    expect(await screen.findByText(/1 new, 0 updated since your last refresh/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Collapse Finding fnd_1" })).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByLabelText("Status")).toHaveValue("open");
    expect(screen.queryByText("Finding fnd_2")).not.toBeInTheDocument();
    expect(screen.getByText("Finding fnd_3")).toBeInTheDocument();
    const snapCalls = countCalls(/\/api\/findings\/snapshot/);

    await user.click(screen.getByRole("radio", { name: "By Task" }));
    await user.click(screen.getByRole("radio", { name: "Current State" }));
    expect(await screen.findByText("Finding fnd_3")).toBeInTheDocument();
    expect(countCalls(/\/api\/findings\/snapshot/)).toBe(snapCalls);
  });

  it("Daily Digest shows an understandable error when the digest cannot be loaded, and does not refetch on focus", async () => {
    handlers.push([/^\/api\/digests\/2026-10-17$/, () => ({ status: 500, body: { error: { code: "internal_error", message: "boom" } } })]);
    renderPage("/findings?mode=digest&date=2026-10-17&tz=UTC");
    expect(await screen.findByText(/boom/)).toBeInTheDocument();
    act(() => {
      focusManager.setFocused(false);
      focusManager.setFocused(true);
    });
    await new Promise((r) => setTimeout(r, 20));
    focusManager.setFocused(undefined);
    expect(countCalls(/^\/api\/digests\//)).toBe(1);
    expect(calls.some((c) => c.method !== "GET")).toBe(false);
  });
});
