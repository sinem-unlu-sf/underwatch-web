import { z } from "zod";
import {
  CoverageReport,
  Event,
  EventCorrelation,
  Evidence,
  EventId,
  Finding,
  FindingId,
  FindingStatusChange,
  PolicyVersion,
  PolicyVersionId,
  Run,
  RunId,
  Safeguard,
  Timestamp,
  VerificationRun,
} from "./entities";
import {
  AgentType,
  EventBasis,
  EventType,
  FindingCategory,
  FindingStatus,
  IntegrationStatus,
  Outcome,
  RunStatus,
  SafeguardApplicationStatus,
  SafeguardApprovalStatus,
  SafeguardVerificationStatus,
  Severity,
} from "./enums";
import {
  AskWitnessBody,
  AskWitnessResponse,
  FindingInvestigationsResponse,
  InvestigationDetailResponse,
  InvestigationsListQuery,
  ScopedInvestigationsResponse,
} from "./askwitness";
import { AccountAuthResponse, AccountLoginBody, AccountMeResponse, AccountSignupBody } from "./accounts";
import { FindingGraphResponse, FindingGraphSummaryResponse } from "./graph";
import { FindingBrief, FindingBriefResponse, ShortRead } from "./brief";
import {
  MechanismsResponse,
  SafeguardApproveBody,
  SafeguardDetailResponse,
  SafeguardMutationResponse,
  SafeguardPatchQuery,
  SafeguardProposalBody,
  SafeguardProposalResponse,
  SafeguardRejectBody,
  SafeguardRollbackBody,
  SafeguardVersionBody,
} from "./safeguards";
import { StartSupervisedRunBody, StartSupervisedRunResponse, SupervisedRun } from "./supervised";
import { StartVerificationBody, VerificationHarnessStatus, VerificationRunResponse } from "./verification";
import {
  AuthorizeWorkspaceBody,
  ClaudeMdQuery,
  ClaudeMdResponse,
  DemoWorkspaceResponse,
  WorkspaceResponse,
  WorkspacesResponse,
} from "./workspaces";
import { LiveFeedQuery, LiveFeedResponse } from "./live";

// ---------------------------------------------------------------------------------------------------------------
// Routes. Server registers API_ROUTES (Fastify ":param" syntax); clients build URLs with apiPaths.
// ---------------------------------------------------------------------------------------------------------------

export const API_ROUTES = {
  health: "/api/health",
  overview: "/api/overview",
  runs: "/api/runs",
  run: "/api/runs/:id",
  runEvents: "/api/runs/:id/events",
  runFindings: "/api/runs/:id/findings",
  /** Live feed of a supervised run in progress (in-memory, best-effort display stream; see live.ts). */
  runLive: "/api/runs/:id/live",
  findings: "/api/findings",
  finding: "/api/findings/:id",
  findingStatus: "/api/findings/:id/status",
  safeguards: "/api/safeguards",
  evidence: "/api/evidence/:id",
  settingsStatus: "/api/settings/status",
  // Ask Witness addendum ---------------------------------------------------------------------------------------
  authCheck: "/api/auth/check",
  workspaces: "/api/workspaces",
  workspaceDemo: "/api/workspaces/demo",
  workspaceClaudeMd: "/api/workspaces/:id/claude-md",
  findingInvestigations: "/api/findings/:id/investigations",
  investigation: "/api/investigations/:id",
  /** Ask Witness run scope: GET lists, POST asks (AskWitnessBody). */
  runInvestigations: "/api/runs/:id/investigations",
  /** Ask Witness workspace scope: GET ?scope=workspace lists, POST asks (AskWitnessBody). */
  investigations: "/api/investigations",
  findingSafeguardProposals: "/api/findings/:id/safeguards/proposals",
  findingGraph: "/api/findings/:id/graph",
  /** Addendum C: deterministic concise explanation (same records as GET /api/findings/:id; also served there as `brief`). */
  findingBrief: "/api/findings/:id/brief",
  /** Addendum C: key relationships for a finding (plain-language paths over the same graph data). */
  findingGraphSummary: "/api/findings/:id/graph/summary",
  safeguardMechanisms: "/api/safeguard-mechanisms",
  safeguard: "/api/safeguards/:id",
  safeguardVersions: "/api/safeguards/:id/versions",
  safeguardReject: "/api/safeguards/:id/reject",
  safeguardApprove: "/api/safeguards/:id/approve",
  safeguardRollback: "/api/safeguards/:id/rollback",
  safeguardPatch: "/api/safeguards/:id/patch",
  safeguardVerificationRuns: "/api/safeguards/:id/verification-runs",
  verificationRun: "/api/verification-runs/:id",
  verificationHarness: "/api/verification/harness",
  // Local accounts ---------------------------------------------------------------------------------------------
  accountSignup: "/api/accounts/signup",
  accountLogin: "/api/accounts/login",
  accountLogout: "/api/accounts/logout",
  accountMe: "/api/accounts/me",
} as const;
export type ApiRouteKey = keyof typeof API_ROUTES;

const enc = encodeURIComponent;
export const apiPaths = {
  health: () => API_ROUTES.health,
  overview: () => API_ROUTES.overview,
  runs: () => API_ROUTES.runs,
  run: (id: string) => `/api/runs/${enc(id)}`,
  runEvents: (id: string) => `/api/runs/${enc(id)}/events`,
  runFindings: (id: string) => `/api/runs/${enc(id)}/findings`,
  runLive: (id: string) => `/api/runs/${enc(id)}/live`,
  findings: () => API_ROUTES.findings,
  finding: (id: string) => `/api/findings/${enc(id)}`,
  findingStatus: (id: string) => `/api/findings/${enc(id)}/status`,
  safeguards: () => API_ROUTES.safeguards,
  evidence: (id: string) => `/api/evidence/${enc(id)}`,
  settingsStatus: () => API_ROUTES.settingsStatus,
  authCheck: () => API_ROUTES.authCheck,
  workspaces: () => API_ROUTES.workspaces,
  workspaceDemo: () => API_ROUTES.workspaceDemo,
  workspaceClaudeMd: (id: string) => `/api/workspaces/${enc(id)}/claude-md`,
  findingInvestigations: (id: string) => `/api/findings/${enc(id)}/investigations`,
  investigation: (id: string) => `/api/investigations/${enc(id)}`,
  runInvestigations: (id: string) => `/api/runs/${enc(id)}/investigations`,
  investigations: () => API_ROUTES.investigations,
  findingSafeguardProposals: (id: string) => `/api/findings/${enc(id)}/safeguards/proposals`,
  findingGraph: (id: string) => `/api/findings/${enc(id)}/graph`,
  findingBrief: (id: string) => `/api/findings/${enc(id)}/brief`,
  findingGraphSummary: (id: string) => `/api/findings/${enc(id)}/graph/summary`,
  safeguardMechanisms: () => API_ROUTES.safeguardMechanisms,
  safeguard: (id: string) => `/api/safeguards/${enc(id)}`,
  safeguardVersions: (id: string) => `/api/safeguards/${enc(id)}/versions`,
  safeguardReject: (id: string) => `/api/safeguards/${enc(id)}/reject`,
  safeguardApprove: (id: string) => `/api/safeguards/${enc(id)}/approve`,
  safeguardRollback: (id: string) => `/api/safeguards/${enc(id)}/rollback`,
  safeguardPatch: (id: string) => `/api/safeguards/${enc(id)}/patch`,
  safeguardVerificationRuns: (id: string) => `/api/safeguards/${enc(id)}/verification-runs`,
  verificationRun: (id: string) => `/api/verification-runs/${enc(id)}`,
  verificationHarness: () => API_ROUTES.verificationHarness,
  accountSignup: () => API_ROUTES.accountSignup,
  accountLogin: () => API_ROUTES.accountLogin,
  accountLogout: () => API_ROUTES.accountLogout,
  accountMe: () => API_ROUTES.accountMe,
} as const satisfies Record<ApiRouteKey, (...args: string[]) => string>;

/**
 * Every request from the web app carries this header (value KW_CLIENT_HEADER_VALUE). Mutating routes reject requests
 * without it (403 forbidden): a custom header forces a CORS preflight, so other origins cannot fire simple
 * cross-site POSTs at the local API.
 */
export const KW_CLIENT_HEADER = "x-kw-client";
export const KW_CLIENT_HEADER_VALUE = "kw-web";

// ---------------------------------------------------------------------------------------------------------------
// Shared pieces
// ---------------------------------------------------------------------------------------------------------------

/**
 * Every non-2xx response body. HTTP status: 400 validation_error, 401 unauthorized, 403 forbidden,
 * 403 workspace_not_authorized, 404 not_found, 409 invalid_transition, 409 conflict (idempotency key reused with a
 * different request, or a concurrent state change), 409 file_conflict (details: FileConflictDetails), 422 note_required,
 * 500 internal_error, 501 not_implemented, 503 ai_unavailable, 504 timeout.
 */
export const ApiErrorCode = z.enum([
  "validation_error",
  "not_found",
  "invalid_transition",
  "note_required",
  "internal_error",
  "not_implemented",
  "unauthorized",
  "forbidden",
  "workspace_not_authorized",
  "conflict",
  "file_conflict",
  "ai_unavailable",
  "timeout",
  /** 429: too many signup/login attempts (local accounts). */
  "rate_limited",
]);
export type ApiErrorCode = z.infer<typeof ApiErrorCode>;

export const ApiError = z.object({
  error: z.object({
    code: ApiErrorCode,
    message: z.string(),
    details: z.unknown().optional(),
  }),
});
export type ApiError = z.infer<typeof ApiError>;

/** Query-string boolean: only the literal strings "true" / "false" are accepted. */
export const QueryBool = z.enum(["true", "false"]).transform((v) => v === "true");

/** include (default): fixture + live; exclude: live only; only: fixtures only. */
export const FixtureFilter = z.enum(["include", "exclude", "only"]);
export type FixtureFilter = z.infer<typeof FixtureFilter>;

export const Pagination = z.object({
  limit: z.coerce.number().int().min(1).max(500).default(100),
  offset: z.coerce.number().int().min(0).default(0),
});

export const IdParams = z.object({ id: z.string().min(1) });
export type IdParams = z.infer<typeof IdParams>;

const count = z.number().int().nonnegative();

export const EntityTotals = z.object({
  runs: count,
  events: count,
  findings: count,
  safeguards: count,
  verification_runs: count,
});
export type EntityTotals = z.infer<typeof EntityTotals>;

/** Lets every page say plainly whether it is showing fixture data, live data, or both. */
export const DataMode = z.object({
  fixture_runs: count,
  live_runs: count,
  contains_fixture_data: z.boolean(),
});
export type DataMode = z.infer<typeof DataMode>;

/** Status of one component. Never contains secrets: `configured_via` names the env var or file, never its value. */
export const ComponentStatus = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  status: IntegrationStatus,
  detail: z.string(),
  configured_via: z.string().nullable(),
});
export type ComponentStatus = z.infer<typeof ComponentStatus>;

// Run list rows ------------------------------------------------------------------------------------------------

export const RunListItem = Run.extend({
  event_count: count,
  finding_count: count,
  /** Findings in OPEN_FINDING_STATUSES. */
  open_finding_count: count,
  /** Highest severity among open findings; null when there are none. */
  max_open_severity: Severity.nullable(),
});
export type RunListItem = z.infer<typeof RunListItem>;

export const FindingListItem = Finding.extend({
  run_label: z.string().nullable(),
});
export type FindingListItem = z.infer<typeof FindingListItem>;

export const SafeguardListItem = Safeguard.extend({
  finding_title: z.string(),
  finding_status: FindingStatus,
  run_id: RunId,
  last_verification: VerificationRun.nullable(),
});
export type SafeguardListItem = z.infer<typeof SafeguardListItem>;

export const VerificationRunListItem = VerificationRun.extend({
  safeguard_title: z.string(),
});
export type VerificationRunListItem = z.infer<typeof VerificationRunListItem>;

// ---------------------------------------------------------------------------------------------------------------
// GET /api/health
// ---------------------------------------------------------------------------------------------------------------

export const HealthResponse = z.object({
  status: z.enum(["ok", "degraded"]),
  service: z.literal("underwatch-api"),
  /** Only with a valid bearer token: unauthenticated callers get a minimal liveness body (status, service, time). */
  version: z.string().optional(),
  time: Timestamp,
  database: z
    .object({
      ok: z.boolean(),
      driver: z.literal("node:sqlite"),
      detail: z.string(),
    })
    .optional(),
});
export type HealthResponse = z.infer<typeof HealthResponse>;

// ---------------------------------------------------------------------------------------------------------------
// GET /api/overview — every number is computed server-side from persisted rows. Item arrays are capped at
// OVERVIEW_ITEM_LIMIT; `count` is the full (uncapped) count.
// ---------------------------------------------------------------------------------------------------------------

export const OVERVIEW_ITEM_LIMIT = 5;

const countedList = <T extends z.ZodType>(item: T) => z.object({ count, items: z.array(item) });

export const OverviewResponse = z.object({
  generated_at: Timestamp,
  data_mode: DataMode,
  totals: EntityTotals,
  breakdown: z.object({ fixture: EntityTotals, live: EntityTotals }),
  /** Most recent by started_at desc. count = total runs. */
  recent_runs: countedList(RunListItem),
  /** Runs with open_finding_count > 0, ordered by max_open_severity desc then started_at desc. */
  runs_needing_review: countedList(RunListItem),
  /** status = "new", created_at desc. */
  new_findings: countedList(FindingListItem),
  /** status = "confirmed", updated_at desc. */
  confirmed_findings: countedList(FindingListItem),
  /** approval_status = "proposed", created_at desc. */
  safeguards_awaiting_approval: countedList(SafeguardListItem),
  /** status = "completed" verification runs, ended_at desc. */
  recent_verification_results: countedList(VerificationRunListItem),
  /** Same component statuses as /api/settings/status (adapter + collectors + neo4j + ai_inference). overall = worst-case summary. */
  observation_health: z.object({
    overall: IntegrationStatus,
    components: z.array(ComponentStatus),
  }),
});
export type OverviewResponse = z.infer<typeof OverviewResponse>;

// ---------------------------------------------------------------------------------------------------------------
// GET /api/runs
// ---------------------------------------------------------------------------------------------------------------

export const RunsQuery = Pagination.extend({
  /** Case-insensitive substring match over id, label, task_description. */
  q: z.string().trim().min(1).optional(),
  agent: AgentType.optional(),
  status: RunStatus.optional(),
  /** Inclusive bounds on started_at. */
  from: Timestamp.optional(),
  to: Timestamp.optional(),
  has_findings: QueryBool.optional(),
  fixture: FixtureFilter.default("include"),
});
export type RunsQuery = z.infer<typeof RunsQuery>;
export type RunsQueryInput = z.input<typeof RunsQuery>;

/** Ordered by started_at desc. total = count matching filters before pagination. */
export const RunsResponse = z.object({ items: z.array(RunListItem), total: count });
export type RunsResponse = z.infer<typeof RunsResponse>;

// ---------------------------------------------------------------------------------------------------------------
// GET /api/runs/:id
// ---------------------------------------------------------------------------------------------------------------

export const RunDetailResponse = z.object({
  run: Run,
  policy: PolicyVersion.nullable(),
  /** Null when no coverage report was recorded; UI must then show coverage as unknown. */
  coverage: CoverageReport.nullable(),
  counts: z.object({
    events: count,
    /** All three keys always present. */
    events_by_basis: z.record(EventBasis, count),
    evidence: count,
    findings: count,
    /** All six keys always present. */
    findings_by_status: z.record(FindingStatus, count),
    open_findings: count,
  }),
  /** Live supervised-run record (POST /api/runs); null/absent for fixture runs and runs ingested another way. */
  supervised: SupervisedRun.nullable().optional(),
});
export type RunDetailResponse = z.infer<typeof RunDetailResponse>;

// ---------------------------------------------------------------------------------------------------------------
// GET /api/runs/:id/events
// ---------------------------------------------------------------------------------------------------------------

export const RunEventsQuery = z.object({
  event_type: EventType.optional(),
  outcome: Outcome.optional(),
  process_id: z.coerce.number().int().nonnegative().optional(),
  /** Restrict to events in that finding's related_event_ids. */
  finding_id: FindingId.optional(),
  basis: EventBasis.optional(),
});
export type RunEventsQuery = z.infer<typeof RunEventsQuery>;
export type RunEventsQueryInput = z.input<typeof RunEventsQuery>;

/**
 * items ordered by timestamp asc, then source_sequence asc (nulls last), then id. Not paginated.
 * correlations: all correlations for the run (unfiltered) for the reported-vs-observed comparison view.
 */
export const RunEventsResponse = z.object({
  items: z.array(Event),
  total: count,
  correlations: z.array(EventCorrelation),
});
export type RunEventsResponse = z.infer<typeof RunEventsResponse>;

// ---------------------------------------------------------------------------------------------------------------
// GET /api/runs/:id/findings  and  GET /api/findings
// ---------------------------------------------------------------------------------------------------------------

/** Ordered by severity desc, then created_at desc. */
export const RunFindingsResponse = z.object({ items: z.array(FindingListItem), total: count });
export type RunFindingsResponse = z.infer<typeof RunFindingsResponse>;

export const FindingsQuery = Pagination.extend({
  status: FindingStatus.optional(),
  category: FindingCategory.optional(),
  severity: Severity.optional(),
  run_id: RunId.optional(),
  fixture: FixtureFilter.default("include"),
});
export type FindingsQuery = z.infer<typeof FindingsQuery>;
export type FindingsQueryInput = z.input<typeof FindingsQuery>;

/** Ordered by created_at desc. */
export const FindingsResponse = z.object({ items: z.array(FindingListItem), total: count });
export type FindingsResponse = z.infer<typeof FindingsResponse>;

// ---------------------------------------------------------------------------------------------------------------
// GET /api/findings/:id
// ---------------------------------------------------------------------------------------------------------------

export const FindingDetailResponse = z.object({
  finding: Finding,
  run: Run,
  /** Events in related_event_ids, ordered like RunEventsResponse. UI splits them by basis (reported vs observed). */
  related_events: z.array(Event),
  /** Union of finding.evidence_ids and evidence referenced by related events, deduplicated. */
  evidence: z.array(Evidence),
  /** PolicyVersion referenced by finding.policy_id, else the run's policy_version, else null. */
  policy: PolicyVersion.nullable(),
  /** Ordered by `at` asc. */
  status_history: z.array(FindingStatusChange),
  safeguards: z.array(Safeguard),
  /** FINDING_STATUS_TRANSITIONS[finding.status]. */
  allowed_transitions: z.array(FindingStatus),
  /** ai& explanations are pending architecture review; until then status is "not_implemented" and no text is returned. */
  ai_explanation: z.object({ status: IntegrationStatus, detail: z.string() }),
  /**
   * Addendum C: deterministic concise explanation built from the records above (plus coverage and verification runs).
   * A presentation, never a separate source of truth. Optional: omitted if it could not be built.
   */
  brief: FindingBrief.optional(),
  /** Deterministic <= 150-word short read of the same records (finding, numbers, why, fix). Optional like `brief`. */
  short_read: ShortRead.optional(),
});
export type FindingDetailResponse = z.infer<typeof FindingDetailResponse>;

// ---------------------------------------------------------------------------------------------------------------
// POST /api/findings/:id/status
// ---------------------------------------------------------------------------------------------------------------

/** Server validates with checkFindingTransition(); actor_type is always "user" for this endpoint. */
export const FindingStatusUpdateBody = z.object({
  to: FindingStatus,
  note: z.string().trim().max(2000).nullable().optional(),
});
export type FindingStatusUpdateBody = z.infer<typeof FindingStatusUpdateBody>;

export const FindingStatusUpdateResponse = z.object({
  finding: Finding,
  status_change: FindingStatusChange,
  allowed_transitions: z.array(FindingStatus),
});
export type FindingStatusUpdateResponse = z.infer<typeof FindingStatusUpdateResponse>;

// ---------------------------------------------------------------------------------------------------------------
// GET /api/safeguards
// ---------------------------------------------------------------------------------------------------------------

export const SafeguardsQuery = z.object({
  approval_status: SafeguardApprovalStatus.optional(),
  application_status: SafeguardApplicationStatus.optional(),
  verification_status: SafeguardVerificationStatus.optional(),
  finding_id: FindingId.optional(),
  fixture: FixtureFilter.default("include"),
});
export type SafeguardsQuery = z.infer<typeof SafeguardsQuery>;
export type SafeguardsQueryInput = z.input<typeof SafeguardsQuery>;

/** Ordered by created_at desc. */
export const SafeguardsResponse = z.object({ items: z.array(SafeguardListItem), total: count });
export type SafeguardsResponse = z.infer<typeof SafeguardsResponse>;

// ---------------------------------------------------------------------------------------------------------------
// GET /api/evidence/:id
// ---------------------------------------------------------------------------------------------------------------

export const EvidenceResponse = z.object({
  evidence: Evidence,
  referenced_by_event_ids: z.array(EventId),
  referenced_by_finding_ids: z.array(FindingId),
});
export type EvidenceResponse = z.infer<typeof EvidenceResponse>;

// ---------------------------------------------------------------------------------------------------------------
// GET /api/settings/status — statuses only; never secrets or secret-bearing values.
// ---------------------------------------------------------------------------------------------------------------

export const SettingsStatusResponse = z.object({
  generated_at: Timestamp,
  /** Claude Code adapter. "not_implemented" until architecture review. */
  adapter: ComponentStatus,
  /** One entry per independent observer (process/kernel tracer, file watcher, network proxy, git observer). */
  collectors: z.array(ComponentStatus),
  policy: ComponentStatus.extend({ active_policy_version_id: PolicyVersionId.nullable() }),
  ai_inference: ComponentStatus,
  neo4j: ComponentStatus,
  database: ComponentStatus.extend({ driver: z.literal("node:sqlite") }),
  retention: z.object({
    status: IntegrationStatus,
    detail: z.string(),
    raw_evidence_retention_days: z.number().int().positive().nullable(),
  }),
  redaction: z.object({ status: IntegrationStatus, detail: z.string() }),
  data_mode: DataMode,
  /** Number of local accounts (count only; no names or emails). Optional for older servers. */
  local_accounts: z.number().int().nonnegative().optional(),
});
export type SettingsStatusResponse = z.infer<typeof SettingsStatusResponse>;

// ---------------------------------------------------------------------------------------------------------------
// GET /api/auth/check
// ---------------------------------------------------------------------------------------------------------------

/**
 * local_loopback: the API listens on 127.0.0.1 only and accepts the web app (allowed Origin + KW_CLIENT_HEADER).
 * token: KW_API_TOKEN is set and requests must send `Authorization: Bearer <token>` (never returned by the API).
 */
export const AuthCheckResponse = z.object({
  authenticated: z.boolean(),
  actor: z.string(),
  mode: z.enum(["local_loopback", "token"]),
  detail: z.string(),
});
export type AuthCheckResponse = z.infer<typeof AuthCheckResponse>;

// ---------------------------------------------------------------------------------------------------------------
// Machine-readable contract: one entry per endpoint.
// ---------------------------------------------------------------------------------------------------------------

interface EndpointContract {
  method: "GET" | "POST";
  path: string;
  params?: z.ZodType;
  query?: z.ZodType;
  body?: z.ZodType;
  response: z.ZodType;
  /** Success status when not 200. */
  status?: 201 | 202 | 204;
  /** Response content type when not application/json. */
  contentType?: "text/plain";
}

export const API_CONTRACT = {
  health: { method: "GET", path: API_ROUTES.health, response: HealthResponse },
  overview: { method: "GET", path: API_ROUTES.overview, response: OverviewResponse },
  runs: { method: "GET", path: API_ROUTES.runs, query: RunsQuery, response: RunsResponse },
  run: { method: "GET", path: API_ROUTES.run, params: IdParams, response: RunDetailResponse },
  runEvents: { method: "GET", path: API_ROUTES.runEvents, params: IdParams, query: RunEventsQuery, response: RunEventsResponse },
  runFindings: { method: "GET", path: API_ROUTES.runFindings, params: IdParams, response: RunFindingsResponse },
  runLive: { method: "GET", path: API_ROUTES.runLive, params: IdParams, query: LiveFeedQuery, response: LiveFeedResponse },
  findings: { method: "GET", path: API_ROUTES.findings, query: FindingsQuery, response: FindingsResponse },
  finding: { method: "GET", path: API_ROUTES.finding, params: IdParams, response: FindingDetailResponse },
  findingStatus: {
    method: "POST",
    path: API_ROUTES.findingStatus,
    params: IdParams,
    body: FindingStatusUpdateBody,
    response: FindingStatusUpdateResponse,
  },
  safeguards: { method: "GET", path: API_ROUTES.safeguards, query: SafeguardsQuery, response: SafeguardsResponse },
  evidence: { method: "GET", path: API_ROUTES.evidence, params: IdParams, response: EvidenceResponse },
  settingsStatus: { method: "GET", path: API_ROUTES.settingsStatus, response: SettingsStatusResponse },
  // Ask Witness addendum ---------------------------------------------------------------------------------------
  authCheck: { method: "GET", path: API_ROUTES.authCheck, response: AuthCheckResponse },
  /** GET lists; POST {path,label,confirm:true} authorizes a directory (contract key workspacesCreate below). */
  workspaces: { method: "GET", path: API_ROUTES.workspaces, response: WorkspacesResponse },
  workspaceDemo: { method: "POST", path: API_ROUTES.workspaceDemo, response: DemoWorkspaceResponse },
  workspaceClaudeMd: { method: "GET", path: API_ROUTES.workspaceClaudeMd, params: IdParams, query: ClaudeMdQuery, response: ClaudeMdResponse },
  findingInvestigations: { method: "GET", path: API_ROUTES.findingInvestigations, params: IdParams, response: FindingInvestigationsResponse },
  investigation: { method: "GET", path: API_ROUTES.investigation, params: IdParams, response: InvestigationDetailResponse },
  runInvestigations: { method: "GET", path: API_ROUTES.runInvestigations, params: IdParams, response: ScopedInvestigationsResponse },
  investigations: { method: "GET", path: API_ROUTES.investigations, query: InvestigationsListQuery, response: ScopedInvestigationsResponse },
  findingSafeguardProposals: {
    method: "POST",
    path: API_ROUTES.findingSafeguardProposals,
    params: IdParams,
    body: SafeguardProposalBody,
    response: SafeguardProposalResponse,
  },
  findingGraph: { method: "GET", path: API_ROUTES.findingGraph, params: IdParams, response: FindingGraphResponse },
  findingBrief: { method: "GET", path: API_ROUTES.findingBrief, params: IdParams, response: FindingBriefResponse },
  findingGraphSummary: { method: "GET", path: API_ROUTES.findingGraphSummary, params: IdParams, response: FindingGraphSummaryResponse },
  safeguardMechanisms: { method: "GET", path: API_ROUTES.safeguardMechanisms, response: MechanismsResponse },
  safeguard: { method: "GET", path: API_ROUTES.safeguard, params: IdParams, response: SafeguardDetailResponse },
  safeguardVersions: { method: "POST", path: API_ROUTES.safeguardVersions, params: IdParams, body: SafeguardVersionBody, response: SafeguardDetailResponse },
  safeguardReject: { method: "POST", path: API_ROUTES.safeguardReject, params: IdParams, body: SafeguardRejectBody, response: SafeguardDetailResponse },
  safeguardApprove: { method: "POST", path: API_ROUTES.safeguardApprove, params: IdParams, body: SafeguardApproveBody, response: SafeguardMutationResponse },
  safeguardRollback: { method: "POST", path: API_ROUTES.safeguardRollback, params: IdParams, body: SafeguardRollbackBody, response: SafeguardMutationResponse },
  safeguardPatch: { method: "GET", path: API_ROUTES.safeguardPatch, params: IdParams, query: SafeguardPatchQuery, response: z.string(), contentType: "text/plain" },
  safeguardVerificationRuns: {
    method: "POST",
    path: API_ROUTES.safeguardVerificationRuns,
    params: IdParams,
    body: StartVerificationBody,
    response: VerificationRunResponse,
    status: 202,
  },
  verificationRun: { method: "GET", path: API_ROUTES.verificationRun, params: IdParams, response: VerificationRunResponse },
  verificationHarness: { method: "GET", path: API_ROUTES.verificationHarness, response: VerificationHarnessStatus },
  // Local accounts: signup needs the local API token (Bearer or setup_code); signup/login need no Bearer otherwise.
  accountSignup: { method: "POST", path: API_ROUTES.accountSignup, body: AccountSignupBody, response: AccountAuthResponse, status: 201 },
  accountLogin: { method: "POST", path: API_ROUTES.accountLogin, body: AccountLoginBody, response: AccountAuthResponse },
  /** 204 No Content; revokes the presented session token. */
  accountLogout: { method: "POST", path: API_ROUTES.accountLogout, response: z.null(), status: 204 },
  accountMe: { method: "GET", path: API_ROUTES.accountMe, response: AccountMeResponse },
} as const satisfies Record<ApiRouteKey, EndpointContract>;

/** Same paths, second method. Kept separate so API_CONTRACT stays one entry per route key. */
export const API_CONTRACT_EXTRA = {
  workspacesCreate: { method: "POST", path: API_ROUTES.workspaces, body: AuthorizeWorkspaceBody, response: WorkspaceResponse, status: 201 },
  /** Starts a live supervised run (async; poll GET /api/runs/:id). Idempotent on client_request_id. */
  runsStart: { method: "POST", path: API_ROUTES.runs, body: StartSupervisedRunBody, response: StartSupervisedRunResponse, status: 202 },
  findingInvestigationsAsk: {
    method: "POST",
    path: API_ROUTES.findingInvestigations,
    params: IdParams,
    body: AskWitnessBody,
    response: AskWitnessResponse,
  },
  runInvestigationsAsk: { method: "POST", path: API_ROUTES.runInvestigations, params: IdParams, body: AskWitnessBody, response: AskWitnessResponse },
  workspaceInvestigationsAsk: { method: "POST", path: API_ROUTES.investigations, body: AskWitnessBody, response: AskWitnessResponse },
} as const satisfies Record<string, EndpointContract>;
