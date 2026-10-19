import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ShortRead as ShortReadSchema, type ShortRead as ShortReadData } from "@kw/schema";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { MemoryRouter } from "react-router";
import { describe, expect, it, vi } from "vitest";
import { ShortRead } from "./ShortRead";

/** Shape-checked against the shared schema so the test cannot drift from the server contract. */
const EVT = `evt_${"a".repeat(64)}`;
const SR: ShortReadData = ShortReadSchema.parse({
  short_read_version: "short-read/1",
  deterministic: true,
  finding_id: "fnd_test_1",
  is_fixture: false,
  finding: "node opened /workspace/.env (protected secrets file) during run run_84b90e86…, despite policy rule R1 denying it.",
  numbers: [
    { text: "1 successful open of /workspace/.env by node (kernel-observed)", basis: "observed", evidence_ids: [EVT] },
    { text: "agent's own report: 0 actions on /workspace/.env", basis: "reported", evidence_ids: [] },
    { text: "3 findings in this run", basis: "derived", evidence_ids: ["run_84b90e86abcdef"] },
  ],
  why: "The permission rule only covers the agent's own tool calls; a node process opened the file directly.",
  fix: "Kernel enforcement on /workspace/.env - verified for the tested scenario (ver_160ef32b…).",
  fix_status: "verified_for_tested_scenario",
  fix_status_label: "Verified for tested scenario",
  fix_safeguard_id: "sg_kernel_1",
  fix_verification_run_id: "ver_160ef32b",
  word_count: 60,
  generated_from: { finding_id: "fnd_test_1", run_id: "run_84b90e86abcdef", event_ids: [EVT], evidence_ids: [], safeguard_ids: ["sg_kernel_1"], verification_run_ids: ["ver_160ef32b"] },
});

function wrap(ui: ReactNode) {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter>{ui}</MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("ShortRead", () => {
  it("renders the finding, numbers, why and fix with an honest status pill", () => {
    wrap(<ShortRead shortRead={SR} />);
    const region = screen.getByRole("region", { name: "Short read" });
    expect(region).toHaveTextContent("node opened /workspace/.env");
    expect(region).toHaveTextContent("1 successful open of /workspace/.env by node (kernel-observed)");
    expect(region).toHaveTextContent("agent's own report: 0 actions");
    expect(region).toHaveTextContent("3 findings in this run");
    expect(region).toHaveTextContent("a node process opened the file directly");
    expect(screen.getByText("Verified for tested scenario")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "sg_kernel_1" })).toHaveAttribute("href", "/safeguards/sg_kernel_1");
    // Default "Full details" goes to the finding page; no Ask button unless a callback is given.
    expect(screen.getByRole("link", { name: /Full details/ })).toHaveAttribute("href", "/findings/fnd_test_1");
    expect(screen.queryByRole("button", { name: /Ask/ })).toBeNull();
    expect(screen.queryByText("FIXTURE")).toBeNull();
  });

  it("calls the Ask, Full details and evidence callbacks", async () => {
    const user = userEvent.setup();
    const onAsk = vi.fn();
    const onShowFull = vi.fn();
    const onOpenEvidence = vi.fn();
    wrap(<ShortRead shortRead={SR} onAsk={onAsk} askLabel="Ask about this issue" onShowFull={onShowFull} onOpenEvidence={onOpenEvidence} />);
    await user.click(screen.getByRole("button", { name: "Ask about this issue" }));
    expect(onAsk).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole("button", { name: /Full details/ }));
    expect(onShowFull).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole("button", { name: `Open ${EVT}` }));
    expect(onOpenEvidence).toHaveBeenCalledWith(EVT);
    // Run ids link to the run page rather than the evidence drawer.
    expect(screen.getByTitle("run_84b90e86abcdef")).toHaveAttribute("href", "/runs/run_84b90e86abcdef");
  });

  it("labels fixture data and never shows a verified pill for a failed fix", () => {
    wrap(<ShortRead shortRead={{ ...SR, is_fixture: true, fix_status: "failed_verification", fix_status_label: "Failed verification" }} />);
    expect(screen.getByText("FIXTURE")).toBeInTheDocument();
    expect(screen.getByText("Failed verification")).toBeInTheDocument();
    expect(screen.queryByText("Verified for tested scenario")).toBeNull();
  });

  it("renders the slot after the finding sentence", () => {
    wrap(<ShortRead shortRead={SR} afterFinding={<p>Agent said nothing; Kernel saw an open</p>} />);
    expect(screen.getByText("Agent said nothing; Kernel saw an open")).toBeInTheDocument();
  });
});
