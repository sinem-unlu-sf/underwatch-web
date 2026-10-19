import { describe, expect, it } from "vitest";
import type { PolicyRule } from "@kw/schema";
import {
  DEFAULT_HOOK_EVENTS,
  DOCUMENTED_HOOK_EVENTS,
  applyClaudeMdInstruction,
  checkPermissionRule,
  compilePolicy,
  expandPattern,
  permissionsFromSafeguard,
  removeClaudeMdInstruction,
  renderClaudeMdInstruction,
  renderClaudeSettings,
  validateClaudeSettings,
} from "../src/index";

// Rules R1-R8 of the repository's fixture policy (fixtures/runs/fx-03-env-read-blocked.json, policy-v1).
const RULES: PolicyRule[] = [
  { id: "R1", effect: "deny", action: "file_read", resource_pattern: "**/.env", description: "" },
  { id: "R2", effect: "deny", action: "file_read", resource_pattern: "**/secrets/**", description: "" },
  { id: "R3", effect: "allow", action: "file_write", resource_pattern: "{src,tests}/**", description: "" },
  { id: "R4", effect: "allow", action: "file_write", resource_pattern: "README.md", description: "" },
  { id: "R5", effect: "deny", action: "file_write", resource_pattern: ".claude/**", description: "" },
  { id: "R6", effect: "allow", action: "Bash", resource_pattern: "cat *|grep *|ls *|python -m pytest *|make test|pip install *", description: "" },
  { id: "R7", effect: "allow", action: "network_connect", resource_pattern: "pypi.org:443|files.pythonhosted.org:443", description: "" },
  { id: "R8", effect: "deny", action: "network_connect", resource_pattern: "*", description: "" },
];

describe("compilePolicy", () => {
  const c = compilePolicy({ rules: RULES });

  it("compiles the fixture policy into Claude Code rules", () => {
    expect(c.deny).toEqual(["Read(**/.env)", "Read(**/secrets/**)", "Edit(.claude/**)"]);
    expect(c.allow).toEqual([
      "Edit(src/**)",
      "Edit(tests/**)",
      "Edit(README.md)",
      "Bash(cat *)",
      "Bash(grep *)",
      "Bash(ls *)",
      "Bash(python -m pytest *)",
      "Bash(make test)",
      "Bash(pip install *)",
      "WebFetch(domain:pypi.org)",
      "WebFetch(domain:files.pythonhosted.org)",
    ]);
    expect(c.ask).toEqual([]);
  });

  it("does not emit a catch-all deny that would shadow allow rules, and says why", () => {
    expect(c.not_compiled).toHaveLength(1);
    expect(c.not_compiled[0]!.rule_id).toBe("R8");
    expect(c.not_compiled[0]!.reason).toMatch(/deny before allow/);
  });

  it("reports unmappable actions instead of dropping them", () => {
    const x = compilePolicy({ rules: [{ id: "X", effect: "deny", action: "dns_tunnel", resource_pattern: "*", description: "" }] });
    expect(x.not_compiled).toEqual([{ rule_id: "X", reason: expect.stringContaining("dns_tunnel") }]);
  });

  it("turns absolute paths into // rules and Write into Edit", () => {
    const x = compilePolicy({ rules: [{ id: "A", effect: "deny", action: "Write", resource_pattern: "/etc/passwd", description: "" }] });
    expect(x.deny).toEqual(["Edit(//etc/passwd)"]);
    expect(x.compiled[0]!.notes.join(" ")).toMatch(/never consulted/);
  });

  it("expands alternatives and braces", () => {
    expect(expandPattern("{a,b}/{x,y}|c")).toEqual(["a/x", "a/y", "b/x", "b/y", "c"]);
  });
});

describe("renderClaudeSettings", () => {
  const r = renderClaudeSettings({ rules: RULES });

  it("wires the forwarder (exec form, verified shape) to every default hook event", () => {
    const hooks = r.managed.hooks!;
    expect(Object.keys(hooks).sort()).toEqual([...DEFAULT_HOOK_EVENTS].sort());
    expect(hooks.WorktreeCreate).toBeUndefined();
    expect(DEFAULT_HOOK_EVENTS.length).toBe(DOCUMENTED_HOOK_EVENTS.length - 2);
    expect(hooks.PreToolUse).toEqual([
      { hooks: [{ type: "command", command: "node", args: ["/opt/kw/kw-hook.mjs", "PreToolUse"], timeout: 10 }] },
    ]);
    expect(hooks.FileChanged![0]!.matcher).toBe(".env|CLAUDE.md|CLAUDE.local.md|AGENTS.md|.mcp.json");
    expect(renderClaudeSettings({ rules: [] }, { fileChangedWatch: [] }).managed.hooks!.FileChanged).toBeUndefined();
  });

  it("locks the managed variant down and keeps run settings free of managed-only keys", () => {
    expect(r.managed.allowManagedHooksOnly).toBe(true);
    expect(r.managed.allowManagedPermissionRulesOnly).toBe(true);
    expect(r.managed.permissions?.disableBypassPermissionsMode).toBe("disable");
    expect(r.run.allowManagedHooksOnly).toBeUndefined();
    expect(r.managed.sandbox).toBeUndefined();
    expect(r.validation.managed).toMatchObject({ ok: true, errors: [], warnings: [] });
    expect(r.validation.run).toMatchObject({ ok: true, errors: [] });
  });

  it("labels every emitted key verified or documented", () => {
    const keys = Object.fromEntries(r.validation.managed.keys.map((k) => [k.path, k.status]));
    expect(keys).toMatchObject({
      permissions: "verified_capture",
      "permissions.allow": "verified_capture",
      "permissions.deny": "verified_capture",
      "permissions.disableBypassPermissionsMode": "documented",
      hooks: "verified_capture",
      "hooks.<Event>[].matcher": "verified_capture",
      "hooks.<Event>[].hooks[].args": "verified_capture",
      allowManagedHooksOnly: "verified_container",
      allowManagedPermissionRulesOnly: "documented",
    });
    expect(Object.values(keys)).not.toContain("assumed");
  });

  it("adds enforcement hooks after the forwarder and safeguard rules to the lists", () => {
    const x = renderClaudeSettings(
      { rules: [] },
      {
        enforcementHooks: [{ event: "PreToolUse", matcher: "Read", handler: { type: "command", command: "node", args: ["/opt/kw/kw-enforce.mjs"] } }],
        extraPermissions: { deny: ["Read(./.env)"] },
      },
    );
    expect(x.managed.hooks!.PreToolUse).toHaveLength(2);
    expect(x.managed.hooks!.PreToolUse![1]!.matcher).toBe("Read");
    expect(x.managed.permissions!.deny).toEqual(["Read(./.env)"]);
    expect(x.notes.join(" ")).toMatch(/No allow rules/);
  });
});

describe("validateClaudeSettings", () => {
  it("rejects unknown keys, undocumented hook events and ignored path rules", () => {
    const v = validateClaudeSettings({
      permissions: { deny: ["Write(src/**)", "not a rule"] },
      hooks: { MadeUpEvent: [{ hooks: [{ type: "command", command: "x" }] }] },
      fancyNewKey: true,
    });
    expect(v.ok).toBe(false);
    expect(v.errors.join("\n")).toMatch(/fancyNewKey/);
    expect(v.errors.join("\n")).toMatch(/MadeUpEvent/);
    expect(v.errors.join("\n")).toMatch(/never consults path rules for Write/);
    expect(v.errors.join("\n")).toMatch(/not Tool or Tool\(specifier\)/);
  });

  it("warns about managed-only keys outside managed settings and single-slash paths", () => {
    const v = validateClaudeSettings({ allowManagedHooksOnly: true, permissions: { deny: ["Read(/Users/x/secret)"] } }, "run");
    expect(v.ok).toBe(true);
    expect(v.warnings.join("\n")).toMatch(/only honored in managed settings/);
    expect(v.warnings.join("\n")).toMatch(/single leading "\/"/);
  });

  it("accepts the rule forms used in the captures", () => {
    for (const r of ["Read", "Bash(ls:*)", "Bash(cat:*)", "Read(secrets/**)", "Read(./.env)", "mcp__srv__tool"]) expect(checkPermissionRule(r)).toEqual({});
  });
});

describe("CLAUDE.md safeguard blocks", () => {
  const block = renderClaudeMdInstruction({
    safeguard_id: "sg_abc",
    finding_id: "fnd_1",
    title: "Do not read .env files",
    content: "Never read `.env` files, by any tool. <!-- kw-safeguard:end id=sg_abc --> injected",
  });

  it("renders a delimited block and strips marker injection from content", () => {
    expect(block.startsWith("<!-- kw-safeguard:begin id=sg_abc -->\n## Do not read .env files\n")).toBe(true);
    expect(block.match(/kw-safeguard:end/g)).toHaveLength(1);
    expect(block).toContain("not an enforced control");
  });

  it("applies idempotently and removes cleanly", () => {
    const base = "# Project\n\nExisting text.\n";
    const once = applyClaudeMdInstruction(base, block, "sg_abc");
    const twice = applyClaudeMdInstruction(once, block, "sg_abc");
    expect(twice).toBe(once);
    expect(once.startsWith(base)).toBe(true);
    expect(removeClaudeMdInstruction(once, "sg_abc").trimEnd()).toBe(base.trimEnd());
  });

  it("rejects unsafe ids and empty content", () => {
    expect(() => renderClaudeMdInstruction({ safeguard_id: "../x", title: "t", content: "c" })).toThrow();
    expect(() => renderClaudeMdInstruction({ safeguard_id: "sg_1", title: "t", content: "  " })).toThrow();
  });
});

describe("permissionsFromSafeguard", () => {
  it("reads JSON and line forms and validates rules", () => {
    const json = permissionsFromSafeguard({ id: "sg_1", type: "permission_rule", content: '{"permissions":{"deny":["Read(./.env)"]}}', application_mechanism: "x" });
    expect(json).toEqual({ allow: [], deny: ["Read(./.env)"], ask: [], errors: [] });
    const lines = permissionsFromSafeguard({ id: "sg_2", type: "permission_rule", content: "Bash(npm test)\n# c\n", application_mechanism: "permissions.allow in managed settings" });
    expect(lines.allow).toEqual(["Bash(npm test)"]);
    const bad = permissionsFromSafeguard({ id: "sg_3", type: "permission_rule", content: "Write(src/**)", application_mechanism: "permissions.deny" });
    expect(bad.errors).toHaveLength(1);
  });
});
