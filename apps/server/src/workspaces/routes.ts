import type { FastifyInstance } from "fastify";
import {
  API_ROUTES,
  AuthorizeWorkspaceBody,
  ClaudeMdQuery,
  ClaudeMdResponse,
  DemoWorkspaceResponse,
  IdParams,
  WorkspaceResponse,
  WorkspacesResponse,
} from "@kw/schema";
import type { ServerContext } from "../context";
import { checkOutput, parseInput } from "../http/validate";

export function registerWorkspaceRoutes(app: FastifyInstance, ctx: ServerContext): void {
  const v = ctx.validateResponses;
  const ws = () => ctx.services.workspaces;

  app.get(API_ROUTES.workspaces, async () => checkOutput(WorkspacesResponse, { items: await ws().listWorkspaces() }, v));

  app.post(API_ROUTES.workspaces, async (req, reply) => {
    const body = parseInput(AuthorizeWorkspaceBody, req.body, "body");
    const workspace = await ws().authorizeWorkspace(body);
    return reply.status(201).send(checkOutput(WorkspaceResponse, { workspace }, v));
  });

  app.post(API_ROUTES.workspaceDemo, async () => checkOutput(DemoWorkspaceResponse, await ws().createDemoWorkspace(), v));

  app.get(API_ROUTES.workspaceClaudeMd, async (req) => {
    const { id } = parseInput(IdParams, req.params, "params");
    const { path } = parseInput(ClaudeMdQuery, req.query, "query");
    const read = await ws().readClaudeMd(id, path);
    return checkOutput(
      ClaudeMdResponse,
      { workspace_id: id, rel_path: path, exists: read.content !== null, ...read, read_at: ctx.now().toISOString() },
      v,
    );
  });
}
