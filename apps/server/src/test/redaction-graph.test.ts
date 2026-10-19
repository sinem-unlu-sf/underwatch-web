/**
 * ISSUE 3: the Neo4j projection is built from the (already redacted) relational rows, so no canary may reach node or
 * relationship properties. Always checks the projection plan offline; additionally projects into the live kw-neo4j when
 * it is reachable, under remapped ids (run_fx_kwredtest_*) so real fixture nodes are never touched, and deletes the
 * test run afterwards (deleteRun also prunes orphaned shared nodes).
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { KwGraph, parseRunBundle, planProjection, type RunBundle } from "@kw/graph";
import { afterAll, describe, expect, it } from "vitest";
import { openDatabase } from "../db/connection";
import { applyMigrations } from "../db/migrate";
import { runBundleFromDb } from "../graph/bundle-from-db";
import { importFixture } from "../ingest/fixtures";
import { CANARY_TEXT, findCanaryLeaks } from "./canaries";

const REPO_ROOT = path.resolve(import.meta.dirname, "../../../..");
const RUN04 = "run_fx_fx_04_env_read_via_bash";

function planted(): any {
  const fx = JSON.parse(readFileSync(path.join(REPO_ROOT, "fixtures/runs/fx-04-env-read-via-bash.json"), "utf8"));
  const f = fx.findings[0];
  fx.run.task_description = `${fx.run.task_description}\n${CANARY_TEXT.envDump}`;
  const ev = fx.events.find((e: any) => e.id === f.related_event_ids[0]);
  ev.target_resource = CANARY_TEXT.bashCommand;
  ev.summary = `Bash requested: ${CANARY_TEXT.bashCommand}`;
  ev.raw_summary = CANARY_TEXT.base64;
  f.title = `Bash call also ran ${CANARY_TEXT.argv.join(" ")}`;
  f.description = `${CANARY_TEXT.multilineLog} ${CANARY_TEXT.hex} ${CANARY_TEXT.urlEncoded}`;
  fx.evidence[0].excerpt = CANARY_TEXT.envDump;
  fx.evidence[1].source_reference = CANARY_TEXT.jsonEscaped;
  if (fx.safeguards[0]) fx.safeguards[0].title = `Deny ${CANARY_TEXT.bashCommand}`;
  return fx;
}

/** Bundle as the server projects it: read back from SQLite after ingestion. */
function bundleFromDb(): RunBundle {
  const db = openDatabase(":memory:");
  try {
    applyMigrations(db);
    expect(importFixture(db, planted()).ok).toBe(true);
    const raw = runBundleFromDb(db, RUN04);
    expect(raw).not.toBeNull();
    // Remap every owned id so a live projection can never collide with the real fx-04 nodes.
    const json = JSON.stringify(raw)
      .replace(/evt_([0-9a-f]{64})/g, (_m, h: string) => `evt_${createHash("sha256").update(`kwredtest:${h}`).digest("hex")}`)
      .replaceAll("fx04", "kwredtest04")
      .replaceAll("fx_04", "kwredtest_04");
    const parsed = parseRunBundle(JSON.parse(json));
    if (!parsed.ok) throw new Error(parsed.issues.join("; "));
    return parsed.bundle;
  } finally {
    db.close();
  }
}

describe("Neo4j projection carries no canary", () => {
  it("projection plan (nodes + relationship properties) built from stored rows", () => {
    const b = bundleFromDb();
    expect(b.run.id).toBe("run_fx_kwredtest_04_env_read_via_bash");
    const plan = planProjection(b);
    expect(plan.nodes.length).toBeGreaterThan(10);
    const text = JSON.stringify(plan);
    expect(findCanaryLeaks(text)).toEqual([]);
    expect(text).toContain("[REDACTED:"); // the planted fields were projected, in redacted form
  });

  const g = new KwGraph({ cwd: REPO_ROOT, connectionTimeoutMs: 2000 });
  let projectedRun: string | null = null;
  afterAll(async () => {
    if (projectedRun) await g.deleteRun(projectedRun);
    await g.close();
  });

  it("live kw-neo4j: every property of the projected run's nodes, relationships and neighbours", async (t) => {
    const health = await g.health();
    if (!health.ok) {
      console.warn(`[redaction] live Neo4j check SKIPPED: ${health.error.kind}`);
      t.skip();
      return;
    }
    const b = bundleFromDb();
    projectedRun = b.run.id;
    const receipt = await g.projectRunBundle(b);
    expect(receipt.ok).toBe(true);
    const r = await g.client.read(
      `MATCH (n {owner_run: $run}) OPTIONAL MATCH (n)-[r]-(m)
       RETURN properties(n) AS n, collect(properties(r)) AS rs, collect(properties(m)) AS ms`,
      { run: b.run.id },
      (rec) => JSON.stringify([rec.get("n"), rec.get("rs"), rec.get("ms")]),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.length).toBeGreaterThan(10);
    const all = r.value.join("\n");
    expect(findCanaryLeaks(all)).toEqual([]);
    expect(all).toContain("[REDACTED:");
  });
});
