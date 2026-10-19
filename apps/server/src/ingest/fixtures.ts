import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { FixtureRunFile } from "@kw/schema";
import type { Db } from "../db/connection";
import { emptyCounts, persistRunBundle, type BundleTable, type IngestConflict, type TableCounts } from "./persist";

export type FixtureImportOutcome =
  | { file: string; ok: true; fixture_id: string; run_id: string; counts: Record<BundleTable, TableCounts>; conflicts: IngestConflict[] }
  | { file: string; ok: false; errors: string[] };

/** Validates raw JSON against FixtureRunFile (including is_fixture: true on every record) and persists it idempotently. */
export function importFixture(db: Db, raw: unknown, file = "<inline>"): FixtureImportOutcome {
  const parsed = FixtureRunFile.safeParse(raw);
  if (!parsed.success) {
    return {
      file,
      ok: false,
      errors: parsed.error.issues.map((i) => `${i.path.length ? i.path.join(".") : "<root>"}: ${i.message}`),
    };
  }
  const f = parsed.data;
  try {
    const { counts, conflicts } = persistRunBundle(db, f);
    return { file, ok: true, fixture_id: f.fixture_id, run_id: f.run.id, counts, conflicts };
  } catch (err) {
    return { file, ok: false, errors: [`database: ${(err as Error).message}`] };
  }
}

export function importFixtureFile(db: Db, filePath: string): FixtureImportOutcome {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(filePath, "utf8"));
  } catch (err) {
    return { file: filePath, ok: false, errors: [`read/parse: ${(err as Error).message}`] };
  }
  return importFixture(db, raw, filePath);
}

export function listFixtureFiles(dir: string): string[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => path.join(dir, f));
}

export function totalCounts(outcomes: FixtureImportOutcome[]): Record<BundleTable, TableCounts> {
  const total = emptyCounts();
  for (const o of outcomes) {
    if (!o.ok) continue;
    for (const [table, c] of Object.entries(o.counts) as [BundleTable, TableCounts][]) {
      total[table].inserted += c.inserted;
      total[table].skipped += c.skipped;
    }
  }
  return total;
}
