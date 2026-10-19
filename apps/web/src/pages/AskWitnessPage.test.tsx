import { ASK_WITNESS_SUGGESTED_QUESTIONS, FindingsResponse, RunsResponse, checkAskWitnessOutput, type EventBasis, type FindingListItem, type InvestigationTurn, type RunListItem } from "@kw/schema";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SCOPE_SUGGESTIONS } from "../components/askwitness/AskWitnessDrawer";
import { AskWitnessPage } from "./AskWitnessPage";

const T = "2026-10-17T02:00:00.000Z";
const T_LATER = "2026-10-17T03:00:00.000Z";
const RUN = "run_demo1";
const EVT = `evt_${"a".repeat(64)}`;

const bases = new Map<string, EventBasis | null>([
  [EVT, "observed"],
  ["fnd_one", "derived"],
  ["sg_one", "derived"],
]);
const evidenceIndex = [
  { evidence_id: EVT, kind: "event", basis: "observed", source: "tetragon", timestamp: T, summary: "open .env denied", run_id: RUN },
  { evidence_id: "fnd_one", kind: "finding", basis: "derived", source: null, timestamp: T, summary: "Credential read attempt", run_id: RUN },
  { evidence_id: "sg_one", kind: "safeguard", basis: "derived", source: null, timestamp: T, summary: "Deny Read(.env)", run_id: null },
];

const answer = checkAskWitnessOutput(
  {
    summary: "One credential read was blocked; one safeguard is verified.",
    verified_facts: [
      { text: "The kernel observer saw open(.env) denied.", evidence_ids: [EVT] },
      { text: "Underwatch flagged a credential read attempt.", evidence_ids: ["fnd_one", "sg_one"] },
    ],
    hypotheses: [],
    unknowns: [{ text: "Network telemetry was not captured." }],
    evidence_references: [EVT],
    recommended_next_steps: [],
    recommended_safeguards: [],
    insufficient_evidence: false,
  },
  bases,
);

function turn(over: Partial<InvestigationTurn> = {}): InvestigationTurn {
  return {
    id: "itn_1",
    investigation_id: "inv_ws1",
    client_request_id: "req-00000001",
    question: "What needs my attention?",
    evidence_ids: [...bases.keys()],
    bundle_hash: "h",
    model: "test-model",
    prompt_version: "v1",
    status: "answered",
    answer,
    error: null,
    created_at: T,
    ...over,
  };
}

const investigation = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  scope_kind: "workspace",
  scope_id: null,
  finding_id: null,
  run_id: null,
  status: "active",
  created_at: T,
  updated_at: T,
  ...over,
});

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
    started_at: T,
    ended_at: T,
    status: "completed",
    coverage_status: "complete",
    created_at: T,
    event_count: 3,
    finding_count: 1,
    open_finding_count: 1,
    max_open_severity: "high",
    ...over,
  };
}

function finding(id: string, over: Partial<FindingListItem> = {}): FindingListItem {
  return {
    id,
    run_id: RUN,
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
    created_at: T,
    updated_at: T,
    run_label: `Run ${RUN}`,
    ...over,
  };
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

let gets: Record<string, unknown>;
let postQueue: Response[];
let fetchMock: ReturnType<typeof vi.fn>;
const posts = () => fetchMock.mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method === "POST");
const postUrl = (i: number) => posts()[i]![0] as string;
const postBody = (i: number) => JSON.parse((posts()[i]![1] as RequestInit).body as string);
const getUrls = () => fetchMock.mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method !== "POST").map(([u]) => u as string);

beforeEach(() => {
  window.sessionStorage.clear();
  window.localStorage.clear();
  postQueue = [];
  gets = {
    "/api/runs": RunsResponse.parse({ items: [run(RUN), run("run_fx1", { is_fixture: true, label: "Fixture run" })], total: 2 }),
    "/api/findings": FindingsResponse.parse({ items: [finding("fnd_one", { title: "Credential read attempt" })], total: 1 }),
    "/api/investigations": { items: [] },
    "/api/findings/fnd_one/investigations": { items: [] },
  };
  fetchMock = vi.fn(async (input: string, init?: RequestInit) => {
    if (init?.method === "POST") {
      const r = postQueue.shift();
      if (!r) throw new Error("unexpected POST");
      return r;
    }
    const url = new URL(input, "http://localhost");
    const body = gets[url.pathname];
    return body !== undefined ? json(body) : json({ error: { code: "not_found", message: `no mock for ${url.pathname}` } }, 404);
  });
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function Where() {
  const loc = useLocation();
  return <div data-testid="location">{loc.pathname + loc.search}</div>;
}

function renderAt(path = "/ask") {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route
            path="*"
            element={
              <>
                <AskWitnessPage />
                <Where />
              </>
            }
          />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("AskWitnessPage", () => {
  it("defaults to All findings, lists earlier investigations from the existing endpoint and never asks by itself", async () => {
    renderAt();
    expect(await screen.findByText("None yet.")).toBeInTheDocument();
    expect(getUrls()).toContain("/api/investigations?scope=workspace");
    for (const q of SCOPE_SUGGESTIONS.workspace) expect(screen.getByRole("button", { name: q })).toBeInTheDocument();
    expect(posts()).toHaveLength(0);
    expect(screen.getByText("AI · advisory")).toBeInTheDocument();
  });

  it("asks a workspace question, renders the validated answer with support labels, and records it in the URL", async () => {
    const user = userEvent.setup();
    postQueue.push(json({ investigation: investigation("inv_ws1"), turn: turn(), evidence_index: evidenceIndex, replayed: false }));
    gets["/api/investigations/inv_ws1"] = { investigation: investigation("inv_ws1"), turns: [turn()], evidence_index: evidenceIndex, ai: { available: true, detail: "ok" } };
    renderAt();
    await screen.findByText("None yet.");

    await user.type(screen.getByRole("textbox", { name: "Ask a question about all findings" }), "What needs my attention?");
    await user.click(screen.getByRole("button", { name: "Send" }));

    expect(await screen.findByText(answer.summary)).toBeInTheDocument();
    expect(postUrl(0)).toBe("/api/investigations");
    expect(postBody(0)).toMatchObject({ question: "What needs my attention?" });
    expect(typeof postBody(0).client_request_id).toBe("string");
    expect(screen.getByTestId("location").textContent).toContain("inv=inv_ws1");
    // Underwatch-assigned support labels stay visible next to the facts.
    expect(screen.getAllByText(/observed/i).length).toBeGreaterThan(0);
  });

  it("opens earlier investigations from the history list with their last question", async () => {
    const user = userEvent.setup();
    gets["/api/investigations"] = {
      items: [
        { ...investigation("inv_old"), turn_count: 1, last_question: "Older question" },
        { ...investigation("inv_new", { updated_at: T_LATER }), turn_count: 2, last_question: "Newer question" },
      ],
    };
    gets["/api/investigations/inv_new"] = { investigation: investigation("inv_new"), turns: [turn({ investigation_id: "inv_new" })], evidence_index: evidenceIndex, ai: { available: true, detail: "ok" } };
    gets["/api/investigations/inv_old"] = {
      investigation: investigation("inv_old"),
      turns: [turn({ id: "itn_2", investigation_id: "inv_old", question: "Older question", status: "ai_unavailable", answer: null, error: { code: "not_configured", message: "ai& is not configured" } })],
      evidence_index: [],
      ai: { available: false, detail: "No API key configured." },
    };
    renderAt();

    const history = await screen.findByRole("list", { name: "Investigation history" });
    const buttons = within(history).getAllByRole("button");
    expect(buttons[0]).toHaveTextContent("Newer question");
    // Most recent investigation opens by default.
    expect(await screen.findByText(answer.summary)).toBeInTheDocument();
    expect(buttons[0]).toHaveAttribute("aria-current", "true");

    await user.click(within(history).getByRole("button", { name: /Older question/ }));
    expect(await screen.findByText(/No API key configured\./)).toBeInTheDocument();
    expect(screen.getByTestId("location").textContent).toContain("inv=inv_old");
  });

  it("citations open the evidence inspector for events and navigate to safeguard pages", async () => {
    const user = userEvent.setup();
    gets["/api/investigations"] = { items: [{ ...investigation("inv_ws1"), turn_count: 1, last_question: "What needs my attention?" }] };
    gets["/api/investigations/inv_ws1"] = { investigation: investigation("inv_ws1"), turns: [turn()], evidence_index: evidenceIndex, ai: { available: true, detail: "ok" } };
    renderAt();
    await screen.findByText(answer.summary);

    await user.click(screen.getAllByRole("button", { name: EVT })[0]!);
    const inspector = await screen.findByRole("complementary", { name: "Evidence inspector" });
    expect(within(inspector).getByRole("link", { name: "Open event in run timeline" })).toHaveAttribute("href", `/runs/${RUN}?event=${EVT}`);
    await user.click(within(inspector).getByRole("button", { name: /Close/ }));
    await waitFor(() => expect(screen.queryByRole("complementary", { name: "Evidence inspector" })).toBeNull());

    await user.click(screen.getAllByRole("button", { name: "sg_one" })[0]!);
    expect(screen.getByTestId("location")).toHaveTextContent("/safeguards/sg_one");
  });

  it("finding scope: picks a real finding, uses the finding's investigations endpoint and its suggested questions", async () => {
    const user = userEvent.setup();
    postQueue.push(
      json({
        investigation: investigation("inv_f1", { scope_kind: "finding", scope_id: "fnd_one", finding_id: "fnd_one", run_id: RUN }),
        turn: turn({ investigation_id: "inv_f1", question: ASK_WITNESS_SUGGESTED_QUESTIONS[0] }),
        evidence_index: evidenceIndex,
        replayed: false,
      }),
    );
    gets["/api/investigations/inv_f1"] = {
      investigation: investigation("inv_f1", { scope_kind: "finding", scope_id: "fnd_one", finding_id: "fnd_one", run_id: RUN }),
      finding: { id: "fnd_one", title: "Credential read attempt", severity: "high", run_id: RUN, is_fixture: false },
      turns: [turn({ investigation_id: "inv_f1", question: ASK_WITNESS_SUGGESTED_QUESTIONS[0] })],
      evidence_index: evidenceIndex,
      ai: { available: true, detail: "ok" },
    };
    renderAt();
    await screen.findByText("None yet.");

    await user.selectOptions(screen.getByRole("combobox", { name: "Ask Witness scope" }), "finding");
    expect(screen.getByText("Choose a finding to ask about")).toBeInTheDocument();
    const select = screen.getByRole("combobox", { name: "Finding" });
    await waitFor(() => expect(select).not.toBeDisabled());
    await user.selectOptions(select, "fnd_one");

    expect(await screen.findByRole("link", { name: "Credential read attempt" })).toHaveAttribute("href", "/findings/fnd_one");
    await waitFor(() => expect(getUrls()).toContain("/api/findings/fnd_one/investigations"));
    await user.click(await screen.findByRole("button", { name: ASK_WITNESS_SUGGESTED_QUESTIONS[0] }));
    expect(await screen.findByText(answer.summary)).toBeInTheDocument();
    expect(postUrl(0)).toBe("/api/findings/fnd_one/investigations");
  });

  it("keeps a failed request visible inline with Retry, reusing the same request id", async () => {
    const user = userEvent.setup();
    postQueue.push(json({ error: { code: "internal_error", message: "database busy" } }, 500));
    postQueue.push(json({ investigation: investigation("inv_ws1"), turn: turn(), evidence_index: evidenceIndex, replayed: false }));
    gets["/api/investigations/inv_ws1"] = { investigation: investigation("inv_ws1"), turns: [turn()], evidence_index: evidenceIndex, ai: { available: true, detail: "ok" } };
    renderAt();
    await screen.findByText("None yet.");

    await user.click(screen.getByRole("button", { name: SCOPE_SUGGESTIONS.workspace[0]! }));
    expect(await screen.findByText(/database busy/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByText(answer.summary)).toBeInTheDocument();
    expect(postBody(1).client_request_id).toBe(postBody(0).client_request_id);
  });

  it("chat layout: empty state shows a headline + 4 prompt cards, the rail collapses, New chat starts a fresh conversation", async () => {
    const user = userEvent.setup();
    gets["/api/investigations"] = { items: [{ ...investigation("inv_ws1"), turn_count: 1, last_question: "What needs my attention?" }] };
    gets["/api/investigations/inv_ws1"] = { investigation: investigation("inv_ws1"), turns: [turn()], evidence_index: evidenceIndex, ai: { available: true, detail: "ok" } };
    renderAt();
    await screen.findByText(answer.summary);
    expect(screen.queryByText("What do you want to know?")).toBeNull();
    expect(screen.getByText("AI interprets records; it does not decide what happened")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /New chat/ }));
    expect(await screen.findByText("What do you want to know?")).toBeInTheDocument();
    expect(within(screen.getByRole("group", { name: "Suggested questions" })).getAllByRole("button")).toHaveLength(4);
    expect(screen.getByTestId("location").textContent).toContain("inv=new");

    await user.click(screen.getByRole("button", { name: "Hide conversations" }));
    expect(screen.queryByRole("navigation", { name: "Conversations" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Show conversations" }));
    expect(screen.getByRole("list", { name: "Investigation history" })).toBeInTheDocument();
    expect(posts()).toHaveLength(0);
  });
});
