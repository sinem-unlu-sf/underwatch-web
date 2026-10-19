import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { FindingsResponse, RunsResponse, SafeguardsResponse, type FindingListItem, type RunListItem, type SafeguardListItem } from "@kw/schema";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TOKEN_STORAGE_KEY } from "../../api/auth";
import { Layout } from "../Layout";
import { resetAskWitnessConversations } from "../askwitness/AskWitnessDrawer";
import { resetSectionMemory } from "./nav";
import { SIDEBAR_COLLAPSED_KEY } from "./Sidebar";

const T0 = "2026-10-17T01:00:00.000Z";

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
    event_count: 1,
    finding_count: 0,
    open_finding_count: 0,
    max_open_severity: null,
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
    description: "",
    severity: "high",
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
    application_mechanism: "permissions.deny",
    target_path: null,
    intended_effect: "Block .env reads",
    legitimate_workflow_impact: "None",
    approval_status: "proposed",
    application_status: "not_applied",
    verification_status: "not_tested",
    created_at: T0,
    approved_at: null,
    approved_by: null,
    applied_at: null,
    last_verification_run_id: null,
    finding_title: "Finding fnd_a",
    finding_status: "new",
    run_id: "run_live1",
    last_verification: null,
    ...over,
  };
}

let calls: string[] = [];
let authStatus = 200;
let workspaces: unknown[] = [];

function reply(status: number, body: unknown): Response {
  const text = JSON.stringify(body);
  return { ok: status >= 200 && status < 300, status, text: async () => text, json: async () => body, headers: new Headers({ "content-type": "application/json" }) } as unknown as Response;
}

const FINDINGS = FindingsResponse.parse({
  items: [finding("fnd_cred", { title: "Credential file read not reported" }), finding("fnd_net", { title: "Unreported network call", is_fixture: true })],
  total: 2,
});
const SAFEGUARDS = SafeguardsResponse.parse({ items: [safeguard("sg_env", { title: "Deny .env reads" })], total: 1 });

beforeEach(() => {
  calls = [];
  authStatus = 200;
  workspaces = [];
  resetSectionMemory();
  resetAskWitnessConversations();
  window.localStorage.clear();
  window.sessionStorage.clear();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string) => {
      const url = new URL(input, "http://localhost");
      calls.push(url.pathname + url.search);
      switch (url.pathname) {
        case "/api/auth/check":
          return authStatus === 200
            ? reply(200, { authenticated: true, actor: "local", mode: "token", detail: "ok" })
            : reply(authStatus, { error: { code: "unauthorized", message: "missing or invalid token" } });
        case "/api/workspaces":
          return reply(200, { items: workspaces });
        case "/api/findings":
          return reply(200, FINDINGS);
        case "/api/safeguards":
          return reply(200, SAFEGUARDS);
        case "/api/runs": {
          const q = url.searchParams.get("q")?.toLowerCase();
          const all = [run("run_live1", { label: "Refactor auth module" }), run("run_other", { label: "Docs update" })];
          const items = q ? all.filter((r) => `${r.id} ${r.label} ${r.task_description}`.toLowerCase().includes(q)) : all;
          return reply(200, RunsResponse.parse({ items, total: items.length }));
        }
        default:
          return reply(404, { error: { code: "not_found", message: `no mock for ${url.pathname}` } });
      }
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function Probe() {
  const loc = useLocation();
  return <div data-testid="location">{loc.pathname + loc.search}</div>;
}

function renderShell(path: string) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const page = (name: string) => (
    <>
      <h1>{name} page</h1>
      <Probe />
    </>
  );
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route element={<Layout />}>
            <Route path="overview" element={page("Overview")} />
            <Route path="findings" element={page("Findings")} />
            <Route path="findings/:id" element={page("Finding detail")} />
            <Route path="runs" element={page("Runs")} />
            <Route path="runs/:id" element={page("Run detail")} />
            <Route path="safeguards" element={page("Safeguards")} />
            <Route path="safeguards/:id" element={page("Safeguard detail")} />
            <Route path="evidence" element={page("Evidence")} />
            <Route path="ask" element={page("Ask")} />
            <Route path="settings" element={page("Settings")} />
          </Route>
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const primaryNav = () => screen.getByRole("navigation", { name: "Primary" });

describe("app shell navigation", () => {
  it("lists every section, including Evidence Explorer, Ask Witness and Settings, and navigates", async () => {
    const user = userEvent.setup();
    renderShell("/overview");
    const nav = primaryNav();
    for (const label of ["Overview", "Findings", "Agent Runs", "Evidence Explorer", "Ask Witness", "Safeguards", "Settings"]) {
      expect(within(nav).getByRole("link", { name: label })).toBeInTheDocument();
    }
    expect(within(nav).getByRole("link", { name: "Overview" })).toHaveAttribute("aria-current", "page");
    await user.click(within(nav).getByRole("link", { name: "Evidence Explorer" }));
    expect(screen.getByRole("heading", { name: "Evidence page" })).toBeInTheDocument();
    expect(within(primaryNav()).getByRole("link", { name: "Evidence Explorer" })).toHaveAttribute("aria-current", "page");
    await user.click(within(primaryNav()).getByRole("link", { name: "Ask Witness" }));
    expect(screen.getByRole("heading", { name: "Ask page" })).toBeInTheDocument();
  });

  it("keeps deep links working and marks the parent section active", async () => {
    renderShell("/runs/run_live1?event=evt_abc");
    expect(screen.getByRole("heading", { name: "Run detail page" })).toBeInTheDocument();
    expect(screen.getByTestId("location")).toHaveTextContent("/runs/run_live1?event=evt_abc");
    expect(within(primaryNav()).getByRole("link", { name: "Agent Runs" })).toHaveAttribute("aria-current", "page");
    const crumbs = screen.getByRole("navigation", { name: "Breadcrumb" });
    expect(within(crumbs).getByRole("link", { name: "Agent Runs" })).toHaveAttribute("href", "/runs");
    expect(within(crumbs).getByText("run_live1")).toHaveAttribute("aria-current", "page");
  });

  it("deep links to findings and safeguards resolve to their detail routes", () => {
    renderShell("/findings/fnd_cred");
    expect(screen.getByRole("heading", { name: "Finding detail page" })).toBeInTheDocument();
    expect(within(primaryNav()).getByRole("link", { name: "Findings" })).toHaveAttribute("aria-current", "page");
  });

  it("restores a section's URL filters when returning to it through the sidebar", async () => {
    const user = userEvent.setup();
    renderShell("/findings?status=new&severity=high");
    await user.click(within(primaryNav()).getByRole("link", { name: "Agent Runs" }));
    expect(screen.getByTestId("location")).toHaveTextContent("/runs");
    await user.click(within(primaryNav()).getByRole("link", { name: "Findings" }));
    expect(screen.getByTestId("location")).toHaveTextContent("/findings?status=new&severity=high");
  });
});

describe("sidebar collapse", () => {
  it("collapses to the icon rail, keeps accessible labels, and remembers the choice", async () => {
    const user = userEvent.setup();
    const { unmount } = renderShell("/overview");
    const aside = screen.getByRole("complementary", { name: "Sidebar" });
    expect(aside).toHaveAttribute("data-collapsed", "false");
    await user.click(screen.getByRole("button", { name: "Collapse sidebar" }));
    expect(aside).toHaveAttribute("data-collapsed", "true");
    expect(within(primaryNav()).getByRole("link", { name: "Findings" })).toBeInTheDocument();
    expect(window.localStorage.getItem(SIDEBAR_COLLAPSED_KEY)).toBe("1");
    unmount();
    renderShell("/overview");
    expect(screen.getByRole("complementary", { name: "Sidebar" })).toHaveAttribute("data-collapsed", "true");
  });

  it("toggles with the [ key, but not while typing", async () => {
    renderShell("/overview");
    const aside = screen.getByRole("complementary", { name: "Sidebar" });
    fireEvent.keyDown(window, { key: "[" });
    expect(aside).toHaveAttribute("data-collapsed", "true");
    const input = document.createElement("input");
    document.body.appendChild(input);
    fireEvent.keyDown(input, { key: "[" });
    expect(aside).toHaveAttribute("data-collapsed", "true");
    input.remove();
    fireEvent.keyDown(window, { key: "[" });
    expect(aside).toHaveAttribute("data-collapsed", "false");
  });
});

describe("command palette", () => {
  it("opens with Ctrl+K, searches real findings, runs and safeguards from the list APIs, and navigates", async () => {
    const user = userEvent.setup();
    renderShell("/overview");
    expect(calls.some((c) => c.startsWith("/api/findings"))).toBe(false); // nothing fetched until opened
    fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    const dialog = await screen.findByRole("dialog", { name: "Search Underwatch" });
    const input = within(dialog).getByRole("combobox");
    expect(input).toHaveFocus();
    await user.type(input, "credential");
    const option = await within(dialog).findByRole("option", { name: /Credential file read not reported/ });
    expect(within(dialog).queryByRole("option", { name: /Unreported network call/ })).not.toBeInTheDocument();
    expect(calls).toContain("/api/findings?limit=500");
    await user.click(option);
    expect(screen.queryByRole("dialog", { name: "Search Underwatch" })).not.toBeInTheDocument();
    expect(screen.getByTestId("location")).toHaveTextContent("/findings/fnd_cred");
  });

  it("uses the runs API text search and supports keyboard selection", async () => {
    const user = userEvent.setup();
    renderShell("/overview");
    await user.click(screen.getByRole("button", { name: "Search" }));
    const dialog = await screen.findByRole("dialog", { name: "Search Underwatch" });
    await user.type(within(dialog).getByRole("combobox"), "refactor");
    await waitFor(() => expect(calls).toContain("/api/runs?q=refactor&limit=6"));
    await within(dialog).findByRole("option", { name: /Refactor auth module/ });
    await waitFor(() => expect(within(dialog).getAllByRole("option")).toHaveLength(1));
    await user.keyboard("{Enter}");
    expect(screen.getByTestId("location")).toHaveTextContent("/runs/run_live1");
  });

  it("finds safeguards and shows an honest empty state; Escape closes", async () => {
    const user = userEvent.setup();
    renderShell("/overview");
    fireEvent.keyDown(window, { key: "k", metaKey: true });
    const dialog = await screen.findByRole("dialog", { name: "Search Underwatch" });
    const input = within(dialog).getByRole("combobox");
    await user.type(input, "deny .env");
    expect(await within(dialog).findByRole("option", { name: /Deny .env reads/ })).toBeInTheDocument();
    await user.clear(input);
    await user.type(input, "zzzz-nothing");
    expect(await within(dialog).findByText(/No findings, runs, safeguards or pages match/)).toBeInTheDocument();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: "Search Underwatch" })).not.toBeInTheDocument();
  });
});

describe("top bar", () => {
  it("shows the real workspace from GET /api/workspaces", async () => {
    workspaces = [{ id: "ws_demo", label: "demo-repo", root_path: "/tmp/demo-repo", kind: "demo", authorized_at: T0, status: "active" }];
    renderShell("/overview");
    expect(await screen.findByRole("button", { name: "Workspace: demo-repo" })).toBeInTheDocument();
  });

  it("local session control clears the stored token after confirmation, leading to the permission-denied screen", async () => {
    const user = userEvent.setup();
    window.localStorage.setItem(TOKEN_STORAGE_KEY, "secret-token-value");
    renderShell("/overview");
    await screen.findByRole("heading", { name: "Overview page" });
    await user.click(screen.getByRole("button", { name: "Local session" }));
    await user.click(await screen.findByRole("button", { name: "Clear stored token…" }));
    authStatus = 401;
    await act(async () => {
      await user.click(screen.getByRole("button", { name: "Clear token" }));
    });
    expect(window.localStorage.getItem(TOKEN_STORAGE_KEY)).toBeNull();
    expect(await screen.findByText("Permission denied")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Overview page" })).not.toBeInTheDocument();
  });
});
