import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { FINDING_STATUS_TRANSITIONS, FindingStatus } from "@kw/schema";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { FINDING_ACTIONS, FindingActions } from "./FindingActions";

function renderActions(status: FindingStatus) {
  const qc = new QueryClient();
  return render(
    <QueryClientProvider client={qc}>
      <FindingActions findingId="fnd_test" runId="run_test" status={status} serverAllowed={FINDING_STATUS_TRANSITIONS[status]} />
    </QueryClientProvider>,
  );
}

describe("FindingActions", () => {
  it.each(FindingStatus.options)("enables exactly the shared-table transitions from %s", (status) => {
    renderActions(status);
    for (const a of FINDING_ACTIONS) {
      const button = screen.getByRole("button", { name: a.label });
      if (FINDING_STATUS_TRANSITIONS[status].includes(a.to)) expect(button).toBeEnabled();
      else expect(button).toBeDisabled();
    }
  });

  it("requires a note before dismissing", async () => {
    const user = userEvent.setup();
    renderActions("new");
    await user.click(screen.getByRole("button", { name: "Dismiss" }));
    const save = screen.getByRole("button", { name: /Save: Dismissed/ });
    expect(save).toBeDisabled();
    await user.type(screen.getByRole("textbox"), "False positive: expected test fixture access");
    expect(save).toBeEnabled();
  });

  it("does not require a note to confirm", async () => {
    const user = userEvent.setup();
    renderActions("new");
    await user.click(screen.getByRole("button", { name: "Confirm" }));
    expect(screen.getByRole("button", { name: /Save: Confirmed/ })).toBeEnabled();
  });
});
