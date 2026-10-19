import type { FastifyInstance } from "fastify";
import {
  API_ROUTES,
  EvidenceResponse,
  FindingBriefResponse,
  FindingDetailResponse,
  FindingStatusUpdateBody,
  FindingStatusUpdateResponse,
  FindingsQuery,
  FindingsResponse,
  HealthResponse,
  IdParams,
  OverviewResponse,
  RunDetailResponse,
  RunEventsQuery,
  RunEventsResponse,
  RunFindingsResponse,
  RunsQuery,
  RunsResponse,
  SafeguardsQuery,
  SafeguardsResponse,
  SettingsStatusResponse,
} from "@kw/schema";
import { SERVICE_VERSION, UI_ACTOR } from "./config";
import { authenticatedRequests } from "./auth/plugin";
import { checkOutput, parseInput } from "./http/validate";
import { getEvidenceDetail } from "./repo/evidence";
import { getFindingBriefResponse, withBrief } from "./findings-brief/brief";
import { getFindingDetail, listFindings, listRunFindings, updateFindingStatus } from "./repo/findings";
import { getOverview } from "./repo/overview";
import { getRunDetail, getRunEvents, listRuns } from "./repo/runs";
import { listSafeguards } from "./repo/safeguards";
import { settingsStatus, type StatusContext } from "./status";
import { readSupervisedRun } from "./supervised/repo";

export interface RouteContext extends StatusContext {
  validateResponses: boolean;
}

export function registerRoutes(app: FastifyInstance, ctx: RouteContext): void {
  const { db, env, validateResponses: v } = ctx;

  app.get(API_ROUTES.health, async (req) => {
    let database: HealthResponse["database"];
    try {
      db.prepare("SELECT 1").get();
      database = { ok: true, driver: "node:sqlite", detail: "SQLite reachable." };
    } catch (err) {
      database = { ok: false, driver: "node:sqlite", detail: `SQLite query failed: ${(err as Error).message}` };
    }
    const minimal = { status: database.ok ? ("ok" as const) : ("degraded" as const), service: "underwatch-api" as const, time: new Date().toISOString() };
    // Without the token: liveness only (no version, driver or DB error text).
    const body: HealthResponse = authenticatedRequests.has(req) ? { ...minimal, version: SERVICE_VERSION, database } : minimal;
    return checkOutput(HealthResponse, body, v);
  });

  app.get(API_ROUTES.overview, async () => checkOutput(OverviewResponse, getOverview(db, env, ctx.neo4jCached?.(), ctx.inference), v));

  app.get(API_ROUTES.runs, async (req) => checkOutput(RunsResponse, listRuns(db, parseInput(RunsQuery, req.query, "query")), v));

  app.get(API_ROUTES.run, async (req) => {
    const { id } = parseInput(IdParams, req.params, "params");
    const detail = getRunDetail(db, id);
    return checkOutput(RunDetailResponse, { ...detail, supervised: detail.run.is_fixture ? null : readSupervisedRun(db, id) }, v);
  });

  app.get(API_ROUTES.runEvents, async (req) => {
    const { id } = parseInput(IdParams, req.params, "params");
    const query = parseInput(RunEventsQuery, req.query, "query");
    return checkOutput(RunEventsResponse, getRunEvents(db, id, query), v);
  });

  app.get(API_ROUTES.runFindings, async (req) => {
    const { id } = parseInput(IdParams, req.params, "params");
    return checkOutput(RunFindingsResponse, listRunFindings(db, id), v);
  });

  app.get(API_ROUTES.findings, async (req) =>
    checkOutput(FindingsResponse, listFindings(db, parseInput(FindingsQuery, req.query, "query")), v),
  );

  app.get(API_ROUTES.finding, async (req) => {
    const { id } = parseInput(IdParams, req.params, "params");
    return checkOutput(FindingDetailResponse, withBrief(db, getFindingDetail(db, id)), v);
  });

  // Addendum C: deterministic concise explanation of the same records (also embedded above as `brief`).
  app.get(API_ROUTES.findingBrief, async (req) => {
    const { id } = parseInput(IdParams, req.params, "params");
    return checkOutput(FindingBriefResponse, getFindingBriefResponse(db, id), v);
  });

  app.post(API_ROUTES.findingStatus, async (req) => {
    const { id } = parseInput(IdParams, req.params, "params");
    const body = parseInput(FindingStatusUpdateBody, req.body, "body");
    return checkOutput(FindingStatusUpdateResponse, updateFindingStatus(db, id, body, UI_ACTOR), v);
  });

  app.get(API_ROUTES.safeguards, async (req) =>
    checkOutput(SafeguardsResponse, listSafeguards(db, parseInput(SafeguardsQuery, req.query, "query")), v),
  );

  app.get(API_ROUTES.evidence, async (req) => {
    const { id } = parseInput(IdParams, req.params, "params");
    return checkOutput(EvidenceResponse, getEvidenceDetail(db, id), v);
  });

  app.get(API_ROUTES.settingsStatus, async () => checkOutput(SettingsStatusResponse, settingsStatus(ctx, await ctx.neo4jStatus?.()), v));
}
