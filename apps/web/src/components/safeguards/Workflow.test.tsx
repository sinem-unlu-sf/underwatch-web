import { MECHANISMS } from "@kw/schema";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { EnforcementPill, SafeguardWorkflow, workflowForListItem, workflowSteps } from "./Workflow";

const byId = (steps: ReturnType<typeof workflowSteps>) => Object.fromEntries(steps.map((s) => [s.id, s]));

describe("safeguard workflow (Investigate -> Propose -> Review -> Test -> Verify)", () => {
  it("a fresh proposal waits on review and is never shown as tested or verified", () => {
    const s = byId(workflowSteps({ lifecycle: "proposed", verification: "not_tested", testable: true }));
    expect(s.investigate!.state).toBe("done");
    expect(s.propose!.state).toBe("done");
    expect(s.review!.state).toBe("current");
    expect(s.test!.state).toBe("todo");
    expect(s.verify!.state).toBe("todo");
    expect(s.verify!.detail).toBe("Not verified");
  });

  it("a passing run is verified for the tested scenario only", () => {
    const s = byId(workflowSteps({ lifecycle: "applied", verification: "passed", testable: true, runCount: 2 }));
    expect(s.review!.detail).toBe("Approved · applied");
    expect(s.test!.detail).toMatch(/2 runs/);
    expect(s.verify!.state).toBe("done");
    expect(s.verify!.detail).toBe("Verified for the tested scenario only");
  });

  it("inconclusive stays inconclusive and failed stays failed", () => {
    expect(byId(workflowSteps({ lifecycle: "applied", verification: "inconclusive", testable: true })).verify!.state).toBe("inconclusive");
    expect(byId(workflowSteps({ lifecycle: "applied", verification: "failed", testable: true })).verify!.state).toBe("failed");
  });

  it("rejected and untestable safeguards are marked not applicable, not safe", () => {
    const r = byId(workflowSteps({ lifecycle: "rejected", verification: "not_tested", testable: true }));
    expect(r.review!.state).toBe("failed");
    expect(r.test!.state).toBe("off");
    const u = byId(workflowSteps({ lifecycle: "approved", verification: "not_tested", testable: false }));
    expect(u.test!.detail).toBe("Not testable in this build");
    expect(u.verify!.state).toBe("off");
  });

  it("derives the list-row workflow from the legacy status columns", () => {
    const input = workflowForListItem({ type: "claude_md_instruction", approval_status: "proposed", application_status: "not_applied", verification_status: "not_tested" });
    expect(input.lifecycle).toBe("proposed");
    expect(input.testable).toBe(MECHANISMS.claude_md_instruction.availability.status === "available");
  });

  it("renders every step with a text state, not colour alone", () => {
    render(<SafeguardWorkflow input={{ lifecycle: "applied", verification: "failed", testable: true }} label="Safeguard status" />);
    const list = screen.getByRole("list", { name: "Safeguard status" });
    expect(list).toHaveTextContent("Investigate");
    expect(list).toHaveTextContent("Verify: failed.");
    expect(list).toHaveTextContent("Failed verification");
  });

  it("labels CLAUDE.md as instruction only and permission rules as enforcing", () => {
    const { rerender } = render(<EnforcementPill m={MECHANISMS.claude_md_instruction} />);
    expect(screen.getByText("Instruction only (guidance)")).toBeInTheDocument();
    rerender(<EnforcementPill m={MECHANISMS.hook_policy} />);
    expect(screen.getByText("Text only in this build")).toBeInTheDocument();
  });
});
