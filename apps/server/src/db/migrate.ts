import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { MIGRATIONS_DIR } from "../config";
import type { Db } from "./connection";

export interface Migration {
  version: number;
  name: string;
  sql: string;
}

const FILE_PATTERN = /^(\d{3})_([a-z0-9_]+)\.sql$/;

export function loadMigrations(dir: string = MIGRATIONS_DIR): Migration[] {
  const migrations = readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .map((file) => {
      const m = FILE_PATTERN.exec(file);
      if (!m) throw new Error(`Migration file name must match NNN_name.sql: ${file}`);
      return { version: Number(m[1]), name: m[2]!, sql: readFileSync(path.join(dir, file), "utf8") };
    })
    .sort((a, b) => a.version - b.version);
  // Gaps are allowed (parallel features claim distinct number ranges, e.g. 090_findings_snapshots); duplicates are not.
  migrations.forEach((m, i) => {
    if (m.version < 1) throw new Error(`Migration versions start at 001; found ${m.version}`);
    const prev = migrations[i - 1];
    if (prev && prev.version === m.version) throw new Error(`Duplicate migration version ${m.version}: ${prev.name} and ${m.name}`);
  });
  return migrations;
}

/** Applies pending migrations in order, each in its own transaction. Returns the versions applied by this call. */
export function applyMigrations(db: Db, migrations: Migration[] = loadMigrations()): number[] {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version    INTEGER PRIMARY KEY,
    name       TEXT NOT NULL,
    applied_at TEXT NOT NULL
  )`);
  const applied = new Set(
    (db.prepare("SELECT version FROM schema_migrations").all() as { version: number }[]).map((r) => r.version),
  );
  const newlyApplied: number[] = [];
  for (const m of migrations) {
    if (applied.has(m.version)) continue;
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec(m.sql);
      db.prepare("INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)").run(m.version, m.name, new Date().toISOString());
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw new Error(`Migration ${m.version}_${m.name} failed: ${(err as Error).message}`, { cause: err });
    }
    newlyApplied.push(m.version);
  }
  return newlyApplied;
}

export function appliedMigrations(db: Db): { version: number; name: string; applied_at: string }[] {
  return db.prepare("SELECT version, name, applied_at FROM schema_migrations ORDER BY version").all() as {
    version: number;
    name: string;
    applied_at: string;
  }[];
}
