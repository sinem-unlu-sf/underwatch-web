import type { SQLInputValue, StatementSync } from "node:sqlite";
import type { Db } from "./connection";

type FieldKind = "text" | "int" | "bool" | "json";

interface FieldSpec {
  kind: FieldKind;
  /** Column name when it differs from the field name (e.g. reserved words). */
  column?: string;
}

type Row = Record<string, SQLInputValue>;

const statementCache = new WeakMap<Db, Map<string, StatementSync>>();

/** Prepared-statement cache keyed by SQL text, per connection. */
export function stmt(db: Db, sql: string): StatementSync {
  let cache = statementCache.get(db);
  if (!cache) statementCache.set(db, (cache = new Map()));
  let s = cache.get(sql);
  if (!s) cache.set(sql, (s = db.prepare(sql)));
  return s;
}

/**
 * Maps one entity type to one table. Column order follows the field map; reads return fields in the same order so
 * re-serialized records compare equal.
 */
export class TableCodec<T extends object> {
  private readonly entries: [keyof T & string, Required<FieldSpec>][];
  readonly selectColumns: string;

  constructor(
    readonly table: string,
    readonly primaryKey: (keyof T & string)[],
    fields: { [K in keyof T & string]: FieldKind | FieldSpec },
  ) {
    this.entries = (Object.entries(fields) as [keyof T & string, FieldKind | FieldSpec][]).map(([key, spec]) => {
      const s = typeof spec === "string" ? { kind: spec } : spec;
      return [key, { kind: s.kind, column: s.column ?? key }];
    });
    this.selectColumns = this.entries.map(([, s]) => s.column).join(", ");
  }

  /** Column list with a table alias, for joins. */
  columns(alias: string): string {
    return this.entries.map(([, s]) => `${alias}.${s.column}`).join(", ");
  }

  toRow(value: T): Row {
    const row: Row = {};
    for (const [key, spec] of this.entries) {
      const v = value[key] as unknown;
      row[spec.column] = encode(spec.kind, v, `${this.table}.${spec.column}`);
    }
    return row;
  }

  fromRow(row: Record<string, unknown>): T {
    const out: Record<string, unknown> = {};
    for (const [key, spec] of this.entries) out[key] = decode(spec.kind, row[spec.column]);
    return out as T;
  }

  /** INSERT OR IGNORE. Returns true when a row was inserted, false when a row with the same key already existed. */
  insertOrIgnore(db: Db, value: T): boolean {
    const cols = this.entries.map(([, s]) => s.column);
    const sql = `INSERT OR IGNORE INTO ${this.table} (${cols.join(", ")}) VALUES (${cols.map((c) => `:${c}`).join(", ")})`;
    return stmt(db, sql).run(this.toRow(value)).changes > 0;
  }

  /** Existing row with the same primary key as value, or null. */
  findExisting(db: Db, value: T): T | null {
    const where = this.primaryKey.map((k) => `${this.columnOf(k)} = ?`).join(" AND ");
    const params = this.primaryKey.map((k) => this.toRow(value)[this.columnOf(k)]!);
    const row = stmt(db, `SELECT ${this.selectColumns} FROM ${this.table} WHERE ${where}`).get(...params);
    return row ? this.fromRow(row) : null;
  }

  /** Field names whose stored values differ between two records (after DB round-trip normalization). */
  diff(a: T, b: T, ignore: readonly (keyof T)[] = []): string[] {
    const ra = this.toRow(a);
    const rb = this.toRow(b);
    return this.entries.filter(([key, s]) => !ignore.includes(key) && ra[s.column] !== rb[s.column]).map(([key]) => key);
  }

  columnOf(key: keyof T & string): string {
    const entry = this.entries.find(([k]) => k === key);
    if (!entry) throw new Error(`Unknown field ${String(key)} on ${this.table}`);
    return entry[1].column;
  }
}

function encode(kind: FieldKind, v: unknown, where: string): SQLInputValue {
  if (v === undefined) throw new Error(`Missing value for ${where}`);
  if (v === null) return null;
  switch (kind) {
    case "json":
      return JSON.stringify(v);
    case "bool":
      return v ? 1 : 0;
    case "int":
      if (typeof v !== "number") throw new Error(`Expected number for ${where}`);
      return v;
    case "text":
      if (typeof v !== "string") throw new Error(`Expected string for ${where}`);
      return v;
  }
}

function decode(kind: FieldKind, v: unknown): unknown {
  if (v === null || v === undefined) return null;
  switch (kind) {
    case "json":
      return JSON.parse(v as string);
    case "bool":
      return v === 1 || v === 1n;
    case "int":
      return typeof v === "bigint" ? Number(v) : v;
    case "text":
      return v;
  }
}
