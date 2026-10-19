import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { __feedForTests, kernelLine, liveAgentChunk, liveFinish, liveSnapshot, liveStart, protectedRule } from "./live-feed";

const line = (o: unknown) => `${JSON.stringify(o)}\n`;

describe("live feed", () => {
  it("maps protected paths to policy rules", () => {
    expect(protectedRule("/workspace/.env")).toBe("R1");
    expect(protectedRule("/workspace/.env.local")).toBe("R1");
    expect(protectedRule("/workspace/secrets/token.txt")).toBe("R2");
    expect(protectedRule("/workspace/src/invoice.js")).toBeNull();
  });

  it("streams agent tool calls, a denial alert and the final report, paged by seq", async () => {
    const id = "run_live_test_1";
    await liveStart(id, { exportFile: null });
    const toolUse = { type: "assistant", message: { content: [{ type: "tool_use", id: "t1", name: "Read", input: { file_path: "/workspace/.env" } }] } };
    const denied = { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", is_error: true, content: "File is in a directory that is denied by your permission settings." }] } };
    // Chunk boundaries fall mid-line on purpose.
    const all = line(toolUse) + line(denied);
    liveAgentChunk(id, all.slice(0, 40));
    liveAgentChunk(id, all.slice(40));
    const first = await liveSnapshot(id, 0);
    expect(first.available).toBe(true);
    expect(first.status).toBe("running");
    expect(first.items.map((i) => [i.kind, i.outcome])).toEqual([
      ["tool_call", "attempted"],
      ["tool_result", "denied"],
    ]);
    expect(first.alerts).toHaveLength(1);
    expect(first.alerts[0]).toMatchObject({ severity: "medium", source: "agent", rule: "R1" });

    liveAgentChunk(id, line({ type: "result", result: "Done.", is_error: false }));
    liveFinish(id);
    const next = await liveSnapshot(id, first.next_after);
    expect(next.status).toBe("finished");
    expect(next.items.map((i) => i.kind)).toEqual(["final_report"]);
  });

  it("shows a real Tetragon deny-open (kw-enf policy override) as one blocked row plus a kernel alert", async () => {
    // Real export lines from run_7fb5f255a1fbd5f8e0343ae9: the observe-policy twin (failed open) and the LSM override.
    const id = "run_7fb5f255a1fbd5f8e0343ae9";
    await liveStart(id, { exportFile: null });
    const f = __feedForTests(id)!;
    const lines = readFileSync(path.join(__dirname, "..", "test", "fixtures", "live-kernel-block.jsonl"), "utf8").split("\n").filter(Boolean);
    for (const l of lines) kernelLine(f, l);
    const snap = await liveSnapshot(id, 0);
    expect(snap.items.map((i) => [i.lane, i.text, i.outcome])).toEqual([["kernel", "node read /workspace/.env", "blocked"]]);
    expect(snap.alerts).toEqual([expect.objectContaining({ source: "kernel", rule: "R1", text: "Kernel blocked node from opening /workspace/.env (rule R1)" })]);
  });

  it("reports an unknown run as unavailable", async () => {
    expect((await liveSnapshot("run_nope", 0)).available).toBe(false);
  });
});
