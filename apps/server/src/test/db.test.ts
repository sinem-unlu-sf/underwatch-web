import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openDatabase, type Db } from "../db/connection";
import { appliedMigrations, applyMigrations, loadMigrations } from "../db/migrate";
import { BUNDLE_TABLES } from "../ingest/persist";
import { importFixture, importFixtureFile } from "../ingest/fixtures";
import { buildFixtureFile } from "./bundle";
import { tableCount } from "./helpers";

let db: Db | undefined;
afterEach(() => {
  db?.close();
  db = undefined;
});

const allCounts = (d: Db) => Object.fromEntries(BUNDLE_TABLES.map((t) => [t, tableCount(d, t)]));

describe("migrations", () => {
  it("apply once, record versions, and are a no-op on re-run", () => {
    db = openDatabase(":memory:");
    const expected = loadMigrations().map((m) => m.version);
    expect(appliedMigrations(db).map((m) => m.version)).toEqual(expected);
    expect(applyMigrations(db)).toEqual([]);
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((r) => r.name);
    expect(tables).toEqual(expect.arrayContaining([...BUNDLE_TABLES, "schema_migrations"]));
  });

  it("persist across reopen of a file database", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "kw-db-"));
    try {
      const file = path.join(dir, "kw.db");
      const first = openDatabase(file);
      importFixture(first, buildFixtureFile("fx-reopen"));
      first.close();
      db = openDatabase(file);
      expect(tableCount(db, "runs")).toBe(1);
      expect(appliedMigrations(db)).toHaveLength(loadMigrations().length);
    } finally {
      db?.close();
      db = undefined;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("make finding_status_history append-only at the database level", () => {
    db = openDatabase(":memory:");
    importFixture(db, buildFixtureFile("fx-append-only"));
    expect(() => db!.prepare("UPDATE finding_status_history SET note = 'x'").run()).toThrow(/append-only/);
    expect(() => db!.prepare("DELETE FROM finding_status_history").run()).toThrow(/append-only/);
    expect(tableCount(db, "finding_status_history")).toBe(3);
  });
});

describe("fixture import", () => {
  it("is idempotent: importing the same fixture twice creates no duplicates", () => {
    db = openDatabase(":memory:");
    const fixture = buildFixtureFile("fx-idempotent");

    const first = importFixture(db, fixture);
    expect(first.ok, JSON.stringify(first)).toBe(true);
    const afterFirst = allCounts(db);

    const second = importFixture(db, structuredClone(fixture));
    expect(second.ok).toBe(true);
    expect(allCounts(db)).toEqual(afterFirst);

    if (!first.ok || !second.ok) throw new Error("unreachable");
    for (const table of BUNDLE_TABLES) {
      expect(first.counts[table].skipped, table).toBe(0);
      expect(second.counts[table].inserted, table).toBe(0);
      expect(second.counts[table].skipped, table).toBe(first.counts[table].inserted);
      expect(first.counts[table].inserted, table).toBe(afterFirst[table]);
    }
    expect(second.conflicts).toEqual([]);
    expect(afterFirst).toMatchObject({ runs: 1, events: 4, evidence: 2, findings: 2, finding_status_history: 3, finding_events: 3 });
  });

  it("reports a conflict when a stored record differs under the same id, keeping the stored row", () => {
    db = openDatabase(":memory:");
    const fixture = buildFixtureFile("fx-conflict");
    importFixture(db, fixture);
    const changed = structuredClone(fixture);
    changed.run.label = "Changed label";
    const result = importFixture(db, changed);
    expect(result.ok && result.conflicts).toEqual([{ table: "runs", key: changed.run.id, fields: ["label"] }]);
    expect(db.prepare("SELECT label FROM runs").get()).toMatchObject({ label: "Test run fx-conflict" });
  });

  it("rejects records not marked is_fixture and writes nothing", () => {
    db = openDatabase(":memory:");
    const bad = buildFixtureFile("fx-bad");
    (bad.events[0] as { is_fixture: boolean }).is_fixture = false;
    const result = importFixture(db, bad);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.errors.join("\n")).toMatch(/events\.0\.is_fixture/);
    expect(tableCount(db, "runs")).toBe(0);
  });

  it("imports from a JSON file and reports unreadable files", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "kw-fx-"));
    try {
      db = openDatabase(":memory:");
      const good = path.join(dir, "good.json");
      writeFileSync(good, JSON.stringify(buildFixtureFile("fx-file")));
      const broken = path.join(dir, "broken.json");
      writeFileSync(broken, "{ not json");
      expect(importFixtureFile(db, good)).toMatchObject({ ok: true, run_id: "run_fx_fx_file" });
      expect(importFixtureFile(db, broken)).toMatchObject({ ok: false });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
