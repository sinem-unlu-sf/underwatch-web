import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ASK_WITNESS_SUGGESTED_QUESTIONS } from "@kw/schema";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { AskWitnessPanel } from "./AskWitnessPanel";

vi.mock("../../api/queries", async (orig) => {
  const actual = await orig<typeof import("../../api/queries")>();
  return {
    ...actual,
    useFindingInvestigations: () => ({
      isPending: false,
      isError: false,
      data: { items: [{ id: "inv_1", updated_at: "2026-10-17T01:00:00.000Z", last_question: "Why is this a problem?", turn_count: 1 }] },
    }),
    useInvestigation: () => ({ isPending: false, isError: false, data: { turns: [], evidence_index: [], ai: { available: true, detail: "" } } }),
  };
});

const finding = { id: "fnd_x", title: "A finding", severity: "high" as const, is_fixture: true };

function renderPanel(compact: boolean, extra: { embedded?: boolean; maxSuggestions?: number } = {}) {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <AskWitnessPanel finding={finding} onCreateSafeguard={() => undefined} compact={compact} {...extra} />
    </QueryClientProvider>,
  );
}

describe("AskWitnessPanel compact (summary view)", () => {
  it("shows only the input and suggested questions until the history is opened", async () => {
    const user = userEvent.setup();
    renderPanel(true);
    expect(screen.getByRole("textbox", { name: "Ask a question about this finding" })).toBeInTheDocument();
    for (const q of ASK_WITNESS_SUGGESTED_QUESTIONS) expect(screen.getByRole("button", { name: q })).toBeInTheDocument();
    expect(screen.queryByRole("combobox", { name: "Investigation" })).toBeNull();
    expect(screen.getByText(/1 earlier investigation on this finding/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Show previous answers" }));
    expect(screen.getByRole("combobox", { name: "Investigation" })).toBeInTheDocument();
  });

  it("is unchanged when not compact (full view)", () => {
    renderPanel(false);
    expect(screen.getByRole("combobox", { name: "Investigation" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Show previous answers" })).toBeNull();
  });

  it("in the contextual side panel shows 4 suggested questions with the rest under More questions, without card chrome", async () => {
    const user = userEvent.setup();
    renderPanel(true, { embedded: true, maxSuggestions: 4 });
    const group = screen.getByRole("group", { name: "Suggested questions" });
    expect(within(group).getAllByRole("button")).toHaveLength(4);
    expect(screen.queryByRole("heading", { name: "Ask Witness" })).toBeNull();
    expect(screen.getByRole("button", { name: "Create safeguard" })).toBeInTheDocument();
    await user.click(screen.getByText(/^More questions \(/));
    const more = screen.getByRole("group", { name: "More suggested questions" });
    expect(within(more).getAllByRole("button")).toHaveLength(ASK_WITNESS_SUGGESTED_QUESTIONS.length - 4);
  });
});
