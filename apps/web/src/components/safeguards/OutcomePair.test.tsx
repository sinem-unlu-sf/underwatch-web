import { deriveTaskOutcome, securityOutcomeFromCase, type RunOutcomes } from "@kw/schema";
import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { GraphVerificationOutcomes, OutcomePair } from "./OutcomePair";

const AT = "2026-10-17T03:00:00.000Z";
const H = { source: "verification-harness:git-diff", recorded_at: AT };
const blocked = securityOutcomeFromCase(
  // "blocked" needs an independent kernel enforcement record (event:...); agent-reported denials alone are unknown.
  { kind: "restricted", result: "pass", observed: "open of .env denied in-kernel (EPERM)", sources: ["artifact:aa#L4", "event:evt_kernel_eperm", "harness:canary-scan"] },
  { source: "verification-harness:tetragon+stream-json+canary-scan", recorded_at: AT },
);

function renderPair(o: Partial<RunOutcomes>) {
  return render(
    <OutcomePair
      outcomes={{
        security_outcome: blocked,
        task_outcome: deriveTaskOutcome([], H),
        reported_task_claim: null,
        outcome_origin: "recorded",
        ...o,
      }}
    />,
  );
}

describe("OutcomePair", () => {
  it("shows security and task outcomes side by side, each with its own basis and evidence", () => {
    renderPair({ task_outcome: deriveTaskOutcome([{ kind: "git_diff", passed: true, detail: "README.md typo fixed", evidence_ids: ["harness:git-diff"] }], H) });
    const sec = screen.getByTestId("security-outcome");
    const task = screen.getByTestId("task-outcome");
    expect(within(sec).getByText("Security: Blocked")).toBeInTheDocument();
    expect(within(sec).getByText("harness:canary-scan")).toBeInTheDocument();
    expect(within(sec).getByText(/basis: observed/)).toBeInTheDocument();
    expect(within(task).getByText("Task succeeded")).toBeInTheDocument();
    expect(within(task).getByText("harness:git-diff")).toBeInTheDocument();
    expect(screen.getByText(/A blocked action implies neither task success nor task failure/)).toBeInTheDocument();
  });

  it("blocked + failed task: both shown, task failure not hidden by the block", () => {
    renderPair({ task_outcome: deriveTaskOutcome([{ kind: "git_diff", passed: false, detail: "README.md unchanged", evidence_ids: ["harness:git-diff"] }], H) });
    expect(within(screen.getByTestId("security-outcome")).getByText("Security: Blocked")).toBeInTheDocument();
    expect(within(screen.getByTestId("task-outcome")).getByText("Task failed")).toBeInTheDocument();
  });

  it("agent claim without completion evidence: task unknown, claim shown separately as reported", () => {
    renderPair({
      reported_task_claim: {
        claim: "claimed_success",
        basis: "reported",
        source: "claude-code:stream-json result",
        recorded_at: AT,
        evidence_ids: ["artifact:aa#L9"],
        note: "",
      },
    });
    const task = screen.getByTestId("task-outcome");
    expect(within(task).getByText("Task outcome unknown")).toBeInTheDocument();
    expect(within(task).getByText(/basis: none/)).toBeInTheDocument();
    expect(within(task).queryByText("Task succeeded")).toBeNull();
    const claim = screen.getByTestId("reported-task-claim");
    expect(claim).toHaveTextContent("reported by the agent");
    expect(claim).toHaveTextContent("Not verified");
  });

  it("allowed action is labeled as allowed, independent of the task", () => {
    renderPair({
      security_outcome: securityOutcomeFromCase({ kind: "restricted", result: "fail", observed: "Read of .env succeeded", sources: ["artifact:aa#L4"] }, H),
      task_outcome: deriveTaskOutcome([{ kind: "git_diff", passed: false, detail: "README.md unchanged", evidence_ids: ["harness:git-diff"] }], H),
    });
    expect(within(screen.getByTestId("security-outcome")).getByText(/Security: Allowed/)).toBeInTheDocument();
    expect(within(screen.getByTestId("task-outcome")).getByText("Task failed")).toBeInTheDocument();
  });

  it("graph panel: renders both outcomes from flattened GraphNode props (comma-joined evidence)", () => {
    render(
      <GraphVerificationOutcomes
        props={{
          result: "verified_for_tested_scenario",
          security_outcome: "blocked",
          security_outcome_basis: "observed",
          security_outcome_source: "verification-harness:stream-json+canary-scan",
          security_outcome_evidence_ids: "artifact:aa#L4, harness:canary-scan",
          task_outcome: "unknown",
          task_outcome_basis: null,
          task_outcome_evidence_ids: "",
          reported_task_claim: "claimed_success",
          outcome_origin: "recorded",
        }}
      />,
    );
    expect(within(screen.getByTestId("security-outcome")).getByText("harness:canary-scan")).toBeInTheDocument();
    expect(within(screen.getByTestId("task-outcome")).getByText("Task outcome unknown")).toBeInTheDocument();
    expect(screen.getByTestId("reported-task-claim")).toHaveTextContent("Not verified");
    expect(screen.getByText(/A blocked action implies neither task success nor task failure/)).toBeInTheDocument();
  });

  it("a blocked security outcome always shows what blocked does and does not establish", () => {
    renderPair({});
    expect(screen.getByTestId("security-blocked-scope")).toHaveTextContent("every DETECTED attempt");
    expect(screen.getByTestId("security-blocked-scope")).toHaveTextContent("not proof that no secret content reached the agent");
  });

  it("graph panel: a node whose flat props claim task succeeded with basis reported is never shown as succeeded", () => {
    render(
      <GraphVerificationOutcomes
        props={{
          security_outcome: "blocked",
          security_outcome_basis: "observed",
          security_outcome_evidence_ids: "x",
          task_outcome: "succeeded",
          task_outcome_basis: "reported",
          task_outcome_evidence_ids: "",
        }}
      />,
    );
    expect(within(screen.getByTestId("task-outcome")).getByText("Task outcome unknown")).toBeInTheDocument();
    expect(screen.queryByText("Task succeeded")).not.toBeInTheDocument();
  });

  it("graph panel: a legacy node with legitimate_behavior_worked=true still shows task unknown", () => {
    render(<GraphVerificationOutcomes props={{ status: "completed", result: "verified_for_tested_scenario", prohibited_behavior_attempted: true, prohibited_behavior_blocked: true, legitimate_behavior_worked: true }} />);
    expect(within(screen.getByTestId("task-outcome")).getByText("Task outcome unknown")).toBeInTheDocument();
    expect(screen.getAllByText(/Legacy record/).length).toBeGreaterThan(0);
  });
});
