/**
 * ISSUE 3 repair: supervised runs (POST /api/runs) go through the same storage-boundary redaction as persistRunBundle.
 * Synthetic KWCANARY canaries only; the executor is a stub (no Docker, no Claude, no real credentials).
 */
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { API_ROUTES, apiPaths, type StartSupervisedRunResponse } from "@kw/schema";
import { parseRunBundle, planProjection } from "@kw/graph";
import { buildApp } from "../app";
import { runBundleFromDb } from "../graph/bundle-from-db";
import { ensureAuthToken } from "../auth/token";
import { openDatabase, type Db } from "../db/connection";
import { getSupervisedService, type StoredCapture } from "../supervised";
import type { SupervisedExecutor } from "../supervised/runner";
import { CANARY, CANARY_TEXT, findCanaryLeaks } from "./canaries";
import { authHeaders, createTestPaths, WEB_HEADERS } from "./helpers";

const RECORDED = JSON.parse(readFileSync(new URL("./fixtures/supervised-capture-recorded.json", import.meta.url), "utf8")) as StoredCapture;
const allOk = async () => ["docker", "agent_image", "proxy_image", "claude_token", "broker_image"].map((id) => ({ id, ok: true, detail: "test" }));
const TASK = `Deploy using the key ${CANARY.anthropic} and token ${CANARY.github}, then report`;

const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (closers.length) await closers.pop()!();
});

async function setup(executor: SupervisedExecutor) {
  const captured: string[] = [];
  const db = openDatabase(":memory:");
  const paths = createTestPaths();
  const app = await buildApp({ db, dbLocation: { path: ":memory:", configuredVia: "test" }, env: {}, validateResponses: true, logger: { level: "debug", stream: { write: (m: string) => void captured.push(m) } }, paths });
  closers.push(async () => {
    await app.close();
    db.close();
  });
  const canary = (file: string) => RECORDED.canaries.find((c) => c.file === file)?.value ?? `kw-synthetic-canary-test-${file.length}`;
  const svc = getSupervisedService(app.kw, { executor, canary, checkHarness: allOk });
  const headers = { ...authHeaders(ensureAuthToken(paths.dataDir)), ...WEB_HEADERS, "content-type": "application/json" };
  const post = async (body: unknown) => {
    const r = await app.inject({ method: "POST", url: API_ROUTES.runs, headers, payload: JSON.stringify(body) });
    return { status: r.statusCode, text: r.body, body: r.json() as StartSupervisedRunResponse };
  };
  const get = async (url: string) => (await app.inject({ method: "GET", url, headers })).body;
  return { db, svc, post, get, captured };
}

function dumpAllTables(db: Db): string {
  const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((r) => r.name);
  return tables.map((t) => JSON.stringify(db.prepare(`SELECT * FROM "${t}"`).all())).join("\n");
}

describe("supervised run storage-boundary redaction", () => {
  it("a harness error quoting secrets is stored, returned and logged redacted; the executor still got the raw task", async () => {
    let seenTask = "";
    const { db, svc, post, get, captured } = await setup(async (input) => {
      seenTask = input.task;
      throw new Error(`docker failed: ${CANARY_TEXT.envDump}\n${CANARY_TEXT.bashCommand}`);
    });
    const start = await post({ client_request_id: "red-sr-0001", task: TASK });
    expect(start.status).toBe(202);
    await svc.wait(start.body.run.id);
    // The agent needs the real task text; only storage/API/logs are redacted.
    expect(seenTask).toBe(TASK);
    const row = db.prepare("SELECT task, error, limitations, status FROM supervised_runs WHERE run_id = ?").get(start.body.run.id) as Record<string, string>;
    expect(row.status).toBe("failed");
    expect(row.error).toContain("[REDACTED:");
    expect(findCanaryLeaks(JSON.stringify(row))).toEqual([]);
    expect(findCanaryLeaks(start.text)).toEqual([]);
    expect(findCanaryLeaks(await get(apiPaths.run(start.body.run.id)))).toEqual([]);
    expect(findCanaryLeaks(dumpAllTables(db))).toEqual([]);
    expect(findCanaryLeaks(captured.join(""))).toEqual([]);
    const rr = db.prepare("SELECT status, detectors FROM record_redactions WHERE table_name = 'runs' AND record_id = ?").get(start.body.run.id) as { status: string; detectors: string };
    expect(rr.status).toBe("redacted");
    expect(JSON.parse(rr.detectors)).toContain("anthropic_key");
  });

  it("full recorded-capture ingest leaves no canary in any table; replay with the same task is idempotent, a different task conflicts", async () => {
    const { db, svc, post } = await setup(async () => structuredClone(RECORDED.capture));
    const first = await post({ client_request_id: "red-sr-0002", task: TASK });
    expect(first.status).toBe(202);
    await svc.wait(first.body.run.id);
    expect(findCanaryLeaks(dumpAllTables(db))).toEqual([]);
    // Neo4j projection (Task node from run.task_description) is built from the stored rows: no canary in the plan.
    const parsed = parseRunBundle(runBundleFromDb(db, first.body.run.id));
    if (!parsed.ok) throw new Error(parsed.issues.join("; "));
    const plan = JSON.stringify(planProjection(parsed.bundle));
    expect(plan).toContain("[REDACTED:");
    expect(findCanaryLeaks(plan)).toEqual([]);
    const again = await post({ client_request_id: "red-sr-0002", task: TASK });
    expect(again.status).toBe(202);
    expect(again.body.replayed).toBe(true);
    expect(findCanaryLeaks(again.text)).toEqual([]);
    const other = await post({ client_request_id: "red-sr-0002", task: "a different task" });
    expect(other.status).toBe(409);
  });
});

describe("finding status-change notes (user-typed free text)", () => {
  it("a note quoting a secret is stored and returned redacted", async () => {
    const { buildFixtureFile } = await import("./bundle");
    const { importFixture } = await import("../ingest/fixtures");
    const { createTestApp, postJson } = await import("./helpers");
    const t = await createTestApp();
    closers.push(() => t.close());
    expect(importFixture(t.db, buildFixtureFile("fx-note")).ok).toBe(true);
    const res = await postJson(t.app, apiPaths.findingStatus("fnd_fx_note_1"), { to: "under_review", note: `checked with ${CANARY.openai}` });
    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).toContain("[REDACTED:");
    expect(findCanaryLeaks(JSON.stringify(res.body))).toEqual([]);
    expect(findCanaryLeaks(JSON.stringify(t.db.prepare("SELECT note FROM finding_status_history").all()))).toEqual([]);
  });
});
