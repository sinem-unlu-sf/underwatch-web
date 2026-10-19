import { mkdtempSync, readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Safeguard } from "@kw/schema";
import { ClaudeCodeAdapter, OAUTH_TOKEN_ENV, validateClaudeSettings } from "../src/index";
import { captureInputs, ctxFor } from "./helpers";

function sg(over: Partial<Safeguard> & Pick<Safeguard, "id" | "type" | "content">): Safeguard {
  return {
    finding_id: "fnd_1",
    is_fixture: true,
    title: "Safeguard",
    application_mechanism: "permissions.deny in managed settings",
    target_path: null,
    intended_effect: "",
    legitimate_workflow_impact: "",
    approval_status: "approved",
    application_status: "not_applied",
    verification_status: "not_tested",
    created_at: "2026-10-17T00:00:00Z",
    approved_at: null,
    approved_by: null,
    applied_at: null,
    last_verification_run_id: null,
    ...over,
  };
}

describe("ClaudeCodeAdapter", () => {
  const adapter = new ClaudeCodeAdapter();

  it("prepareWorkspace applies only approved, supported safeguards and writes settings outside the workspace", async () => {
    const root = mkdtempSync(join(tmpdir(), "kw-ws-"));
    const ws = join(root, "workspace");
    const cfg = join(root, "policy");
    mkdirSync(ws);
    writeFileSync(join(ws, "CLAUDE.md"), "# Repo\n");
    const safeguards = [
      sg({ id: "sg_md", type: "claude_md_instruction", title: "No .env", content: "Do not read .env files." }),
      sg({ id: "sg_rule", type: "permission_rule", content: "Read(./.env)" }),
      sg({ id: "sg_prop", type: "permission_rule", content: "Read(./x)", approval_status: "proposed" }),
      sg({ id: "sg_test", type: "regression_test", content: "test()" }),
    ];
    const policy = { rules: [{ id: "R1", effect: "deny" as const, action: "file_read", resource_pattern: "**/secrets/**", description: "" }] };
    const r1 = await adapter.prepareWorkspace(ws, policy, safeguards, { configDir: cfg, writeRunSettings: true });
    expect(r1.applied.map((a) => a.safeguard_id)).toEqual(["sg_md", "sg_rule"]);
    expect(r1.skipped.map((s) => s.safeguard_id)).toEqual(["sg_prop", "sg_test"]);
    const managed = JSON.parse(readFileSync(join(cfg, "managed-settings.json"), "utf8"));
    expect(managed.permissions.deny).toEqual(["Read(**/secrets/**)", "Read(./.env)"]);
    expect(validateClaudeSettings(managed, "managed").ok).toBe(true);
    expect(existsSync(join(cfg, "run-settings.json"))).toBe(true);
    expect(existsSync(join(ws, ".claude"))).toBe(false);
    const md1 = readFileSync(join(ws, "CLAUDE.md"), "utf8");
    expect(md1).toContain("<!-- kw-safeguard:begin id=sg_md -->");
    await adapter.prepareWorkspace(ws, policy, safeguards, { configDir: cfg });
    expect(readFileSync(join(ws, "CLAUDE.md"), "utf8")).toBe(md1);
  });

  it("refuses to write settings inside the agent-writable workspace", async () => {
    const ws = mkdtempSync(join(tmpdir(), "kw-ws-"));
    await expect(adapter.prepareWorkspace(ws, { rules: [] }, [], { configDir: join(ws, ".kw") })).rejects.toThrow(/outside the agent workspace/);
    await expect(adapter.prepareWorkspace(ws, { rules: [] }, [], { configDir: ws })).rejects.toThrow(/outside/);
  });

  it("buildCommand produces the headless stream-json invocation without any secret value", () => {
    const c = adapter.buildCommand({ task: "Fix the failing test", model: "haiku", maxTurns: 5, sessionId: "550e8400-e29b-41d4-a716-446655440000" });
    expect(c.command).toBe("claude");
    expect(c.args).toEqual([
      "-p", "Fix the failing test",
      "--output-format", "stream-json",
      "--verbose",
      "--model", "haiku",
      "--max-turns", "5",
      "--permission-mode", "default",
      "--strict-mcp-config",
      "--session-id", "550e8400-e29b-41d4-a716-446655440000",
    ]);
    expect(c.cwd).toBe("/workspace");
    expect(c.env).toEqual({ KW_HOOK_LOG: "/kw-hooks/hooks.ndjson", CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1" });
    // Regression (Issue 1): the real credential must never be routed into the agent container's env.
    expect(c.secretEnv).toEqual([]);
    expect(c.credential).toEqual({
      mode: "broker",
      clientTokenEnv: OAUTH_TOKEN_ENV,
      baseUrlEnv: "ANTHROPIC_BASE_URL",
      realTokenHostSource: "~/.underwatch/claude-oauth-token",
      realTokenDeliverTo: "llm-broker",
    });
    expect(Object.keys(c.env)).not.toContain(OAUTH_TOKEN_ENV);
    expect(JSON.stringify(c)).not.toMatch(/sk-ant|oat01/i);
    const flag = adapter.buildCommand({ task: "t", model: "haiku", maxTurns: 1, settingsDelivery: "flag" });
    expect(flag.args.slice(-2)).toEqual(["--settings", "/opt/kw/run-settings.json"]);
    expect(() => adapter.buildCommand({ task: " ", model: "haiku", maxTurns: 1 })).toThrow();
    expect(() => adapter.buildCommand({ task: "t", model: "haiku; rm -rf /", maxTurns: 1 })).toThrow();
    expect(() => adapter.buildCommand({ task: "t", model: "haiku", maxTurns: 0 })).toThrow();
  });

  it("reports capabilities and token presence without reading the token", async () => {
    expect(await adapter.capabilities()).toEqual(["tool_calls", "permission_decisions", "agent_reported_actions"]);
    expect(adapter.reportedFieldCapabilities().find((f) => f.field.startsWith("process_id"))?.availability).toBe("unavailable");
    const dir = mkdtempSync(join(tmpdir(), "kw-tok-"));
    const missing = await new ClaudeCodeAdapter({ tokenHostPath: join(dir, "none") }).status();
    expect(missing.status).toBe("not_configured");
    writeFileSync(join(dir, "tok"), "synthetic-not-a-token", { mode: 0o600 });
    const present = await new ClaudeCodeAdapter({ tokenHostPath: join(dir, "tok") }).status();
    expect(present.status).toBe("configured");
    expect(JSON.stringify(present)).not.toContain("synthetic-not-a-token");
  });

  it("parseRunOutputs delegates to the pure parser", () => {
    const r = adapter.parseRunOutputs(captureInputs("run1"), ctxFor("run1"));
    expect(r.events.length).toBeGreaterThan(0);
  });
});
