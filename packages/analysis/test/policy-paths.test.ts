import { describe, expect, it } from "vitest";
import { DEFAULT_CONTEXT, canonicalizePath, evaluatePolicy, normalizePolicy, resolveContext, type PolicyAction } from "../src/index";
import { kwPolicy, schemaPolicy } from "./builders";

const ctx = resolveContext({ symlinks: { "/workspace/link": "/workspace/.env", "/workspace/cfg": "/home/agent/.aws" }, caseInsensitivePrefixes: ["/workspace/mac"] });
const file = (raw: string, kind: "file_read" | "file_write" = "file_read"): PolicyAction => ({ kind, path: canonicalizePath(raw, ctx), command: null, argv: null, processName: null, host: null, port: null });

describe("path canonicalization", () => {
  it("relative, dot-dot, duplicate slashes, home, host mapping", () => {
    expect(canonicalizePath("src/../.env", ctx).resolved).toBe("/workspace/.env");
    expect(canonicalizePath("/workspace//src/./a.ts", ctx).resolved).toBe("/workspace/src/a.ts");
    expect(canonicalizePath("~/.ssh/id_rsa", ctx).zone).toBe("home");
    expect(canonicalizePath("a.ts", ctx, { cwd: "/workspace/src" }).resolved).toBe("/workspace/src/a.ts");
    const mapped = canonicalizePath("/Users/x/kw/ws/src/a.ts", resolveContext({ pathMappings: [{ hostPrefix: "/Users/x/kw/ws", containerPrefix: "/workspace" }] }));
    expect(mapped.resolved).toBe("/workspace/src/a.ts");
    expect(mapped.mappedFromHost).toBe(true);
    expect(canonicalizePath("/home/agent/.claude/projects/x.jsonl", ctx).zone).toBe("agent_config");
  });
  it("symlinks resolved via table and kernel path; limitation recorded when unavailable", () => {
    expect(canonicalizePath("/workspace/link", ctx).resolved).toBe("/workspace/.env");
    expect(canonicalizePath("/workspace/cfg/credentials", ctx).resolved).toBe("/home/agent/.aws/credentials");
    expect(canonicalizePath("/workspace/x", DEFAULT_CONTEXT, { kernelResolved: "/workspace/y" }).method).toBe("kernel_resolved");
    expect(canonicalizePath("/workspace/x", DEFAULT_CONTEXT).limitations.join()).toMatch(/symlinks not resolved/);
  });
  it("case folding only on case-insensitive mounts", () => {
    expect(canonicalizePath("/workspace/mac/README.md", ctx).key).toBe("/workspace/mac/readme.md");
    expect(canonicalizePath("/workspace/src/README.md", ctx).key).toBe("/workspace/src/README.md");
  });
});

describe("policy evaluator", () => {
  const p = kwPolicy({
    rules: [
      { id: "R-ENV", effect: "deny", action: "file_read", patterns: ["ws:**/.env"] },
      { id: "A-ALL-WS", effect: "allow", action: "file_read", patterns: ["ws:**"] },
      { id: "A-CFG", effect: "allow", action: "file_read", patterns: ["ws:cfg/**"] },
      { id: "R-CURL", effect: "deny", action: "command", patterns: ["curl *", "program:nc"] },
      { id: "R-TEL", effect: "deny", action: "network", patterns: ["*.telemetry.test"] },
      { id: "A-NPM", effect: "allow", action: "network", patterns: ["registry.npmjs.org:443"] },
    ],
    defaults: { network: "deny", file_write: "allow" },
  });
  it("deny takes precedence over allow regardless of order", () => {
    expect(evaluatePolicy(p, file("/workspace/.env"), ctx)).toMatchObject({ decision: "deny", decidingRuleId: "R-ENV" });
    expect(evaluatePolicy(p, file("/workspace/src/a.ts"), ctx)).toMatchObject({ decision: "allow", decidingRuleId: "A-ALL-WS" });
  });
  it("deny matches the requested OR resolved path; allow needs both", () => {
    expect(evaluatePolicy(p, file("/workspace/link"), ctx).decision).toBe("deny");
    // /workspace/cfg -> ~/.aws: requested matches A-CFG, resolved does not -> no allow; no default for file_read
    expect(evaluatePolicy(p, file("/workspace/cfg/credentials"), ctx).decision).toBe("not_covered");
  });
  it("command patterns see the real program however it was spelled", () => {
    const cmd = (argv: string[]): PolicyAction => ({ kind: "command", path: null, command: null, argv, processName: argv[0]!, host: null, port: null });
    expect(evaluatePolicy(p, cmd(["/usr/bin/curl", "-s", "x"]), ctx).decision).toBe("deny");
    expect(evaluatePolicy(p, cmd(["sh", "-c", "curl http://x"]), ctx).decision).toBe("deny");
    expect(evaluatePolicy(p, cmd(["/bin/nc", "-l", "1"]), ctx).decision).toBe("deny");
    expect(evaluatePolicy(p, cmd(["git", "status"]), ctx).decision).toBe("not_covered");
  });
  it("network wildcards, ports and explicit defaults", () => {
    const net = (host: string, port: number | null): PolicyAction => ({ kind: "network", path: null, command: null, argv: null, processName: null, host, port });
    expect(evaluatePolicy(p, net("a.b.telemetry.test", 443), ctx).decision).toBe("deny");
    expect(evaluatePolicy(p, net("registry.npmjs.org", 443), ctx).decision).toBe("allow");
    expect(evaluatePolicy(p, net("registry.npmjs.org", null), ctx)).toMatchObject({ decision: "deny", step: "default" });
    expect(evaluatePolicy(p, net("example.com", 443), ctx)).toMatchObject({ decision: "deny", step: "default" });
    expect(evaluatePolicy(p, file("/workspace/x", "file_write"), ctx)).toMatchObject({ decision: "allow", step: "default" });
  });
  it("accepts a @kw/schema PolicyVersion and reports rules it cannot evaluate", () => {
    const { policy, issues } = normalizePolicy(
      schemaPolicy([
        { id: "r1", effect: "deny", action: "file_read", resource_pattern: "**/.env", description: "" },
        { id: "r2", effect: "ask", action: "Bash", resource_pattern: "git push *", description: "" },
        { id: "r3", effect: "deny", action: "Agent", resource_pattern: "x", description: "" },
      ]),
    );
    expect(policy!.rules.map((r) => r.id)).toEqual(["r1"]);
    expect(issues.map((i) => i.rule_id)).toEqual(["r2", "r3"]);
    expect(evaluatePolicy(policy, file("/workspace/sub/.env"), ctx).decision).toBe("deny");
  });
});
