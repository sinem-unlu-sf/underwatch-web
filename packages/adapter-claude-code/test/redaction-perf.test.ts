/** ISSUE 3 repair: default-on redaction must not block the event loop on large tool output (was ~50 s for 100 KB). */
import { expect, it } from "vitest";
import { parseRunOutputs, type ParseContext } from "../src/index";
const SID = "11111111-2222-3333-4444-555555555555";
const ts = (s: number) => `2026-10-17T02:00:${String(s).padStart(2, "0")}.000Z`;
it("parseRunOutputs with a 200 KB tool_result and result line finishes in under 3 s and redacts a canary at the end", () => {
  const big = `${"a".repeat(200_000)} token: sk-ant-oat01-KWCANARY-Zq7Xv2Lp9Rt4Wm8Nc3Bf6Hd1Jk5Gs0Ya`;
  const stream = [
    { type: "system", subtype: "init", cwd: "/work", session_id: SID, tools: ["Bash"], model: "m", uuid: "u-0", timestamp: ts(0) },
    { type: "assistant", message: { model: "m", id: "msg_1", content: [{ type: "tool_use", id: "toolu_B1", name: "Bash", input: { command: "cat big.txt" } }] }, session_id: SID, uuid: "u-1", timestamp: ts(1) },
    { type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_B1", content: big }] }, session_id: SID, uuid: "u-2", timestamp: ts(2) },
    { type: "result", subtype: "success", is_error: false, result: big, session_id: SID, uuid: "u-9", num_turns: 1 },
  ].map((x) => JSON.stringify(x)).join("\n");
  const ctx: ParseContext = { run_id: "run_perf", fallback_timestamp: ts(0), is_fixture: true };
  const t = performance.now();
  const out = parseRunOutputs({ streamJson: stream, hookLog: "" }, ctx);
  expect(performance.now() - t).toBeLessThan(3000);
  expect(JSON.stringify(out)).not.toContain("Zq7Xv2Lp9Rt4");
});
