#!/usr/bin/env node
// Underwatch hook forwarder (zero dependencies, Node >= 18).
//
// EVIDENCE CLASS: AGENT-SIDE / REPORTED. This script runs as a Claude Code command hook INSIDE the
// supervised agent's container, as the agent's user. Everything it writes is Claude Code's own account
// of what it is doing, and the log file is writable by the agent, so the agent (or anything it runs)
// can append, edit or delete lines. Never treat this log as authoritative evidence; independent
// observation lives outside the agent container.
//
// Contract (configured for every hook event by @kw/adapter-claude-code renderClaudeSettings):
//   stdin : the hook's JSON payload from Claude Code (docs: hooks.md "Hook input and output").
//   argv  : [optional] the event name this handler was configured for (cross-check only).
//   env   : KW_HOOK_LOG = absolute path of the NDJSON spool. If unset, the hook does nothing.
//   output: appends exactly ONE line {v, event, received_at, received_mono_ns, hook_pid, hook_ppid,
//           configured_event, payload, payload_error, raw, raw_bytes, truncated, evidence_class}.
//   stdout: NOTHING, ever. Hook stdout can become model context or a permission decision.
//   exit  : always 0, as fast as possible. This is an observation hook, never an enforcement hook;
//           enforcement hooks are separate handlers.
//
// It never reads, records or prints environment variable values.
import { openSync, writeSync, closeSync } from "node:fs";

const MAX_BYTES = 16 * 1024 * 1024; // keep at most 16 MiB of stdin; the rest is counted, not stored
const STDIN_DEADLINE_MS = 4000; // stop waiting for stdin after this; Claude Code closes it promptly
const LOG = process.env.KW_HOOK_LOG;
const configuredEvent = typeof process.argv[2] === "string" && process.argv[2] !== "" ? process.argv[2] : null;

const chunks = [];
let stored = 0;
let total = 0;
let done = false;

function monoNs() {
  // process.hrtime.bigint() is libuv uv_hrtime(), which reads CLOCK_MONOTONIC on Linux.
  // UNVERIFIED for cross-process comparison with kernel (bpf_ktime_get_ns) timestamps; ordering hint only.
  try {
    return process.hrtime.bigint().toString();
  } catch {
    return null;
  }
}

function finish() {
  if (done) return;
  done = true;
  try {
    if (!LOG) return;
    const buf = Buffer.concat(chunks, stored);
    const text = buf.toString("utf8");
    let payload = null;
    let payloadError = null;
    if (total === 0) payloadError = "empty_stdin";
    else if (total > stored) payloadError = "truncated";
    else {
      try {
        const parsed = JSON.parse(text);
        if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) payload = parsed;
        else payloadError = "not_an_object";
      } catch {
        payloadError = "invalid_json";
      }
    }
    const event =
      payload && typeof payload.hook_event_name === "string" ? payload.hook_event_name : configuredEvent;
    const record = {
      v: 1,
      event,
      received_at: new Date().toISOString(),
      received_mono_ns: monoNs(),
      hook_pid: process.pid,
      hook_ppid: process.ppid,
      configured_event: configuredEvent,
      payload,
      payload_error: payloadError,
      // Raw text is kept only when it could not be parsed, so nothing is lost.
      raw: payload === null && total > 0 ? text : null,
      raw_bytes: total,
      truncated: total > stored,
      evidence_class: "agent_reported",
    };
    const line = Buffer.from(JSON.stringify(record) + "\n", "utf8");
    // One write() on an O_APPEND descriptor: the kernel appends at the current end of file.
    const fd = openSync(LOG, "a", 0o600);
    try {
      let off = 0;
      while (off < line.length) off += writeSync(fd, line, off, line.length - off);
    } finally {
      closeSync(fd);
    }
  } catch {
    // Never block or fail the agent because observation failed. A missing line is visible as a gap
    // when the hook log is compared with stream-json.
  } finally {
    process.exit(0);
  }
}

const timer = setTimeout(finish, STDIN_DEADLINE_MS);
timer.unref();
try {
  process.stdin.on("data", (c) => {
    total += c.length;
    if (stored < MAX_BYTES) {
      const keep = c.subarray(0, Math.min(c.length, MAX_BYTES - stored));
      chunks.push(keep);
      stored += keep.length;
    }
  });
  process.stdin.on("end", finish);
  process.stdin.on("error", finish);
} catch {
  finish();
}
