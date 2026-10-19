/**
 * ISSUE 3: secret redaction is the default at the storage boundary. Synthetic canaries (see ./canaries) are planted in
 * every free-text field of a fixture bundle; none may survive into SQLite, API responses, application logs, or the
 * outbound Ask Witness request body (fake transport, no network).
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { AiAndProvider, buildEvidenceBundle, type HttpRequest, type HttpResponse, type HttpTransport } from "@kw/inference";
import { REDACTION_FAILED_PLACEHOLDER } from "@kw/redaction";
import { apiPaths } from "@kw/schema";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../app";
import { ensureAuthToken } from "../auth/token";
import { openDatabase, type Db } from "../db/connection";
import { applyMigrations } from "../db/migrate";
import { importFixture } from "../ingest/fixtures";
import { persistRunBundle } from "../ingest/persist";
import { sanitizeRunBundle } from "../ingest/sanitize";
import { CANARY, CANARY_TEXT, findCanaryLeaks } from "./canaries";
import { authHeaders, createTestPaths, WEB_HEADERS } from "./helpers";

const FX_DIR = path.resolve(import.meta.dirname, "../../../../fixtures/runs");
const FX04 = "fnd_fx04_env_read_via_bash";
const RUN04 = "run_fx_fx_04_env_read_via_bash";

function loadFixture(name: string): any {
  return JSON.parse(readFileSync(path.join(FX_DIR, `${name}.json`), "utf8"));
}

/** fx-04 with canaries in every free-text field the storage layer keeps. */
function plantedFixture(): any {
  const fx = loadFixture("fx-04-env-read-via-bash");
  fx.run.task_description = `${fx.run.task_description}\n${CANARY_TEXT.envDump}`;
  const f = fx.findings.find((x: any) => x.id === FX04);
  const ev0 = fx.events.find((e: any) => e.id === f.related_event_ids[0]);
  const ev1 = fx.events.find((e: any) => e.id === f.related_event_ids[1]) ?? fx.events[1];
  const evd0 = fx.evidence.find((v: any) => v.id === f.evidence_ids[0]);
  const others = fx.evidence.filter((v: any) => v !== evd0);
  evd0.excerpt = CANARY_TEXT.envDump;
  evd0.redaction_status = "not_scanned";
  others[0].excerpt = CANARY_TEXT.commandOutput;
  others[1].excerpt = `${CANARY_TEXT.multilineLog}\n${CANARY_TEXT.jsonEscaped}`;
  others[2].source_reference = `capture.log?${CANARY_TEXT.urlEncoded}`;
  ev0.summary = `Bash requested: ${CANARY_TEXT.bashCommand}`;
  ev0.target_resource = CANARY_TEXT.bashCommand;
  ev1.raw_summary = CANARY_TEXT.base64;
  ev1.limitations = [...ev1.limitations, CANARY_TEXT.hex];
  // Observed argv embedded in analysis finding text (the path that bypasses the adapter).
  f.title = `Bash call also ran ${CANARY_TEXT.argv.join(" ")}`;
  f.description = `The command "${CANARY_TEXT.bashCommand}" spawned ${CANARY_TEXT.argv.join(" ")}; ${CANARY_TEXT.urlEncoded}`;
  f.recommended_next_step = `Rotate the key behind ${CANARY_TEXT.hex}`;
  f.missing_information = [...f.missing_information, CANARY_TEXT.multilineLog];
  if (fx.correlations[0]) fx.correlations[0].note = CANARY_TEXT.commandOutput;
  if (fx.finding_status_history[0]) fx.finding_status_history[0].note = CANARY_TEXT.jsonEscaped;
  if (fx.safeguards[0]) fx.safeguards[0].intended_effect = `Block ${CANARY_TEXT.bashCommand}`;
  if (fx.verification_runs[0]) fx.verification_runs[0].notes = CANARY_TEXT.envDump;
  return fx;
}

function dumpAllTables(db: Db): string {
  const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((r) => r.name);
  return tables.map((t) => `${t}: ${JSON.stringify(db.prepare(`SELECT * FROM "${t}"`).all())}`).join("\n");
}

function completion(content: unknown): HttpResponse {
  return {
    status: 200,
    headers: { "content-type": "application/json", "x-request-id": "req-redaction-1" },
    body: JSON.stringify({
      id: "chatcmpl-redaction",
      object: "chat.completion",
      model: "deepseek-ai/deepseek-v4-flash",
      choices: [{ index: 0, message: { role: "assistant", content: JSON.stringify(content) }, finish_reason: "stop" }],
      usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
    }),
  };
}

const ANSWER = {
  summary: "The agent ran a command that printed environment variables.",
  verified_facts: [],
  hypotheses: [],
  unknowns: [{ text: "Whether the output left the container." }],
  evidence_references: [],
  recommended_next_steps: ["Check egress logs."],
  recommended_safeguards: [],
  insufficient_evidence: false,
};

const closers: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const c of closers.splice(0)) await c();
  vi.restoreAllMocks();
});

describe("storage-boundary redaction (persistRunBundle)", () => {
  it("no canary survives in any SQLite table; ids/timestamps/source are preserved; status recorded per record", () => {
    const db = openDatabase(":memory:");
    closers.push(() => db.close());
    applyMigrations(db);
    const fx = plantedFixture();
    const before = JSON.stringify(fx);
    expect(findCanaryLeaks(before).length).toBeGreaterThan(0); // the plant worked

    const out = importFixture(db, fx);
    expect(out.ok).toBe(true);
    expect(JSON.stringify(fx)).toBe(before); // input object not mutated

    const dump = dumpAllTables(db);
    expect(findCanaryLeaks(dump)).toEqual([]);
    expect(dump).toContain("[REDACTED:");

    // identity fields untouched
    const ids = (db.prepare("SELECT id, timestamp, source, basis FROM events WHERE run_id = ? ORDER BY id").all(RUN04) as any[]).map((r) => ({ ...r }));
    const expected = fx.events.map((e: any) => ({ id: e.id, timestamp: e.timestamp, source: e.source, basis: e.basis })).sort((a: any, b: any) => a.id.localeCompare(b.id));
    expect(ids).toEqual(expected);

    // per-record redaction status
    const statuses = db.prepare("SELECT table_name, record_id, status, detectors FROM record_redactions WHERE status != 'clean'").all() as any[];
    expect(statuses.map((s) => s.table_name)).toEqual(expect.arrayContaining(["runs", "evidence", "events", "findings"]));
    expect(statuses.every((s) => s.status === "redacted")).toBe(true);
    expect(JSON.stringify(statuses)).not.toMatch(/KWCANARY/);
    const evd0 = fx.findings.find((x: any) => x.id === FX04).evidence_ids[0];
    expect((db.prepare("SELECT redaction_status FROM evidence WHERE id = ?").get(evd0) as any).redaction_status).toBe("redacted");
  });

  it("is idempotent: re-importing the same planted bundle inserts nothing and reports no conflicts", () => {
    const db = openDatabase(":memory:");
    closers.push(() => db.close());
    applyMigrations(db);
    expect(importFixture(db, plantedFixture()).ok).toBe(true);
    const again = importFixture(db, plantedFixture());
    expect(again.ok && again.conflicts).toEqual([]);
  });

  it("fails closed: a throwing detector stores [REDACTION_FAILED], marks the record, logs without the text", () => {
    const db = openDatabase(":memory:");
    closers.push(() => db.close());
    applyMigrations(db);
    const fx = plantedFixture();
    const boom = { name: "boom", group: 0 } as { name: string; group: number; re: RegExp };
    Object.defineProperty(boom, "re", { get: () => ({ source: "(", flags: "" }) }); // invalid at use time -> throws
    const logs: string[] = [];
    const res = persistRunBundle(db, fx, { redaction: { customPatterns: [boom] }, onFailure: (i) => logs.push(JSON.stringify(i)) });
    expect(res.counts.events.inserted).toBe(fx.events.length);
    const dump = dumpAllTables(db);
    expect(findCanaryLeaks(dump)).toEqual([]);
    expect(dump).toContain(REDACTION_FAILED_PLACEHOLDER);
    const failed = db.prepare("SELECT COUNT(*) AS n FROM record_redactions WHERE status = 'failed'").get() as any;
    expect(Number(failed.n)).toBeGreaterThan(0);
    expect((db.prepare("SELECT COUNT(*) AS n FROM evidence WHERE redaction_status = 'withheld'").get() as any).n).toBeGreaterThan(0);
    // events keep their identity even when their text could not be redacted
    expect((db.prepare("SELECT COUNT(*) AS n FROM events WHERE run_id = ?").get(RUN04) as any).n).toBe(fx.events.length);
    expect(logs.length).toBeGreaterThan(0);
    expect(findCanaryLeaks(logs.join("\n"))).toEqual([]);
  });

  it("covers argv-shaped finding text and operator patterns from KW_REDACTION_PATTERNS_FILE-style options", () => {
    const fx = plantedFixture();
    fx.findings[0].title = "Unreported exec of /opt/acme/bin/sync --token acme_live_ABCDEFGH12345678";
    const { bundle, records } = sanitizeRunBundle(fx, { redaction: { customPatterns: [{ name: "acme", re: /acme_live_[A-Za-z0-9]{16}/, group: 0 }] } });
    expect(bundle.findings[0]!.title).toBe("Unreported exec of /opt/acme/bin/sync --token [REDACTED:custom_pattern#1]");
    expect(records.find((r) => r.table === "findings" && r.id === fx.findings[0].id)?.detectors).toContain("custom_pattern");
  });
});

describe("downstream destinations", () => {
  it("API responses, application logs and the Ask Witness outbound body carry no canary", async () => {
    const requests: HttpRequest[] = [];
    const transport: HttpTransport = async (req) => {
      requests.push(req);
      return completion(ANSWER);
    };
    const TEST_KEY = "sk-kwtest-redaction-key-000000000000000000000000";
    const inference = new AiAndProvider({ apiKey: TEST_KEY, maxRetries: 0, baseBackoffMs: 1, timeoutMs: 2_000, maxRetryWaitMs: 5 }, { transport, sleep: async () => {} });

    // Capture everything the app logs (Fastify logger at debug level into a stream) plus console output.
    const captured: string[] = [];
    const logStream = { write: (msg: string) => void captured.push(msg) };
    for (const m of ["log", "info", "warn", "error", "debug"] as const) vi.spyOn(console, m).mockImplementation((...a: unknown[]) => void captured.push(a.map(String).join(" ")));

    const db = openDatabase(":memory:");
    const paths = createTestPaths();
    const app = await buildApp({ db, dbLocation: { path: ":memory:", configuredVia: "test" }, env: {}, validateResponses: true, logger: { level: "debug", stream: logStream }, inference, paths });
    closers.push(async () => {
      await app.close();
      db.close();
    });
    const headers = authHeaders(ensureAuthToken(paths.dataDir));
    expect(importFixture(db, plantedFixture()).ok).toBe(true);

    const bodies: string[] = [];
    const get = async (url: string) => {
      const r = await app.inject({ method: "GET", url, headers });
      expect(r.statusCode, url).toBe(200);
      bodies.push(r.body);
      return r.json();
    };
    await get(apiPaths.overview());
    await get(apiPaths.runs());
    await get(apiPaths.run(RUN04));
    await get(apiPaths.runEvents(RUN04));
    await get(apiPaths.runFindings(RUN04));
    await get(apiPaths.findings());
    const detail = await get(apiPaths.finding(FX04));
    for (const v of detail.evidence ?? []) await get(apiPaths.evidence(v.id));
    await get(apiPaths.safeguards());

    // Ask Witness: the question itself also carries a canary.
    const asked = await app.inject({
      method: "POST",
      url: apiPaths.findingInvestigations(FX04),
      headers: { ...headers, ...WEB_HEADERS },
      payload: { question: `Did the agent leak ${CANARY.openai} or anything from: ${CANARY_TEXT.envDump}?`, client_request_id: "req-redaction-0001" },
    });
    expect(asked.statusCode).toBe(200);
    bodies.push(asked.body);
    const inv = asked.json();
    await get(apiPaths.investigation(inv.investigation.id));
    await get(apiPaths.findingInvestigations(FX04));

    expect(requests.length).toBeGreaterThan(0); // the request really went out (fake transport)
    expect(["answered", "insufficient_evidence"]).toContain(inv.turn.status); // the model reply was accepted, not blocked
    for (const r of requests) {
      expect(findCanaryLeaks(r.body ?? "")).toEqual([]);
      expect(findCanaryLeaks(JSON.stringify(r.headers))).toEqual([]);
    }
    expect(findCanaryLeaks(bodies.join("\n"))).toEqual([]);
    expect(findCanaryLeaks(dumpAllTables(db))).toEqual([]); // includes investigations / investigation_turns
    expect(captured.join("").length).toBeGreaterThan(0);
    expect(findCanaryLeaks(captured.join(""))).toEqual([]);
  });
});

describe("inference layer on its own (defense in depth: no DB sanitizer in front)", () => {
  it("buildEvidenceBundle + AiAndProvider never put a raw canary in the outbound request, even from UNREDACTED records", async () => {
    const fx = plantedFixture(); // raw, never persisted, so the storage sanitizer did not run
    const finding = fx.findings.find((x: any) => x.id === FX04);
    const bundle = buildEvidenceBundle({
      finding,
      events: fx.events,
      evidence: fx.evidence,
      policy: fx.policy_version,
      coverage: { report: fx.coverage, targets: [], observed_event_ids_on_targets: [] },
      safeguards: fx.safeguards.map((sg: any) => ({ safeguard: sg, verification: null })),
      relatedFindings: [],
    });
    expect(findCanaryLeaks(JSON.stringify(bundle))).toEqual([]);
    const requests: HttpRequest[] = [];
    const provider = new AiAndProvider(
      { apiKey: "sk-kwtest-inference-only-0000000000000000000000", maxRetries: 0, baseBackoffMs: 1, timeoutMs: 2_000, maxRetryWaitMs: 5 },
      { transport: async (req) => (requests.push(req), completion(ANSWER)), sleep: async () => {} },
    );
    // A question that is NOT pre-redacted: the egress guard must block it rather than send it.
    const blocked = await provider.askWitness(`what about ${CANARY.anthropic}?`, bundle, []);
    expect(blocked.status).toBe("unavailable");
    expect(requests).toHaveLength(0);
    const ok = await provider.askWitness("Did the agent read the environment?", bundle, []);
    expect(ok.status).toBe("ok");
    expect(requests).toHaveLength(1);
    expect(findCanaryLeaks(requests[0]!.body ?? "")).toEqual([]);
  });
});

describe("application logs", () => {
  it("an unhandled error whose message/stack quotes a secret is logged redacted", async () => {
    const captured: string[] = [];
    const db = openDatabase(":memory:");
    const paths = createTestPaths();
    const app = await buildApp({ db, dbLocation: { path: ":memory:", configuredVia: "test" }, env: {}, logger: { level: "debug", stream: { write: (m: string) => void captured.push(m) } }, paths });
    closers.push(async () => {
      await app.close();
      db.close();
    });
    app.get("/api/__redaction_boom", async () => {
      throw new Error(`upstream rejected ${CANARY_TEXT.bashCommand}\n${CANARY_TEXT.envDump}`);
    });
    const r = await app.inject({ method: "GET", url: "/api/__redaction_boom", headers: authHeaders(ensureAuthToken(paths.dataDir)) });
    expect(r.statusCode).toBe(500);
    expect(findCanaryLeaks(r.body)).toEqual([]);
    const logs = captured.join("");
    expect(logs).toContain("unhandled error");
    expect(logs).toContain("[REDACTED:");
    expect(findCanaryLeaks(logs)).toEqual([]);
  });
});
