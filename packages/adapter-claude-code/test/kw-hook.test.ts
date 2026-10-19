import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseRunOutputs } from "../src/index";
import { ctxFor, readCapture } from "./helpers";

const HOOK = fileURLToPath(new URL("../bin/kw-hook.mjs", import.meta.url));

function runHook(stdin: string | null, env: Record<string, string | undefined>, args: string[] = []) {
  return new Promise<{ code: number | null; stdout: string; stderr: string; ms: number }>((resolve) => {
    const t0 = Date.now();
    const childEnv: Record<string, string> = { PATH: process.env.PATH ?? "" };
    for (const [k, v] of Object.entries(env)) if (v !== undefined) childEnv[k] = v;
    const p = spawn(process.execPath, [HOOK, ...args], { env: childEnv, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    p.stdout.on("data", (d) => (stdout += d));
    p.stderr.on("data", (d) => (stderr += d));
    p.on("close", (code) => resolve({ code, stdout, stderr, ms: Date.now() - t0 }));
    if (stdin !== null) p.stdin.end(stdin);
    else p.stdin.end();
  });
}

function capturedPayloads(run: "run1" | "run2" | "run3"): Array<Record<string, unknown>> {
  return readCapture(run, "hooks.jsonl")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => (JSON.parse(l) as { payload: Record<string, unknown> }).payload);
}

describe("bin/kw-hook.mjs", () => {
  it("appends exactly one {event, received_at, payload} line, prints nothing and exits 0", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kw-hook-"));
    const log = join(dir, "hooks.ndjson");
    const payload = capturedPayloads("run1").find((p) => p.hook_event_name === "PreToolUse")!;
    const r = await runHook(JSON.stringify(payload), { KW_HOOK_LOG: log }, ["PreToolUse"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toBe("");
    expect(r.stderr).toBe("");
    const lines = readFileSync(log, "utf8").trim().split("\n");
    expect(lines).toHaveLength(1);
    const rec = JSON.parse(lines[0]!) as Record<string, unknown>;
    expect(rec).toMatchObject({
      v: 1,
      event: "PreToolUse",
      configured_event: "PreToolUse",
      payload,
      payload_error: null,
      raw: null,
      truncated: false,
      evidence_class: "agent_reported",
    });
    expect(typeof rec.received_at).toBe("string");
    expect(Number.isNaN(Date.parse(rec.received_at as string))).toBe(false);
    expect(rec.hook_pid).toBeTypeOf("number");
    expect(rec.hook_ppid).toBeTypeOf("number");
  });

  it("keeps unparseable stdin as raw text instead of dropping it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kw-hook-"));
    const log = join(dir, "hooks.ndjson");
    const r = await runHook("{definitely not json", { KW_HOOK_LOG: log }, ["Stop"]);
    expect(r.code).toBe(0);
    const rec = JSON.parse(readFileSync(log, "utf8")) as Record<string, unknown>;
    expect(rec).toMatchObject({ event: "Stop", payload: null, payload_error: "invalid_json", raw: "{definitely not json" });
  });

  it("does nothing and exits 0 when KW_HOOK_LOG is unset or unwritable", async () => {
    const a = await runHook("{}", { KW_HOOK_LOG: undefined });
    expect(a.code).toBe(0);
    expect(a.stdout).toBe("");
    const b = await runHook("{}", { KW_HOOK_LOG: "/nonexistent-dir-kw/hooks.ndjson" });
    expect(b.code).toBe(0);
    expect(b.stdout).toBe("");
    expect(existsSync("/nonexistent-dir-kw")).toBe(false);
  });

  it("writes one intact line per invocation when hooks run in parallel", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kw-hook-"));
    const log = join(dir, "hooks.ndjson");
    const payloads = [...capturedPayloads("run1"), ...capturedPayloads("run2")];
    const results = await Promise.all(payloads.map((p) => runHook(JSON.stringify(p), { KW_HOOK_LOG: log })));
    expect(results.every((r) => r.code === 0 && r.stdout === "")).toBe(true);
    const lines = readFileSync(log, "utf8").trim().split("\n");
    expect(lines).toHaveLength(payloads.length);
    for (const l of lines) expect(() => JSON.parse(l)).not.toThrow();
  });

  it("produces a log the parser merges with the stream-json capture", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kw-hook-"));
    const log = join(dir, "hooks.ndjson");
    for (const p of capturedPayloads("run1")) {
      const r = await runHook(JSON.stringify(p), { KW_HOOK_LOG: log }, [String(p.hook_event_name)]);
      expect(r.code).toBe(0);
    }
    const parsed = parseRunOutputs(
      { hookLog: readFileSync(log, "utf8"), streamJson: readCapture("run1", "stream.jsonl") },
      ctxFor("run1-forwarded"),
    );
    expect(parsed.records.filter((r) => r.disposition === "unparsed")).toEqual([]);
    expect(parsed.warnings).toEqual([]);
    const denied = parsed.events.find((e) => e.tool_use_id === "toolu_01QQ7RtPJBzE1pjhGyeh6EVU" && e.detail.phase === "resolved")!;
    expect(denied.detail.permission?.kind).toBe("hook_deny");
    expect(denied.detail.corroborating.some((c) => c.record_kind === "hook:PostToolBatch")).toBe(true);
  });
});
