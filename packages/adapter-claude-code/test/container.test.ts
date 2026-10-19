/**
 * Outputs of a real run in the agent image (kw-agent:2.1.302, linux/arm64, --network none, no credentials):
 *   docker run --user 1000:1000 -v <generated policy>:/etc/claude-code:ro -v bin/kw-hook.mjs:/opt/kw/kw-hook.mjs:ro
 *     -v <ws>:/workspace -v <spool>:/kw-hooks -e KW_HOOK_LOG=/kw-hooks/hooks.ndjson --entrypoint claude kw-agent:2.1.302
 *     -p "say hi" --output-format stream-json --verbose --max-turns 1 --permission-mode default --strict-mcp-config
 * The workspace carried a .claude/settings.json with an extra SessionStart hook tagged "PROJECT-HOOK".
 *   hooks-lockdown.ndjson    managed settings from renderClaudeSettings() (allowManagedHooksOnly: true)
 *   hooks-no-lockdown.ndjson same generator with { lockdown: false }
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseRunOutputs, renderClaudeSettings } from "../src/index";
import { ctxFor } from "./helpers";

const C = new URL("./fixtures/container/", import.meta.url);
const read = (f: string) => readFileSync(new URL(f, C), "utf8");
const lines = (f: string) => read(f).trim().split("\n").map((l) => JSON.parse(l) as Record<string, any>);

describe("agent container run (managed settings + kw-hook)", () => {
  it("the committed managed-settings.json is exactly what the generator renders", () => {
    const policy = {
      rules: [
        { id: "R1", effect: "deny" as const, action: "file_read", resource_pattern: "**/.env", description: "" },
        { id: "R2", effect: "allow" as const, action: "Bash", resource_pattern: "ls *", description: "" },
      ],
    };
    // The container run predates the wider DEFAULT_FILE_CHANGED_WATCH; it used [".env", "CLAUDE.md"].
    expect(JSON.parse(read("managed-settings.json"))).toEqual(
      renderClaudeSettings(policy, { fileChangedWatch: [".env", "CLAUDE.md"] }).managed,
    );
  });

  it("managed hooks fired through the forwarder; the workspace hook ran only without lockdown", () => {
    const locked = lines("hooks-lockdown.ndjson");
    const open = lines("hooks-no-lockdown.ndjson");
    expect(locked.map((r) => r.configured_event)).toEqual(["SessionStart", "UserPromptSubmit", "MessageDisplay", "SessionEnd"]);
    expect(open.map((r) => r.configured_event)).toContain("PROJECT-HOOK");
    expect(locked.map((r) => r.configured_event)).not.toContain("PROJECT-HOOK");
    for (const r of locked) {
      expect(r.v).toBe(1);
      expect(r.evidence_class).toBe("agent_reported");
      expect(r.payload_error).toBeNull();
      expect(r.event).toBe(r.payload.hook_event_name);
    }
  });

  it("parses the container outputs; a mis-tagged handler is reported as a warning", () => {
    const r = parseRunOutputs({ streamJson: read("stream.jsonl"), hookLog: read("hooks-lockdown.ndjson") }, ctxFor("container"));
    expect(r.records.filter((x) => x.disposition === "unparsed")).toEqual([]);
    expect(r.warnings).toEqual([]);
    const final = r.events.find((e) => e.detail.extra.kind === "final_report")!;
    expect(final.outcome).toBe("failed"); // result.is_error = true ("Not logged in")
    expect(r.events.find((e) => e.event_type === "session_start")!.detail.extra.permission_mode).toBe("default");
    // Unauthenticated run: result present (is_error), SessionEnd fired, no tool calls.
    expect(r.completeness).toMatchObject({ result_message_present: true, session_end_hook_present: true, agent_record_complete: true });
    const open = parseRunOutputs({ hookLog: read("hooks-no-lockdown.ndjson") }, ctxFor("container-open"));
    expect(open.warnings.some((w) => w.includes('configured for "PROJECT-HOOK"'))).toBe(true);
  });
});
