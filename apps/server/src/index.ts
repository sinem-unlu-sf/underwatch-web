import { KwGraph } from "@kw/graph";
import { createInferenceProvider } from "@kw/inference";
import { buildApp } from "./app";
import { ensureAuthToken } from "./auth";
import { ENV_LOCAL_PATH, HOST, REPO_ROOT, resolveDbLocation, resolvePort } from "./config";
import { openDatabase } from "./db/connection";
import { processRedactionOptions } from "./ingest/sanitize";

// Fail fast on a bad KW_REDACTION_PATTERNS_FILE: storage-boundary redaction would otherwise refuse every bundle later.
processRedactionOptions();
const dbLocation = resolveDbLocation();
const db = openDatabase(dbLocation.path);
// Real ai& provider when AIAND_API_KEY is in the env or .env.local; NullProvider otherwise. The key stays inside the provider.
const inference = createInferenceProvider({ envFile: process.env.KW_ENV_FILE ?? ENV_LOCAL_PATH });
// Neo4j projection (credentials from NEO4J_* env or the nearest .env.neo4j; never logged). KW_GRAPH=off disables it.
const graph = process.env.KW_GRAPH === "off" ? null : new KwGraph({ cwd: REPO_ROOT });
const app = await buildApp({ db, dbLocation, logger: true, inference, graph });

const shutdown = async (signal: string) => {
  app.log.info({ signal }, "shutting down");
  await app.close();
  db.close();
  process.exit(0);
};
process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));

try {
  await app.listen({ host: HOST, port: resolvePort() });
  app.log.info(`database: ${dbLocation.path} (${dbLocation.configuredVia})`);
  // Rebuild the graph projection from SQLite in the background; the API never waits for (or fails on) Neo4j.
  void app.kw.graph.syncAll("startup").then((r) => {
    if (r.unavailable) app.log.warn(`graph projection skipped: ${r.unavailable.kind}`);
    else app.log.info(`graph projection: ${r.runs.filter((x) => x.ok).length}/${r.runs.length} run(s) projected into Neo4j`);
  });
  // Local-only log line (AC-9): the token lives in data/auth-token (mode 600). `pnpm open` opens the same URL.
  app.log.info(`Open Underwatch: http://127.0.0.1:4601/overview?token=${ensureAuthToken(app.kw.paths.dataDir)}`);
} catch (err) {
  app.log.error(err);
  db.close();
  process.exit(1);
}
