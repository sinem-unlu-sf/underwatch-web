import type { FastifyInstance } from "fastify";
import { API_ROUTES, FindingGraphResponse, FindingGraphSummaryResponse, IdParams } from "@kw/schema";
import type { ServerContext } from "../context";
import { checkOutput, parseInput } from "../http/validate";

export function registerGraphRoutes(app: FastifyInstance, ctx: ServerContext): void {
  app.get(API_ROUTES.findingGraph, async (req) => {
    const { id } = parseInput(IdParams, req.params, "params");
    return checkOutput(FindingGraphResponse, await ctx.services.graph.findingGraph(id), ctx.validateResponses);
  });
  // Addendum C: the key relationships alone (computed from the same graph response; Neo4j-down => labeled fallback).
  app.get(API_ROUTES.findingGraphSummary, async (req) => {
    const { id } = parseInput(IdParams, req.params, "params");
    return checkOutput(FindingGraphSummaryResponse, await ctx.services.graph.findingGraphSummary(id), ctx.validateResponses);
  });
}
