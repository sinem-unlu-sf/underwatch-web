/**
 * One LIVE Ask Witness question against ai& on fixture fx-03, in an in-memory database (the real DB is untouched).
 * Prints only the validated answer shape and metadata: never the key, the prompt, or raw provider bodies.
 *   pnpm --filter @kw/server exec tsx src/investigations/live-smoke.ts ["question"] [finding_id] [concise|detailed] [standard|simple]
 */
import { rmSync } from "node:fs";
import path from "node:path";
import { createInferenceProvider } from "@kw/inference";
import { buildApp } from "../app";
import { ENV_LOCAL_PATH } from "../config";
import { openDatabase } from "../db/connection";
import { importFixtureFile } from "../ingest/fixtures";
import { createTestPaths } from "../test/helpers";

const question = process.argv[2] ?? "Were the credentials in .env accessed?";
const findingId = process.argv[3] ?? "fnd_fx03_env_read_blocked";
const depth = process.argv[4] === "detailed" ? "detailed" : undefined;
const style = process.argv[5] === "simple" ? "simple" : undefined;
const repo = path.resolve(import.meta.dirname, "../../../..");
const db = openDatabase(":memory:");
for (const f of ["fx-03-env-read-blocked", "fx-04-env-read-via-bash"]) importFixtureFile(db, path.join(repo, "fixtures/runs", `${f}.json`));
const inference = createInferenceProvider({ envFile: process.env.KW_ENV_FILE ?? ENV_LOCAL_PATH });
const paths = createTestPaths();
const app = await buildApp({ db, dbLocation: { path: ":memory:", configuredVia: "live-smoke" }, env: {}, validateResponses: true, inference, paths });
try {
  const t0 = Date.now();
  const r = await app.kw.services.investigations.ask(findingId, { question, client_request_id: `live-smoke-${Date.now()}`, ...(depth ? { depth } : {}), ...(style ? { style } : {}) }, "live-smoke");
  const meta = db.prepare("SELECT ai_meta FROM investigation_turns WHERE id = ?").get(r.turn.id) as { ai_meta: string | null };
  const m = meta.ai_meta ? (JSON.parse(meta.ai_meta) as Record<string, unknown>) : {};
  console.log(
    JSON.stringify(
      {
        provider: inference.id,
        elapsed_ms: Date.now() - t0,
        ai_meta: { model: m.model, served_model: m.served_model, attempts: m.attempts, repair_attempted: m.repair_attempted, structured_mode: m.structured_mode, usage: m.usage, latency_ms: m.latency_ms },
        turn: { status: r.turn.status, model: r.turn.model, prompt_version: r.turn.prompt_version, depth: r.turn.depth, style: r.turn.style, evidence_ids_sent: r.turn.evidence_ids.length, error: r.turn.error },
        answer: r.turn.answer,
      },
      null,
      2,
    ),
  );
} finally {
  await app.close();
  db.close();
  rmSync(paths.dataDir, { recursive: true, force: true });
}
