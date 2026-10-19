/** ADVERSARIAL REVIEW (ISSUE 3): adapter output for tool inputs the engineer's test did not cover. Synthetic canaries only. */
import { expect, it } from "vitest";
import { parseRunOutputs, toSchemaEvents, type ParseContext } from "../src/index";
const ANT = "sk-ant-oat01-KWCANARY-Zq7Xv2Lp9Rt4Wm8Nc3Bf6Hd1Jk5Gs0Ya";
const RND = "KWCANARYq7Zr3Tn6Wy1Xv4Pm8Lk2Hs9Jd5Fb0Gc";
const SID = "11111111-2222-3333-4444-555555555555";
const ts = (s: number) => `2026-10-17T02:00:${String(s).padStart(2, "0")}.000Z`;
const tool = (id: string, name: string, input: unknown, s: number) => ({ type: "assistant", message: { model: "m", id: `msg_${s}`, content: [{ type: "tool_use", id, name, input }] }, session_id: SID, uuid: `u-${s}`, timestamp: ts(s) });
const stream = [
  { type: "system", subtype: "init", cwd: "/work", session_id: SID, tools: ["Bash"], model: "m", uuid: "u-0", timestamp: ts(0) },
  tool("toolu_A1", "Write", { file_path: "/work/.env", content: `ANTHROPIC_API_KEY=${ANT}\n` }, 1),
  tool("toolu_A2", "Edit", { file_path: "/work/cfg.json", old_string: "x", new_string: `"token": "${ANT}"` }, 2),
  tool("toolu_A3", "WebFetch", { url: `https://api.example.test/v1?access_token=${RND}`, prompt: "summarize" }, 3),
  tool("toolu_A4", "mcp__github__create_issue", { body: `leaked ${ANT}`, title: "t" }, 4),
  { type: "result", subtype: "success", is_error: false, result: "done", session_id: SID, uuid: "u-9", num_turns: 1 },
].map((x) => JSON.stringify(x)).join("\n");
const ctx: ParseContext = { run_id: "run_adv", fallback_timestamp: ts(0), is_fixture: true };
it("format secrets in Write/Edit/MCP inputs are redacted", () => {
  const out = parseRunOutputs({ streamJson: stream, hookLog: "" }, ctx);
  expect(JSON.stringify(out)).not.toContain("Zq7Xv2Lp9Rt4");
});
// FIXED (ISSUE 3 repair): lower-case query key + letter-initial alnum value was skipped by env_secret_value and high_entropy.
it("WebFetch URL ?access_token=<random> must be redacted", () => {
  const out = parseRunOutputs({ streamJson: stream, hookLog: "" }, ctx);
  const s = JSON.stringify(out) + JSON.stringify(toSchemaEvents(out.events));
  expect(s).not.toContain("q7Zr3Tn6Wy1Xv4");
});
