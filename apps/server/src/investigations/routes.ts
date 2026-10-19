import type { FastifyInstance } from "fastify";
import {
  API_ROUTES,
  AskWitnessBody,
  AskWitnessResponse,
  FindingInvestigationsResponse,
  IdParams,
  InvestigationDetailResponse,
  InvestigationsListQuery,
  ScopedInvestigationsResponse,
} from "@kw/schema";
import type { ServerContext } from "../context";
import { checkOutput, parseInput } from "../http/validate";

export function registerInvestigationRoutes(app: FastifyInstance, ctx: ServerContext): void {
  const v = ctx.validateResponses;
  const svc = () => ctx.services.investigations;

  app.post(API_ROUTES.findingInvestigations, async (req) => {
    const { id } = parseInput(IdParams, req.params, "params");
    const body = parseInput(AskWitnessBody, req.body, "body");
    return checkOutput(AskWitnessResponse, await svc().ask(id, body, ctx.services.auth.actor(req)), v);
  });

  app.get(API_ROUTES.findingInvestigations, async (req) => {
    const { id } = parseInput(IdParams, req.params, "params");
    return checkOutput(FindingInvestigationsResponse, await svc().listForFinding(id), v);
  });

  // Run scope ------------------------------------------------------------------------------------------------
  app.post(API_ROUTES.runInvestigations, async (req) => {
    const { id } = parseInput(IdParams, req.params, "params");
    const body = parseInput(AskWitnessBody, req.body, "body");
    return checkOutput(AskWitnessResponse, await svc().askRun(id, body, ctx.services.auth.actor(req)), v);
  });

  app.get(API_ROUTES.runInvestigations, async (req) => {
    const { id } = parseInput(IdParams, req.params, "params");
    return checkOutput(ScopedInvestigationsResponse, await svc().listForRun(id), v);
  });

  // Workspace scope ------------------------------------------------------------------------------------------
  app.post(API_ROUTES.investigations, async (req) => {
    const body = parseInput(AskWitnessBody, req.body, "body");
    return checkOutput(AskWitnessResponse, await svc().askWorkspace(body, ctx.services.auth.actor(req)), v);
  });

  app.get(API_ROUTES.investigations, async (req) => {
    parseInput(InvestigationsListQuery, req.query ?? {}, "query");
    return checkOutput(ScopedInvestigationsResponse, await svc().listWorkspace(), v);
  });

  app.get(API_ROUTES.investigation, async (req) => {
    const { id } = parseInput(IdParams, req.params, "params");
    return checkOutput(InvestigationDetailResponse, await svc().get(id), v);
  });
}
