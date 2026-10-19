#!/usr/bin/env node
// Copies the REAL Claude Code 2.1.302 probe captures (synthetic secrets only) into test/fixtures/,
// replacing personal identifiers so the fixtures can be committed:
//   - e-mail addresses (except anthropic.com) -> user@example.invalid
//   - the claude.ai organization UUID       -> 00000000-0000-0000-0000-000000000000
//   - the OS account name (and KW_SANITIZE_EXTRA literals) -> kwuser
// Replacements are plain-text and contain no JSON-special characters, so every JSON line stays valid
// and tool_use_id / session_id / uuid values (which correlate the three channels) are untouched.
// Synthetic secrets (KW_SYNTHETIC_SECRET=kw-test-0000, secrets/token.txt) are kept on purpose: the tests
// assert on them.
//
// usage: KW_SANITIZE_EXTRA=<git user name,...> node scripts/import-captures.mjs <research/claude-code/probe-out dir>
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { userInfo } from "node:os";
import { fileURLToPath } from "node:url";

const src = process.argv[2];
if (!src || !existsSync(src)) {
  console.error("usage: node scripts/import-captures.mjs <probe-out dir>");
  process.exit(64);
}
const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, "..", "test", "fixtures", "captures");

// No personal identifier is written in this file. Generic patterns cover e-mail addresses and the
// organizationUuid field; the account name comes from the current OS user, plus optional extra literals
// in KW_SANITIZE_EXTRA (comma-separated, e.g. a git user name).
const esc = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const literals = [userInfo().username, ...(process.env.KW_SANITIZE_EXTRA ?? "").split(",")]
  .map((x) => x.trim())
  .filter((x) => x.length >= 3 && x !== "kwuser");
const REPLACEMENTS = [
  [/[A-Za-z0-9._%+-]+@(?!anthropic\.com\b|example\.invalid\b)[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g, "user@example.invalid"],
  [/("organizationUuid"\s*:\s*")[0-9a-f-]{36}"/gi, (_m, pre) => `${pre}00000000-0000-0000-0000-000000000000"`],
  ...literals.map((l) => [new RegExp(`\\b${esc(l)}\\b`, "g"), "kwuser"]),
];
const LEFTOVER = literals.length ? new RegExp(literals.map(esc).join("|"), "i") : null;
const FILES = ["hooks.jsonl", "stream.jsonl", "transcript.jsonl", "prompt.txt", "session-id.txt", "stderr.txt", "exit_code.txt"];

for (const run of ["run1", "run2", "run3"]) {
  mkdirSync(join(out, run), { recursive: true });
  for (const f of FILES) {
    const p = join(src, run, f);
    if (!existsSync(p)) continue;
    let text = readFileSync(p, "utf8");
    for (const [re, rep] of REPLACEMENTS) text = text.replace(re, rep);
    if (f.endsWith(".jsonl")) {
      for (const [i, line] of text.split("\n").entries()) {
        if (line.trim() === "") continue;
        JSON.parse(line); // throws if a replacement broke a line
        if (LEFTOVER?.test(line)) throw new Error(`${run}/${f}:${i + 1} still contains a personal identifier`);
      }
    }
    writeFileSync(join(out, run, f), text);
  }
  console.log(`imported ${run}`);
}
