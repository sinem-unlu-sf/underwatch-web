/**
 * Cross-module service interfaces for the Ask Witness addendum. Each module (src/<module>/service.ts) implements its
 * interface; other modules call it ONLY through ctx.services.<name> so modules never import each other's internals.
 * Every method may throw ApiHttpError (mapped to the ApiError body by the app's error handler).
 */
import type { EventBasis, Finding, PolicyVersion, Run } from "@kw/schema";
import type {
  AskWitnessBody,
  AskWitnessResponse,
  AuthCheckResponse,
  AuthorizeWorkspaceBody,
  BundleEvidenceRef,
  DemoWorkspaceResponse,
  FileConflictDetails,
  FileDiffPreview,
  FindingGraphResponse,
  KeyRelationshipsSummary,
  FindingInvestigationsResponse,
  InvestigationDetailResponse,
  SafeguardApproveBody,
  SafeguardDetailResponse,
  SafeguardMutationResponse,
  SafeguardProposalBody,
  SafeguardProposalResponse,
  SafeguardRejectBody,
  SafeguardRollbackBody,
  SafeguardVersion,
  SafeguardVersionBody,
  StartVerificationBody,
  VerificationHarnessStatus,
  VerificationRunResponse,
  VerificationRunV2,
  Workspace,
  WorkspaceFileChange,
} from "@kw/schema";
import type { EvidenceBundle } from "@kw/inference";
import type { FastifyRequest } from "fastify";

// ---------------------------------------------------------------------------------------------------------------
// Blobs (implemented: src/services/blobs.ts)
// ---------------------------------------------------------------------------------------------------------------

export interface BlobRef {
  sha256: string;
  size_bytes: number;
}

/** Content-addressed store under data/evidence/blobs/<sha[0..2]>/<sha>. Writes are idempotent; blobs are never mutated. */
export interface BlobStore {
  put(data: string | Uint8Array): BlobRef;
  get(sha256: string): Buffer | null;
  has(sha256: string): boolean;
}

// ---------------------------------------------------------------------------------------------------------------
// Evidence retrieval (implemented: src/services/evidence-retriever.ts, relational; graph-backed later)
// ---------------------------------------------------------------------------------------------------------------

export interface EvidenceBundleResult {
  finding: Finding;
  run: Run;
  policy: PolicyVersion | null;
  /** Redacted, size-capped, hash-sealed bundle (@kw/inference). The ONLY evidence ai& ever sees. */
  bundle: EvidenceBundle;
  /** Basis of every citable id in bundle.allowed_ids (null for policy rules). Input to checkAskWitnessOutput. */
  bases: Map<string, EventBasis | null>;
  /** Display index for every citable id (clickable references in the UI). */
  refs: BundleEvidenceRef[];
  /** How the extra context was retrieved (graph traversal, or the relational fallback and why). Not sent to the model. */
  retrieval: RetrievalInfo;
}

export interface RetrievalInfo {
  retriever: "graph" | "relational";
  /** Set when the graph retriever had to fall back to relational retrieval (Neo4j down, not configured, query failed). */
  fallback_reason: string | null;
  /** What the graph traversal contributed (null for relational retrieval). */
  graph: {
    neighborhood_event_ids: string[];
    ancestry_event_ids: string[];
    origin_tool_call_ids: string[];
    related_finding_ids: string[];
  } | null;
}

export interface EvidenceRetriever {
  readonly id: "relational" | "graph";
  /**
   * Smallest bundle for one finding: the finding, its related events + evidence, its policy rule(s). Never another
   * run's raw records. `question` lets a graph-backed implementation pick neighbours; the relational one ignores it.
   * Throws not_found for an unknown finding.
   */
  forFinding(findingId: string, question: string | null): Promise<EvidenceBundleResult>;
}

// ---------------------------------------------------------------------------------------------------------------
// Workspaces (owner: AUTH+WORKSPACE module, src/workspaces/)
// ---------------------------------------------------------------------------------------------------------------

export interface ClaudeMdRead {
  content: string | null;
  sha256: string | null;
  size_bytes: number | null;
}

/** The text Underwatch manages inside CLAUDE.md, delimited by claudeMdBlockMarkers(safeguard_id). */
export interface ManagedBlock {
  safeguard_id: string;
  content: string;
}

export type ApplyChangeResult = { ok: true; change: WorkspaceFileChange } | { ok: false; conflict: FileConflictDetails };

export interface WorkspaceSnapshot {
  workspace_id: string;
  /** sha256 over the sorted "<rel_path>\t<sha256>\n" manifest. */
  manifest_sha256: string;
  files: Array<{ rel_path: string; sha256: string; bytes: Buffer }>;
}

export interface WorkspaceService {
  listWorkspaces(): Promise<Workspace[]>;
  getWorkspace(id: string): Promise<Workspace | null>;
  /** Throws 403 workspace_not_authorized when the id is unknown, revoked, or its root is missing. */
  requireWorkspace(id: string): Promise<Workspace>;
  /** Authorizes an existing directory (realpath; refuses /, $HOME itself, and system dirs). */
  authorizeWorkspace(body: AuthorizeWorkspaceBody): Promise<Workspace>;
  /** Creates (or resets to the template) the disposable demo workspace under data/workspaces/. */
  createDemoWorkspace(): Promise<DemoWorkspaceResponse>;
  /** relPath must satisfy ClaudeMdRelPath; resolved path must stay inside the workspace root (symlinks resolved). */
  readClaudeMd(workspaceId: string, relPath: string): Promise<ClaudeMdRead>;
  /**
   * Diff of mergeClaudeMdBlock(current, block) vs current. workspaceId null => diff against an empty file (patch-only
   * mode, nothing is read). Sets duplicate_of (and after === before) when an equivalent instruction already exists.
   */
  proposeClaudeMdChange(workspaceId: string | null, relPath: string, block: ManagedBlock): Promise<FileDiffPreview>;
  /**
   * Compare-and-swap write: re-reads the file; if its sha256 !== expectedBeforeSha256 (null = must not exist) returns
   * {ok:false, conflict} with a regenerated diff and writes nothing. Otherwise writes mergeClaudeMdBlock(current, block)
   * atomically (temp file + rename), stores before/after in the BlobStore and records a WorkspaceFileChange.
   */
  applyChange(input: {
    workspaceId: string;
    relPath: string;
    expectedBeforeSha256: string | null;
    block: ManagedBlock;
    safeguardId: string;
    versionId: string;
  }): Promise<ApplyChangeResult>;
  /** Restores the change's before content (deletes the file if it did not exist) iff the file still hashes to after_sha256; else conflict. */
  rollback(changeId: string): Promise<ApplyChangeResult>;
  getChange(changeId: string): Promise<WorkspaceFileChange | null>;
  listChanges(filter: { safeguardId: string }): Promise<WorkspaceFileChange[]>;
  /** Unified diff text (git-apply compatible paths a/<rel> b/<rel>) for copy/paste when no workspace is authorized. */
  exportPatch(workspaceId: string | null, relPath: string, block: ManagedBlock): Promise<string>;
  /** Read-only copy of the workspace files for a verification run (size-capped; skips .git and node_modules). */
  snapshot(workspaceId: string): Promise<WorkspaceSnapshot>;
}

// ---------------------------------------------------------------------------------------------------------------
// Auth (owner: AUTH+WORKSPACE module, src/auth/)
// ---------------------------------------------------------------------------------------------------------------

export interface AuthService {
  check(req: FastifyRequest): AuthCheckResponse;
  /** Actor string recorded in histories for this request (e.g. "developer"). */
  actor(req: FastifyRequest): string;
}

// ---------------------------------------------------------------------------------------------------------------
// Investigations (owner: ASK WITNESS module, src/investigations/)
// ---------------------------------------------------------------------------------------------------------------

export interface InvestigationService {
  /** Idempotent on body.client_request_id (same key + different finding/question/investigation => 409 conflict). */
  ask(findingId: string, body: AskWitnessBody, actor: string): Promise<AskWitnessResponse>;
  listForFinding(findingId: string): Promise<FindingInvestigationsResponse>;
  get(investigationId: string): Promise<InvestigationDetailResponse>;
  /** Run scope: questions about one agent run (bundle from that run only). Same idempotency rules. */
  askRun(runId: string, body: AskWitnessBody, actor: string): Promise<AskWitnessResponse>;
  /** Workspace scope: questions across Underwatch's own records (deterministic, capped selection). */
  askWorkspace(body: AskWitnessBody, actor: string): Promise<AskWitnessResponse>;
  listForRun(runId: string): Promise<FindingInvestigationsResponse>;
  listWorkspace(): Promise<FindingInvestigationsResponse>;
}

// ---------------------------------------------------------------------------------------------------------------
// Safeguards (owner: SAFEGUARDS module, src/safeguards/)
// ---------------------------------------------------------------------------------------------------------------

export interface SupervisedPolicyRule {
  safeguard_id: string;
  version_id: string;
  /** Claude Code permission rule strings to add to permissions.deny / permissions.ask, e.g. "Read(./.env)". */
  deny: string[];
  ask: string[];
}

export interface SafeguardService {
  propose(findingId: string, body: SafeguardProposalBody, actor: string): Promise<SafeguardProposalResponse>;
  get(safeguardId: string): Promise<SafeguardDetailResponse>;
  addVersion(safeguardId: string, body: SafeguardVersionBody, actor: string): Promise<SafeguardDetailResponse>;
  reject(safeguardId: string, body: SafeguardRejectBody, actor: string): Promise<SafeguardDetailResponse>;
  /** Throws 409 file_conflict (details: FileConflictDetails) on a concurrent change; records conflict_detected. */
  approve(safeguardId: string, body: SafeguardApproveBody, actor: string): Promise<SafeguardMutationResponse>;
  rollback(safeguardId: string, body: SafeguardRollbackBody, actor: string): Promise<SafeguardMutationResponse>;
  /** text/plain unified diff (defaults to current version). */
  patch(safeguardId: string, versionId: string | undefined): Promise<string>;
  getVersion(versionId: string): Promise<SafeguardVersion | null>;
  /** Applied permission_rule versions, for the supervised-run managed policy (verification harness). */
  supervisedPolicyRules(): Promise<SupervisedPolicyRule[]>;
  /** Called by the verification module when a run finishes: updates v2 + legacy status columns and history. */
  recordVerification(safeguardId: string, run: VerificationRunV2): Promise<void>;
}

// ---------------------------------------------------------------------------------------------------------------
// Verification (owner: VERIFICATION module, src/verification/)
// ---------------------------------------------------------------------------------------------------------------

export interface VerificationService {
  /** Returns quickly (202): the harness runs in the background; poll getRun. Idempotent on client_request_id. */
  startRun(safeguardId: string, body: StartVerificationBody, actor: string): Promise<VerificationRunResponse>;
  getRun(runId: string): Promise<VerificationRunResponse>;
  listForSafeguard(safeguardId: string): Promise<VerificationRunV2[]>;
  harnessStatus(): Promise<VerificationHarnessStatus>;
}

// ---------------------------------------------------------------------------------------------------------------
// Graph (later: src/graph/)
// ---------------------------------------------------------------------------------------------------------------

export interface GraphService {
  findingGraph(findingId: string): Promise<FindingGraphResponse>;
  /** Addendum C: key relationships for a finding (same data as FindingGraphResponse.key_relationships). */
  findingGraphSummary(findingId: string): Promise<KeyRelationshipsSummary>;
}

export interface ServiceRegistry {
  auth: AuthService;
  blobs: BlobStore;
  evidence: EvidenceRetriever;
  workspaces: WorkspaceService;
  investigations: InvestigationService;
  safeguards: SafeguardService;
  verification: VerificationService;
  graph: GraphService;
}
