import {
  FindingGraphResponse,
  ApiError,
  EvidenceResponse,
  FindingDetailResponse,
  FindingStatusUpdateResponse,
  FindingsResponse,
  HealthResponse,
  OverviewResponse,
  RunDetailResponse,
  RunEventsResponse,
  RunFindingsResponse,
  RunsResponse,
  StartSupervisedRunResponse,
  LiveFeedResponse,
  SafeguardsResponse,
  SettingsStatusResponse,
  AskWitnessResponse,
  AuthCheckResponse,
  DemoWorkspaceResponse,
  FindingInvestigationsResponse,
  InvestigationDetailResponse,
  MechanismsResponse,
  SafeguardDetailResponse,
  SafeguardMutationResponse,
  SafeguardProposalResponse,
  VerificationHarnessStatus,
  VerificationRunResponse,
  WorkspaceResponse,
  WorkspacesResponse,
  KW_CLIENT_HEADER,
  KW_CLIENT_HEADER_VALUE,
  apiPaths,
  type ApiErrorCode,
  type FindingStatusUpdateBody,
  type FindingsQueryInput,
  type RunEventsQueryInput,
  type RunsQueryInput,
  type SafeguardsQueryInput,
  type AskWitnessBody,
  type AuthorizeWorkspaceBody,
  type SafeguardApproveBody,
  type SafeguardProposalBody,
  type SafeguardRejectBody,
  type SafeguardRollbackBody,
  type SafeguardVersionBody,
  type StartVerificationBody,
  type StartSupervisedRunBody,
} from "@kw/schema";
import { authHeaders } from "./auth";
import { livePath } from "./live";

/** Structural subset of a Zod schema; the web package does not depend on zod directly. */
interface ResponseSchema<T> {
  safeParse(data: unknown): { success: true; data: T } | { success: false; error: { issues: ReadonlyArray<{ path: PropertyKey[]; message: string }> } };
}

/**
 * unreachable: the API did not answer (server not running, or the dev proxy could not connect).
 * http: the API answered with an ApiError body.
 * contract: the API answered, but the body did not match the shared @kw/schema contract.
 */
export type ApiFailureKind = "unreachable" | "http" | "contract";

export class ApiRequestError extends Error {
  readonly kind: ApiFailureKind;
  readonly status: number | null;
  readonly code: ApiErrorCode | null;
  readonly details: unknown;
  readonly path: string;

  constructor(init: { kind: ApiFailureKind; message: string; path: string; status?: number | null; code?: ApiErrorCode | null; details?: unknown }) {
    super(init.message);
    this.name = "ApiRequestError";
    this.kind = init.kind;
    this.path = init.path;
    this.status = init.status ?? null;
    this.code = init.code ?? null;
    this.details = init.details;
  }
}

type QueryValue = string | number | boolean | null | undefined;

export function buildQuery(params: Record<string, QueryValue> | undefined): string {
  if (!params) return "";
  const sp = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === "") continue;
    sp.set(key, String(value));
  }
  const s = sp.toString();
  return s ? `?${s}` : "";
}

/** True for 401 / 403 auth failures (not workspace authorization, which is a per-workspace decision). */
export function isPermissionDenied(err: unknown): boolean {
  return err instanceof ApiRequestError && err.kind === "http" && (err.code === "unauthorized" || err.code === "forbidden" || err.status === 401);
}

/** Client-generated idempotency key for mutating requests (ClientRequestId). Reuse it when retrying the SAME request. */
export function newClientRequestId(): string {
  try {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  } catch {
    // fall through
  }
  return `req-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

async function send(path: string, init?: RequestInit, accept = "application/json"): Promise<Response> {
  try {
    return await fetch(path, {
      ...init,
      headers: { Accept: accept, [KW_CLIENT_HEADER]: KW_CLIENT_HEADER_VALUE, ...authHeaders(), ...init?.headers },
    });
  } catch (err) {
    throw new ApiRequestError({ kind: "unreachable", path, message: err instanceof Error ? err.message : "Network request failed" });
  }
}

function errorFrom(path: string, res: Response, body: unknown, isJson: boolean): ApiRequestError {
  const parsed = ApiError.safeParse(body);
  if (parsed.success) {
    return new ApiRequestError({
      kind: "http",
      path,
      status: res.status,
      code: parsed.data.error.code,
      message: parsed.data.error.message,
      details: parsed.data.error.details,
    });
  }
  if (res.status >= 500 && !isJson) {
    return new ApiRequestError({ kind: "unreachable", path, status: res.status, message: `API not reachable (HTTP ${res.status} from proxy)` });
  }
  return new ApiRequestError({ kind: "contract", path, status: res.status, message: `HTTP ${res.status} with an error body that does not match ApiError`, details: body });
}

function parseJson(text: string): { body: unknown; isJson: boolean } {
  if (text.length === 0) return { body: undefined, isJson: false };
  try {
    return { body: JSON.parse(text), isJson: true };
  } catch {
    return { body: undefined, isJson: false };
  }
}

/** text/plain endpoints (patch export). */
async function requestText(path: string): Promise<string> {
  const res = await send(path, undefined, "text/plain");
  const text = await res.text();
  if (!res.ok) {
    const { body, isJson } = parseJson(text);
    throw errorFrom(path, res, body, isJson);
  }
  return text;
}

const postJson = (body: unknown): RequestInit => ({ method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

async function request<T>(path: string, schema: ResponseSchema<T>, init?: RequestInit): Promise<T> {
  const res = await send(path, init);

  const text = await res.text();
  const { body, isJson } = parseJson(text);
  // The Vite dev proxy answers 5xx with an empty/non-JSON body when it cannot reach the API (handled in errorFrom).
  if (!res.ok) throw errorFrom(path, res, body, isJson);

  if (!isJson) {
    throw new ApiRequestError({ kind: "contract", path, status: res.status, message: "Response was not JSON" });
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    const issues = parsed.error.issues.slice(0, 8).map((i) => `${i.path.map(String).join(".") || "(root)"}: ${i.message}`);
    throw new ApiRequestError({ kind: "contract", path, status: res.status, message: "Response does not match the @kw/schema contract", details: issues });
  }
  return parsed.data;
}

export const api = {
  health: () => request(apiPaths.health(), HealthResponse),
  overview: () => request(apiPaths.overview(), OverviewResponse),
  runs: (q: RunsQueryInput) => request(apiPaths.runs() + buildQuery(q as Record<string, QueryValue>), RunsResponse),
  run: (id: string) => request(apiPaths.run(id), RunDetailResponse),
  /** Starts a live supervised run (202, async); poll run(id) for `supervised.status`. */
  startSupervisedRun: (body: StartSupervisedRunBody) => request(apiPaths.runs(), StartSupervisedRunResponse, postJson(body)),
  runEvents: (id: string, q: RunEventsQueryInput) =>
    request(apiPaths.runEvents(id) + buildQuery(q as Record<string, QueryValue>), RunEventsResponse),
  runFindings: (id: string) => request(apiPaths.runFindings(id), RunFindingsResponse),
  /** Live feed of a supervised run: items/alerts with seq > after (see api/live.ts). */
  runLive: (id: string, after: number) => request(livePath(id, after), LiveFeedResponse),
  findings: (q: FindingsQueryInput) => request(apiPaths.findings() + buildQuery(q as Record<string, QueryValue>), FindingsResponse),
  finding: (id: string) => request(apiPaths.finding(id), FindingDetailResponse),
  updateFindingStatus: (id: string, body: FindingStatusUpdateBody) =>
    request(apiPaths.findingStatus(id), FindingStatusUpdateResponse, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  safeguards: (q: SafeguardsQueryInput) => request(apiPaths.safeguards() + buildQuery(q as Record<string, QueryValue>), SafeguardsResponse),
  evidence: (id: string) => request(apiPaths.evidence(id), EvidenceResponse),
  settingsStatus: () => request(apiPaths.settingsStatus(), SettingsStatusResponse),
  // Ask Witness addendum ---------------------------------------------------------------------------------------
  authCheck: () => request(apiPaths.authCheck(), AuthCheckResponse),
  workspaces: () => request(apiPaths.workspaces(), WorkspacesResponse),
  authorizeWorkspace: (body: AuthorizeWorkspaceBody) => request(apiPaths.workspaces(), WorkspaceResponse, postJson(body)),
  demoWorkspace: () => request(apiPaths.workspaceDemo(), DemoWorkspaceResponse, postJson({})),
  findingInvestigations: (findingId: string) => request(apiPaths.findingInvestigations(findingId), FindingInvestigationsResponse),
  investigation: (id: string) => request(apiPaths.investigation(id), InvestigationDetailResponse),
  findingGraph: (findingId: string) => request(apiPaths.findingGraph(findingId), FindingGraphResponse),
  askWitness: (findingId: string, body: AskWitnessBody) => request(apiPaths.findingInvestigations(findingId), AskWitnessResponse, postJson(body)),
  proposeSafeguards: (findingId: string, body: SafeguardProposalBody) =>
    request(apiPaths.findingSafeguardProposals(findingId), SafeguardProposalResponse, postJson(body)),
  safeguard: (id: string) => request(apiPaths.safeguard(id), SafeguardDetailResponse),
  safeguardMechanisms: () => request(apiPaths.safeguardMechanisms(), MechanismsResponse),
  editSafeguard: (id: string, body: SafeguardVersionBody) => request(apiPaths.safeguardVersions(id), SafeguardDetailResponse, postJson(body)),
  rejectSafeguard: (id: string, body: SafeguardRejectBody) => request(apiPaths.safeguardReject(id), SafeguardDetailResponse, postJson(body)),
  approveSafeguard: (id: string, body: SafeguardApproveBody) => request(apiPaths.safeguardApprove(id), SafeguardMutationResponse, postJson(body)),
  rollbackSafeguard: (id: string, body: SafeguardRollbackBody) => request(apiPaths.safeguardRollback(id), SafeguardMutationResponse, postJson(body)),
  safeguardPatch: (id: string, versionId?: string) => requestText(apiPaths.safeguardPatch(id) + buildQuery({ version_id: versionId })),
  startVerification: (id: string, body: StartVerificationBody) =>
    request(apiPaths.safeguardVerificationRuns(id), VerificationRunResponse, postJson(body)),
  verificationRun: (id: string) => request(apiPaths.verificationRun(id), VerificationRunResponse),
  verificationHarness: () => request(apiPaths.verificationHarness(), VerificationHarnessStatus),
};

/** Typed JSON request for addendum API modules that keep their own route map (e.g. api/findingsViews.ts). */
export { request as requestJson };

/** Request that answers 204 / empty body on success (e.g. POST /api/accounts/logout). Errors use the same ApiError handling. */
export async function requestNoContent(path: string, init?: RequestInit): Promise<void> {
  const res = await send(path, init);
  if (res.ok) return;
  const { body, isJson } = parseJson(await res.text());
  throw errorFrom(path, res, body, isJson);
}
