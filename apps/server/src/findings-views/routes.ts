import type { FastifyInstance } from "fastify";
import { FINDINGS_VIEWS_CONTRACT as C } from "@kw/schema";
import type { ServerContext } from "../context";
import { checkOutput, parseInput } from "../http/validate";
import { getFindingsSnapshot } from "./current";
import { getDigest, listDigestVersions, refreshDigest } from "./digest";
import { listTasks } from "./tasks";

/**
 * Findings presentation views (PRD Addendum B). Registered on the same app after the auth guard, so every route needs
 * the local API token. Read endpoints plus the digest refresh; none of them has a "mode" parameter, and nothing in
 * ingestion, finding generation or enforcement reads what these routes write (finding_snapshots).
 */
export function registerFindingsViewsRoutes(app: FastifyInstance, ctx: ServerContext): void {
  const { db, validateResponses: v } = ctx;

  app.get(C.findingsSnapshot.path, async () => checkOutput(C.findingsSnapshot.response, getFindingsSnapshot(db, ctx.now()), v));

  app.get(C.tasks.path, async (req) => checkOutput(C.tasks.response, listTasks(db, parseInput(C.tasks.query, req.query, "query")), v));

  app.get(C.digest.path, async (req) => {
    const { date } = parseInput(C.digest.params, req.params, "params");
    const { tz, version } = parseInput(C.digest.query, req.query, "query");
    return checkOutput(C.digest.response, getDigest(db, date, tz, ctx.now(), version), v);
  });

  app.post(C.digestRefresh.path, async (req) => {
    const { date } = parseInput(C.digestRefresh.params, req.params, "params");
    const { tz } = parseInput(C.digestRefresh.query, req.query, "query");
    return checkOutput(C.digestRefresh.response, refreshDigest(db, date, tz, ctx.now()), v);
  });

  app.get(C.digestVersions.path, async (req) => {
    const { date } = parseInput(C.digestVersions.params, req.params, "params");
    const { tz } = parseInput(C.digestVersions.query, req.query, "query");
    return checkOutput(C.digestVersions.response, listDigestVersions(db, date, tz), v);
  });
}
