import { EVIDENCE_SUPPORT_LABELS, checkAskWitnessOutput, type EventBasis, type InvestigationTurn } from "@kw/schema";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { citationHref } from "../../api/scopedAsk";
import { AskWitnessDrawerProvider, AskWitnessLauncher, SCOPE_SUGGESTIONS, resetAskWitnessConversations, useAskWitnessDrawer } from "./AskWitnessDrawer";

const T = "2026-10-17T02:00:00.000Z";
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

const okResponse = (t: InvestigationTurn = turn()) => ({
  investigation: { id: t.investigation_id, scope: "workspace", finding_id: null, run_id: null, status: "active", created_at: T, updated_at: T },
  turn: t,
  evidence_index: evidenceIndex,
  replayed: false,
});

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

/** Fake API: POSTs answer from a queue; GET list returns no earlier investigations unless overridden. */
let fetchMock: ReturnType<typeof vi.fn>;
let postQueue: Response[];
let getHandler: (url: string) => Response;
const posts = () => fetchMock.mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method === "POST");
const postBody = (i: number) => JSON.parse((posts()[i]![1] as RequestInit).body as string);
const gets = () => fetchMock.mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method !== "POST").map(([u]) => u as string);
beforeEach(() => {
  resetAskWitnessConversations();
  window.sessionStorage.clear();
  postQueue = [];
  getHandler = () => json({ items: [] });
  fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === "POST") {
      const r = postQueue.shift();
      if (!r) throw new Error("unexpected POST");
      return r;
    }
    return getHandler(url);
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

function RunPageButton() {
  const d = useAskWitnessDrawer();
  return (
    <button type="button" onClick={() => d.open({ scope: "run", runId: RUN })}>
      Ask about this run
    </button>
  );
}

function renderAt(path: string) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route
            path="*"
            element={
              <AskWitnessDrawerProvider>
                <AskWitnessLauncher />
                <RunPageButton />
                <Where />
              </AskWitnessDrawerProvider>
            }
          />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const drawer = () => screen.queryByRole("dialog", { name: "Ask Witness" });
const launcher = () => screen.getByRole("button", { name: "Ask Witness" });

describe("Ask Witness drawer", () => {
  it("never opens by itself and opens only on click; Esc and Close close it", async () => {
    const user = userEvent.setup();
    renderAt("/");
    expect(drawer()).toBeNull();
    await act(async () => {
      await new Promise((r) => setTimeout(r, 30));
    });
    expect(drawer()).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();

    await user.click(launcher());
    expect(drawer()).not.toBeNull();
    // Opening looks up earlier conversations in this scope once (user-initiated), nothing else.
    await waitFor(() => expect(gets()).toEqual(["/api/investigations?scope=workspace"]));
    await user.keyboard("{Escape}");
    expect(drawer()).toBeNull();

    await user.click(launcher());
    await user.click(within(drawer()!).getByRole("button", { name: /Close/ }));
    expect(drawer()).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(posts()).toHaveLength(0);
  });

  it("defaults to All findings outside run pages and shows workspace suggestions", async () => {
    const user = userEvent.setup();
    renderAt("/findings");
    await user.click(launcher());
    const d = drawer()!;
    expect(within(d).getByRole("radio", { name: "All findings" })).toHaveAttribute("aria-checked", "true");
    expect(within(d).queryByRole("radio", { name: "This run" })).toBeNull();
    expect(d).toHaveTextContent("AI interprets records; it does not decide what happened");
    for (const q of SCOPE_SUGGESTIONS.workspace) expect(within(d).getByRole("button", { name: q })).toBeInTheDocument();
  });

  it("defaults to This run on a run page and posts to the run route", async () => {
    const user = userEvent.setup();
    postQueue.push(json(okResponse(turn({ investigation_id: "inv_run1", question: "What telemetry is missing?" }))));
    renderAt(`/runs/${RUN}`);
    await user.click(launcher());
    const d = drawer()!;
    expect(within(d).getByRole("radio", { name: "This run" })).toHaveAttribute("aria-checked", "true");
    for (const q of SCOPE_SUGGESTIONS.run) expect(within(d).getByRole("button", { name: q })).toBeInTheDocument();
    await user.click(within(d).getByRole("button", { name: "What telemetry is missing?" }));
    await screen.findByText(answer.summary);
    expect(posts()[0]![0]).toBe(`/api/runs/${RUN}/investigations`);
    expect(gets()).toEqual([`/api/runs/${RUN}/investigations`]);
    const body = postBody(0);
    expect(body.question).toBe("What telemetry is missing?");
    expect(typeof body.client_request_id).toBe("string");
    expect(body.investigation_id).toBeUndefined();
  });

  it("the run page button opens the drawer in run scope", async () => {
    const user = userEvent.setup();
    renderAt("/");
    expect(drawer()).toBeNull();
    await user.click(screen.getByRole("button", { name: "Ask about this run" }));
    expect(within(drawer()!).getByRole("radio", { name: "This run" })).toHaveAttribute("aria-checked", "true");
  });

  it("on a finding page links to the in-page panel instead of duplicating it", async () => {
    const user = userEvent.setup();
    renderAt("/findings/fnd_one");
    await user.click(launcher());
    const d = drawer()!;
    expect(within(d).getByRole("radio", { name: "This finding" })).toHaveAttribute("aria-checked", "true");
    expect(within(d).getByRole("link", { name: /Ask Witness panel/ })).toHaveAttribute("href", "/findings/fnd_one#ask-witness");
    expect(within(d).queryByRole("textbox")).toBeNull();
  });

  it("asks, renders support-labelled sections, keeps follow-ups in scope, and does not refetch in the background", async () => {
    const user = userEvent.setup();
    postQueue.push(json(okResponse()));
    postQueue.push(json(okResponse(turn({ id: "itn_2", client_request_id: "req-00000002", question: "And today?" }))));
    renderAt("/");
    await user.click(launcher());
    await user.type(screen.getByRole("textbox", { name: /all findings/ }), "What needs my attention?{Enter}");
    await screen.findByText(answer.summary);
    const d = drawer()!;
    expect(posts()[0]![0]).toBe("/api/investigations");
    expect(within(d).getByRole("region", { name: "Backed by observed evidence" })).toBeInTheDocument();
    expect(within(d).getAllByText(EVIDENCE_SUPPORT_LABELS.observed_evidence).length).toBeGreaterThan(0);
    expect(within(d).getAllByText(EVIDENCE_SUPPORT_LABELS.derived_only).length).toBeGreaterThan(0);
    expect(d).toHaveTextContent("AI-generated - interprets evidence, does not establish facts");
    expect(d).not.toHaveTextContent(/\bVerified\b/);

    await user.type(screen.getByRole("textbox", { name: /all findings/ }), "And today?{Enter}");
    await screen.findByText("And today?");
    const follow = postBody(1);
    expect(follow.investigation_id).toBe("inv_ws1");
    expect(posts()[1]![0]).toBe("/api/investigations");

    const calls = fetchMock.mock.calls.length;
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
      await new Promise((r) => setTimeout(r, 60));
    });
    expect(fetchMock.mock.calls.length).toBe(calls);
  });

  it("citation chips navigate to the run event, finding and safeguard pages", async () => {
    const user = userEvent.setup();
    postQueue.push(json(okResponse()));
    renderAt("/");
    await user.click(launcher());
    await user.click(screen.getByRole("button", { name: SCOPE_SUGGESTIONS.workspace[0]! }));
    await screen.findByText(answer.summary);
    await user.click(within(drawer()!).getAllByRole("button", { name: EVT })[0]!);
    expect(screen.getByTestId("location")).toHaveTextContent(`/runs/${RUN}?event=${EVT}`);
    await user.click(within(drawer()!).getAllByRole("button", { name: "fnd_one" })[0]!);
    expect(screen.getByTestId("location")).toHaveTextContent("/findings/fnd_one");
    await user.click(within(drawer()!).getAllByRole("button", { name: "sg_one" })[0]!);
    expect(screen.getByTestId("location")).toHaveTextContent("/safeguards/sg_one");
  });

  it("maps verification and digest citations", () => {
    expect(citationHref("ver_1", { evidence_id: "ver_1", kind: "verification_run", basis: null, source: null, timestamp: null, summary: "", run_id: null, finding_id: null, safeguard_id: "sg_9" })).toBe(
      "/safeguards/sg_9?verification=ver_1",
    );
    expect(citationHref("dg_1", { evidence_id: "dg_1", kind: "digest", basis: null, source: null, timestamp: null, summary: "", run_id: null, finding_id: null, safeguard_id: null })).toBe(
      "/findings?mode=digest",
    );
  });

  it.each([
    ["ai_unavailable", "unavailable", "ai& is unavailable"],
    ["ai_error", "timeout", "ai& request timed out"],
    ["invalid_output", "invalid_output", "ai& returned an invalid answer"],
  ] as const)("shows a %s turn with a retry that asks again in the same scope", async (status, code, title) => {
    const user = userEvent.setup();
    postQueue.push(json(okResponse(turn({ status, answer: null, error: { code, message: "Safe message." } }))));
    postQueue.push(json(okResponse(turn({ id: "itn_2", client_request_id: "req-00000002" }))));
    renderAt("/");
    await user.click(launcher());
    await user.click(screen.getByRole("button", { name: SCOPE_SUGGESTIONS.workspace[1]! }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(title);
    await user.click(within(alert).getByRole("button", { name: "Retry" }));
    await screen.findByText(answer.summary);
    expect(postBody(1).investigation_id).toBe("inv_ws1");
  });

  it("an HTTP failure keeps the question and retries with the same idempotency key", async () => {
    const user = userEvent.setup();
    postQueue.push(json({ error: { code: "ai_unavailable", message: "ai& is not reachable." } }, 503));
    postQueue.push(json(okResponse()));
    renderAt("/");
    await user.click(launcher());
    await user.click(screen.getByRole("button", { name: SCOPE_SUGGESTIONS.workspace[0]! }));
    expect(await screen.findByRole("alert")).toHaveTextContent("ai& is unavailable");
    await user.click(screen.getByRole("button", { name: "Retry" }));
    await screen.findByText(answer.summary);
    expect(postBody(1).client_request_id).toBe(postBody(0).client_request_id);
  });

  it("continues the latest earlier conversation in the scope (one list + one detail fetch)", async () => {
    getHandler = (url) =>
      url.includes("?scope=workspace")
        ? json({ items: [{ ...okResponse().investigation, turn_count: 1, last_question: "q" }] })
        : json({ investigation: okResponse().investigation, turns: [turn()], evidence_index: evidenceIndex, ai: { available: false, detail: "AIAND_API_KEY not set." } });
    const user = userEvent.setup();
    renderAt("/");
    await user.click(launcher());
    await screen.findByText(answer.summary);
    expect(screen.getByRole("status")).toHaveTextContent("ai& unavailable");
    expect(gets()).toEqual(["/api/investigations?scope=workspace", "/api/investigations/inv_ws1"]);
    postQueue.push(json(okResponse(turn({ id: "itn_2", client_request_id: "req-00000002", question: "More?" }))));
    await user.type(screen.getByRole("textbox", { name: /all findings/ }), "More?{Enter}");
    await screen.findByText("More?");
    expect(postBody(0).investigation_id).toBe("inv_ws1");
  });

  it("restores a conversation from this tab with a single fetch", async () => {
    window.sessionStorage.setItem("kw.askwitness.scoped", JSON.stringify({ workspace: "inv_ws1" }));
    getHandler = () => json({ investigation: okResponse().investigation, turns: [turn()], evidence_index: evidenceIndex, ai: { available: true, detail: "ok" } });
    const user = userEvent.setup();
    renderAt("/");
    expect(fetchMock).not.toHaveBeenCalled();
    await user.click(launcher());
    await screen.findByText(answer.summary);
    expect(gets()).toEqual(["/api/investigations/inv_ws1"]);
    await user.keyboard("{Escape}");
    await user.click(launcher());
    await waitFor(() => expect(screen.getByText(answer.summary)).toBeInTheDocument());
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
