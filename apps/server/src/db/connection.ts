import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { applyMigrations } from "./migrate";

export type Db = DatabaseSync;

/** Opens (creating if needed) the SQLite database and brings it to the latest migration. */
export function openDatabase(dbPath: string): Db {
  if (dbPath !== ":memory:") mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
  if (dbPath !== ":memory:") db.exec("PRAGMA journal_mode = WAL;");
  applyMigrations(db);
  return db;
}

/** Runs fn inside a transaction. IMMEDIATE takes the write lock up front so read-check-write sequences are atomic. */
export function transaction<T>(db: Db, fn: () => T, mode: "DEFERRED" | "IMMEDIATE" = "IMMEDIATE"): T {
  db.exec(`BEGIN ${mode}`);
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}
