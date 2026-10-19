import type { Event, EventCorrelation } from "@kw/schema";
import { describe, expect, it } from "vitest";
import { buildComparisonRows, focusTargetsOf, pickKeyPair } from "./ReportedVsObserved";

const RUN = "run_live";
const ev = (id: string, basis: Event["basis"], event_type: Event["event_type"], target: string | null, t: string): Event =>
  ({ id, run_id: RUN, basis, event_type, target_resource: target, timestamp: t }) as unknown as Event;
const cor = (id: string, reported: string, observed: string, match: EventCorrelation["match"]): EventCorrelation =>
  ({ id, run_id: RUN, reported_event_id: reported, observed_event_id: observed, match, confidence: "high", note: "", is_fixture: false }) as unknown as EventCorrelation;

// Mirrors the live finding: it cites the agent's tool result and a derived policy evaluation of /workspace/.env, but not
// the kernel observations the correlator matched to that tool result.
const toolResult = ev("evt_tool_result", "reported", "tool_result", "node show_env.js", "2026-10-17T03:00:01Z");
const policyEval = ev("evt_policy", "derived", "policy_evaluation", "/workspace/.env", "2026-10-17T03:00:02Z");
const kernelOpen = ev("evt_kernel_open", "observed", "file_open", "/workspace/.env", "2026-10-17T03:00:01Z");
const kernelExec = ev("evt_kernel_exec", "observed", "process_exec", "node", "2026-10-17T03:00:00Z");
const correlations = [
  cor("c1", "evt_tool_result", "evt_kernel_open", "matched"),
  cor("c2", "evt_tool_result", "evt_kernel_exec", "matched"),
  cor("c3", "evt_tool_result", "evt_unrelated_uncertain", "uncertain"),
];
const findingEvents = [toolResult, policyEval];
const runObserved = new Map([kernelOpen, kernelExec].map((e) => [e.id, e]));

describe("reported vs observed with correlator-linked observations", () => {
  it("without the run index, matched observations the finding does not cite stay hidden (counted only)", () => {
    const rows = buildComparisonRows(findingEvents, correlations, null);
    const row = rows.find((r) => r.reported?.id === "evt_tool_result")!;
    expect(row.observed).toHaveLength(0);
    expect(row.outsideObserved).toEqual({ total: 3, matched: 2 });
  });

  it("shows only stored 'matched' observations from the run, marked as correlator-linked", () => {
    const rows = buildComparisonRows(findingEvents, correlations, runObserved);
    const row = rows.find((r) => r.reported?.id === "evt_tool_result")!;
    expect(row.observed.map((o) => o.id).sort()).toEqual(["evt_kernel_exec", "evt_kernel_open"]);
    expect([...row.viaCorrelator!].sort()).toEqual(["evt_kernel_exec", "evt_kernel_open"]);
    // The uncertain correlation is never shown as an observation.
    expect(row.outsideObserved).toEqual({ total: 1, matched: 0 });
  });

  it("the key pair prefers the observation of the finding's own resource and flags it as correlator-linked", () => {
    const rows = buildComparisonRows(findingEvents, correlations, runObserved);
    const pair = pickKeyPair(rows, focusTargetsOf(findingEvents))!;
    expect(pair.kind).toBe("paired");
    expect(pair.reported?.id).toBe("evt_tool_result");
    expect(pair.observed?.id).toBe("evt_kernel_open");
    expect(pair.viaCorrelator).toBe(true);
    expect(pair.correlation?.match).toBe("matched");
  });
});
