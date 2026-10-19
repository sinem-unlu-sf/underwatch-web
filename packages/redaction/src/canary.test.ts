/**
 * Synthetic canary coverage for the storage-boundary redactor (ISSUE 3). Every value here is a synthetic look-alike
 * (KWCANARY marker); no real credential is used. A leak check looks for the canary's random tail, raw and in common
 * encodings, so a partially redacted value also counts as a leak.
 */
import { describe, expect, it } from "vitest";
import {
  REDACTION_FAILED_PLACEHOLDER,
  RedactionConfigError,
  defaultRedactor,
  parseRedactionConfig,
  redact,
  redactionOptionsFromEnv,
  safeRedact,
  scanForLeaks,
} from "./index";

const ANT_TAIL = "Zq7Xv2Lp9Rt4Wm8Nc3Bf6Hd1Jk5Gs0Ya";
const OAI_TAIL = "proj9f8e7d6c5b4a3210ZYXWVUTSRQ";
export const CANARY_ANTHROPIC = `sk-ant-oat01-KWCANARY-${ANT_TAIL}`;
export const CANARY_OPENAI = `sk-KWCANARY-${OAI_TAIL}`;

const b64 = (s: string) => btoa(s);
const hex = (s: string) => [...s].map((c) => c.charCodeAt(0).toString(16).padStart(2, "0")).join("");

/** True when any recognizable piece of a canary survives (raw, base64, hex, URL-encoded). */
function leaks(out: string): boolean {
  for (const tail of [ANT_TAIL, OAI_TAIL]) {
    if (out.includes(tail) || out.includes(tail.slice(0, 12)) || out.includes(tail.slice(-12))) return true;
  }
  for (const c of [CANARY_ANTHROPIC, CANARY_OPENAI]) {
    if (out.includes(b64(c).slice(4, 28)) || out.includes(hex(c).slice(24, 72)) || out.includes(encodeURIComponent(c))) return true;
  }
  return out.includes("KWCANARY-");
}

const CASES: Record<string, string> = {
  "command output": `$ cat ~/.config/tool/credentials\n[default]\napi_key = ${CANARY_OPENAI}\nregion = eu-west-1\n`,
  "env | sort dump": [
    "HOME=/home/agent",
    `ANTHROPIC_API_KEY=${CANARY_ANTHROPIC}`,
    `CLAUDE_CODE_OAUTH_TOKEN=${CANARY_ANTHROPIC}`,
    "LANG=C.UTF-8",
    `OPENAI_API_KEY=${CANARY_OPENAI}`,
    "PATH=/usr/local/bin:/usr/bin",
    `SOME_UNRELATED_NAME=${CANARY_OPENAI}`,
  ].join("\n"),
  "multiline log": `2026-10-17T02:00:00Z INFO start\n2026-10-17T02:00:01Z DEBUG using key ${CANARY_ANTHROPIC}\n2026-10-17T02:00:02Z INFO done`,
  "single-quoted shell": `curl -s -H 'x-api-key: ${CANARY_ANTHROPIC}' https://api.example.test/v1`,
  "double-quoted shell": `export TOKEN="${CANARY_OPENAI}"`,
  "JSON": JSON.stringify({ env: { API_KEY: CANARY_OPENAI }, note: `bearer ${CANARY_ANTHROPIC}` }),
  "JSON-escaped twice": JSON.stringify(JSON.stringify({ secret: CANARY_ANTHROPIC })),
  "Authorization header": `Authorization: Bearer ${CANARY_OPENAI}`,
  "base64 of the value": `echo ${b64(CANARY_ANTHROPIC)} | base64 -d`,
  "base64 of an env file": `data: ${b64(`OPENAI_API_KEY=${CANARY_OPENAI}\nX=1\n`)}`,
  "base64url": `token=${b64(CANARY_OPENAI).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")}`,
  "hex": `0x${hex(CANARY_ANTHROPIC)}`,
  "hex (no prefix)": `payload ${hex(CANARY_OPENAI)} end`,
  "URL-encoded query": `GET /cb?code=${encodeURIComponent(`key=${CANARY_OPENAI}&x=1`)}`,
  "URL credentials": `git clone https://agent:${CANARY_OPENAI}@git.example.test/repo.git`,
};

describe("canary formats are fully redacted by the default redactor", () => {
  it.each(Object.entries(CASES))("%s", (_name, text) => {
    const r = safeRedact(text);
    expect(r.status).toBe("redacted");
    expect(leaks(r.text)).toBe(false);
  });

  it("defaultRedactor() redacts without any options", () => {
    expect(leaks(defaultRedactor()(CASES["env | sort dump"]!))).toBe(false);
  });

  it("the egress guard (no entropy heuristic) also sees base64/hex-encoded canaries", () => {
    expect(scanForLeaks(CASES["base64 of the value"]!)).toContain("encoded_secret");
    expect(scanForLeaks(CASES["hex"]!)).toContain("encoded_secret");
  });
});

describe("false-positive guards", () => {
  it("keeps temp paths with UUID / hash segments, but still redacts a random path segment", () => {
    const tmp = "/private/tmp/claude-501/-Users-dev-Desktop-hackathons-81agents/e12806d6-35d1-4210-8dab-a807163465a2/scratchpad/probe/notes.txt";
    expect(redact(tmp).text).toBe(tmp);
    const out = redact(`/home/agent/.cache/${ANT_TAIL}9q/creds`).text;
    expect(out).toBe("/home/agent/.cache/[REDACTED:high_entropy#1]/creds");
  });
});

describe("documented limitations (asserted so a change in behavior is noticed)", () => {
  it("a secret split across lines leaves the short prefix line (only the high-entropy tail is caught)", () => {
    const split = `key part 1: ${CANARY_ANTHROPIC.slice(0, 18)}\nkey part 2: ${CANARY_ANTHROPIC.slice(18)}`;
    const out = redact(split).text;
    expect(out).toContain(CANARY_ANTHROPIC.slice(0, 18)); // limitation: the vendor prefix fragment survives
    expect(out).not.toContain(ANT_TAIL); // the random tail is still removed (high_entropy)
  });

  it("a low-entropy secret in an unknown format with a non-secret-looking name is NOT detected", () => {
    expect(redact("db: user=app pass_phrase_word horse-battery-staple-river").status).toBe("clean");
  });
});

describe("fail closed", () => {
  it("returns the placeholder, never the original, when a detector throws", () => {
    const failures: string[] = [];
    const boom = { name: "boom", re: /x/, group: 0 };
    // A pattern whose `source` is not a valid RegExp makes the custom detector throw inside redact().
    Object.defineProperty(boom, "re", { get: () => ({ source: "(", flags: "" }) });
    const r = safeRedact(`secret ${CANARY_OPENAI}`, { customPatterns: [boom as never], onFailure: (i) => failures.push(i.error) });
    expect(r).toEqual({ text: REDACTION_FAILED_PLACEHOLDER, status: "failed", detectors: [] });
    expect(failures).toHaveLength(1);
    expect(failures[0]).not.toContain("KWCANARY");
  });

  it("non-string input fails closed", () => {
    expect(safeRedact(42 as unknown as string).status).toBe("failed");
  });

  it("keepCleanTextVerbatim makes a second pass idempotent over existing placeholders", () => {
    const first = safeRedact(`k ${CANARY_OPENAI}`).text;
    expect(safeRedact(first, { keepCleanTextVerbatim: true }).text).toBe(first);
  });
});

describe("operator-configured extra patterns", () => {
  const cfgJson = JSON.stringify({
    patterns: [{ name: "acme", regex: "acme_live_[A-Za-z0-9]{16}", flags: "i" }, "INTERNAL-[0-9]{6}-KEY"],
    known_secret_env: ["ACME_SIGNING_SECRET"],
  });

  it("redacts custom patterns and env-named known secrets", () => {
    const opts = redactionOptionsFromEnv(
      { KW_REDACTION_PATTERNS_FILE: "/cfg/patterns.json", ACME_SIGNING_SECRET: "plainwordsecretvalue" },
      (p) => (p === "/cfg/patterns.json" ? cfgJson : ""),
    );
    const r = safeRedact("use acme_live_ABCDEFGH12345678 or INTERNAL-123456-KEY; sig plainwordsecretvalue", opts);
    expect(r.text).not.toContain("acme_live_ABCDEFGH12345678");
    expect(r.text).not.toContain("INTERNAL-123456-KEY");
    expect(r.text).not.toContain("plainwordsecretvalue");
    expect(r.detectors).toEqual(expect.arrayContaining(["custom_pattern", "known_secret"]));
  });

  it("rejects invalid files loudly", () => {
    expect(() => parseRedactionConfig("{nope")).toThrow(RedactionConfigError);
    expect(() => parseRedactionConfig(JSON.stringify(["("]))).toThrow(RedactionConfigError);
    expect(() => parseRedactionConfig(JSON.stringify([".*"]))).toThrow(/empty string/);
    expect(() => redactionOptionsFromEnv({ KW_REDACTION_PATTERNS_FILE: "/missing" }, () => { throw new Error("ENOENT"); })).toThrow(RedactionConfigError);
  });

  it("without config, known secrets still come from the default env names", () => {
    const opts = redactionOptionsFromEnv({ AIAND_API_KEY: "aiandkeyvalue1234" });
    expect(safeRedact("x aiandkeyvalue1234 y", opts).text).not.toContain("aiandkeyvalue1234");
  });
});
