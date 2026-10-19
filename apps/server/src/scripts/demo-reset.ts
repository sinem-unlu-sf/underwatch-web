/**
 * `pnpm demo:reset`: puts the local demo back to a known state.
 *   1. Refuses to run while the API server is up (it holds the database open). It stops nothing itself.
 *   2. Deletes data/kw.db and leftover verification/supervised work dirs and policy overlays, so no stale
 *      verification records, runs or safeguards survive.
 *   3. Re-creates the database from migrations and re-imports the labeled fixtures (fixtures/runs/*.json), then
 *      re-projects every run into Neo4j and deletes Neo4j runs that no longer exist in SQLite.
 *   4. Re-creates the disposable demo workspace (data/workspaces/demo-repo, synthetic secrets only).
 * Not touched: data/auth-token, data/evidence/blobs (content-addressed; orphans are harmless), Tetragon state,
 * Docker containers, .env.local, ~/.underwatch.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, rmSync } from "node:fs";
import path from "node:path";
import { KwGraph, deleteRun } from "@kw/graph";
import { REPO_ROOT, defaultServerPaths, resolveDbLocation } from "../config";
import type { ServerContext } from "../context";
import { openDatabase } from "../db/connection";
import { listRunIds } from "../graph/bundle-from-db";
import { createWorkspaceService } from "../workspaces/service";

const port = Number(process.env.KW_API_PORT ?? 4600);
try {
  await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(1500) });
  console.error(`The API server is running on :${port}. Stop "pnpm dev" first (demo:reset stops nothing itself), then re-run.`);
  process.exit(1);
} catch {
  // not running: good
}

const paths = defaultServerPaths(process.env);
const location = resolveDbLocation();
if (location.path === ":memory:") throw new Error("KW_DB_PATH=:memory: makes demo:reset meaningless.");

function clearDir(dir: string): number {
  if (!existsSync(dir)) return 0;
  const entries = readdirSync(dir);
  for (const e of entries) rmSync(path.join(dir, e), { recursive: true, force: true });
  return entries.length;
}

for (const suffix of ["", "-wal", "-shm"]) rmSync(location.path + suffix, { force: true });
console.log(`1/4 Deleted database ${path.relative(REPO_ROOT, location.path)}.`);
const vw = clearDir(path.join(paths.dataDir, "verification-work"));
const sw = clearDir(path.join(paths.dataDir, "supervised-work"));
const ov = clearDir(path.join(paths.dataDir, "policies", "overlays"));
console.log(`    Removed ${vw} verification work dir(s), ${sw} supervised work dir(s), ${ov} policy overlay dir(s).`);

// 2. Fresh migrations + fixture import + Neo4j projection (the seed script does all three).
console.log("2/4 Seeding labeled fixtures (fresh migrations, Neo4j projection):");
const seed = spawnSync(process.execPath, ["--import", "tsx", path.join(REPO_ROOT, "apps/server/src/scripts/seed-fixtures.ts")], {
  cwd: path.join(REPO_ROOT, "apps/server"),
  env: { ...process.env, NODE_OPTIONS: "--disable-warning=ExperimentalWarning" },
  stdio: ["ignore", "pipe", "inherit"],
  encoding: "utf8",
});
const seedOut = seed.stdout ?? "";
for (const line of seedOut.split("\n")) {
  if (/^(Database:|Neo4j projection|OK |FAILED|\d+ of \d+ fixture)/.test(line.trim())) console.log(`    ${line.trim()}`);
}
if (seed.status !== 0) {
  console.error("Fixture seeding failed; see output above.");
  process.exit(1);
}

const db = openDatabase(location.path);

// 3. Remove Neo4j runs that are not in the fresh SQLite database.
if (process.env.KW_GRAPH !== "off") {
  const kw = new KwGraph({ cwd: REPO_ROOT });
  const h = await kw.health();
  if (!h.ok) console.log(`3/4 Neo4j unavailable (${h.error.kind}); stale graph runs not pruned. The graph re-syncs on server start.`);
  else {
    const keep = new Set(listRunIds(db));
    const owned = await kw.client.read("MATCH (n) WHERE n.owner_run IS NOT NULL RETURN DISTINCT n.owner_run AS r", {}, (rec) => String(rec.get("r")));
    let pruned = 0;
    if (owned.ok) {
      for (const id of owned.value) {
        if (keep.has(id)) continue;
        const r = await deleteRun(kw.client, id);
        if (r.ok) pruned += 1;
      }
    }
    console.log(`3/4 Neo4j: ${keep.size} run(s) in SQLite; pruned ${pruned} stale run(s) from the graph.`);
  }
  await kw.close();
} else console.log("3/4 KW_GRAPH=off: Neo4j skipped.");

// 4. Disposable demo workspace.
const quiet = { warn: () => undefined, info: () => undefined, error: () => undefined, debug: () => undefined };
const ctx = { db, paths, env: process.env, log: quiet, now: () => new Date() } as unknown as ServerContext;
const demo = await createWorkspaceService(ctx).createDemoWorkspace();
console.log(`4/4 Demo workspace ${demo.reset ? "re-created" : "created"}: ${path.relative(REPO_ROOT, demo.workspace.root_path)} (${demo.workspace.id}).`);

const count = (sql: string) => (db.prepare(sql).get() as { c: number }).c;
console.log(
  `\nDone. runs=${count("SELECT count(*) AS c FROM runs")} findings=${count("SELECT count(*) AS c FROM findings")} ` +
    `safeguards=${count("SELECT count(*) AS c FROM safeguards")} verification_runs=${count("SELECT count(*) AS c FROM verification_runs")}. ` +
    `Start the app with "pnpm dev", then "pnpm open".`,
);
db.close();
