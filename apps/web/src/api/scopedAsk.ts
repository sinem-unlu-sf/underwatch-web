/**
 * Ask Witness beyond one finding: RUN scope (one agent run) and WORKSPACE scope (all of Underwatch's own records).
 * Same Addendum A rules as the finding panel: the server retrieves a small, capped, redacted bundle from Underwatch's
 * own database, validates every citation against it and labels claims by evidence basis; this client only renders the
 * validated turn. Parsing is deliberately lenient on the investigation envelope and on evidence-index kinds (scoped
 * bundles index runs, safeguards, verification results and digest entries too) but strict on the turn itself.
 *
 * Routes (documented contract; also present as API_ROUTES constants once the server side lands):
 *   POST /api/runs/:id/investigations   {question, client_request_id, investigation_id?}  -> ScopedAskResponse
 *   POST /api/investigations            {question, client_request_id, investigation_id?}  -> ScopedAskResponse
 *   GET  /api/investigations/:id                                                           -> ScopedInvestigationDetail
 */
import { ApiError, apiPaths, EventBasis, InvestigationTurn, KW_CLIENT_HEADER, KW_CLIENT_HEADER_VALUE, type BundleEvidenceRef } from "@kw/schema";
import { authHeaders } from "./auth";
import { ApiRequestError } from "./client";

export type AskScope = { kind: "run"; runId: string } | { kind: "workspace" };

export const scopeKey = (s: AskScope) => (s.kind === "run" ? `run:${s.runId}` : "workspace");

export const scopedPaths = {
  ask: (s: AskScope) => (s.kind === "run" ? apiPaths.runInvestigations(s.runId) : apiPaths.investigations()),
  list: (s: AskScope) => (s.kind === "run" ? apiPaths.runInvestigations(s.runId) : `${apiPaths.investigations()}?scope=workspace`),
  detail: (id: string) => apiPaths.investigation(id),
};

/** Evidence-index entry for any scope. `kind` is open-ended (run, safeguard, verification_run, digest, ...). */
export interface ScopedEvidenceRef {
  evidence_id: string;
  kind: string;
  basis: EventBasis | null;
  source: string | null;
  timestamp: string | null;
  summary: string;
  run_id: string | null;
  finding_id: string | null;
  safeguard_id: string | null;
}

export interface ScopedInvestigation {
  id: string;
  scope: string | null;
  run_id: string | null;
  finding_id: string | null;
}

export interface ScopedAskResponse {
  investigation: ScopedInvestigation;
  turn: InvestigationTurn;
  evidence_index: ScopedEvidenceRef[];
  replayed: boolean;
}

export interface ScopedInvestigationDetail {
  investigation: ScopedInvestigation;
  turns: InvestigationTurn[];
  evidence_index: ScopedEvidenceRef[];
  ai: { available: boolean; detail: string } | null;
}

export interface ScopedAskBody {
  question: string;
  client_request_id: string;
  investigation_id?: string;
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === "string" ? v : null);

class ContractError extends Error {}

function parseRef(v: unknown): ScopedEvidenceRef | null {
  if (!isObj(v) || typeof v.evidence_id !== "string") return null;
  const basis = EventBasis.safeParse(v.basis);
  return {
    evidence_id: v.evidence_id,
    kind: str(v.kind) ?? "record",
    basis: basis.success ? basis.data : null,
    source: str(v.source),
    timestamp: str(v.timestamp),
    summary: str(v.summary) ?? "",
    run_id: str(v.run_id),
    finding_id: str(v.finding_id),
    safeguard_id: str(v.safeguard_id),
  };
}

function parseIndex(v: unknown): ScopedEvidenceRef[] {
  return Array.isArray(v) ? v.map(parseRef).filter((r): r is ScopedEvidenceRef => r !== null) : [];
}

function parseInvestigation(v: unknown): ScopedInvestigation {
  if (!isObj(v) || typeof v.id !== "string") throw new ContractError("investigation: missing id");
  return { id: v.id, scope: str(v.scope_kind) ?? str(v.scope), run_id: str(v.run_id), finding_id: str(v.finding_id) };
}

/** Turns are parsed with the shared, strict schema: answers are only ever rendered after the app's own validation. */
function parseTurn(v: unknown, where: string): InvestigationTurn {
  const r = InvestigationTurn.safeParse(v);
  if (!r.success) {
    const i = r.error.issues[0];
    throw new ContractError(`${where}.${i ? i.path.map(String).join(".") : ""}: ${i?.message ?? "invalid"}`);
  }
  return r.data;
}

export function parseAskResponse(body: unknown): ScopedAskResponse {
  if (!isObj(body)) throw new ContractError("(root): not an object");
  return {
    investigation: parseInvestigation(body.investigation),
    turn: parseTurn(body.turn, "turn"),
    evidence_index: parseIndex(body.evidence_index),
    replayed: body.replayed === true,
  };
}

export function parseDetail(body: unknown): ScopedInvestigationDetail {
  if (!isObj(body) || !Array.isArray(body.turns)) throw new ContractError("(root): missing turns");
  const ai = isObj(body.ai) && typeof body.ai.available === "boolean" ? { available: body.ai.available, detail: str(body.ai.detail) ?? "" } : null;
  return {
    investigation: parseInvestigation(body.investigation),
    turns: body.turns.map((t, i) => parseTurn(t, `turns.${i}`)),
    evidence_index: parseIndex(body.evidence_index),
    ai,
  };
}

export interface ScopedInvestigationListItem {
  id: string;
  updated_at: string;
  turn_count: number;
  /** Most recent question in the investigation, when the server lists it (same list shape as the finding scope). */
  last_question: string | null;
}

export function parseList(body: unknown): ScopedInvestigationListItem[] {
  if (!isObj(body) || !Array.isArray(body.items)) throw new ContractError("(root): missing items");
  return body.items
    .filter((i): i is Obj => isObj(i) && typeof i.id === "string")
    .map((i) => ({ id: i.id as string, updated_at: str(i.updated_at) ?? "", turn_count: typeof i.turn_count === "number" ? i.turn_count : 0, last_question: str(i.last_question) }));
}

async function call<T>(path: string, parse: (body: unknown) => T, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, { ...init, headers: { Accept: "application/json", [KW_CLIENT_HEADER]: KW_CLIENT_HEADER_VALUE, ...authHeaders(), ...init?.headers } });
  } catch (err) {
    throw new ApiRequestError({ kind: "unreachable", path, message: err instanceof Error ? err.message : "Network request failed" });
  }
  const text = await res.text();
  let body: unknown;
  let isJson = false;
  try {
    body = text ? JSON.parse(text) : undefined;
    isJson = text.length > 0;
  } catch {
    body = undefined;
  }
  if (!res.ok) {
    const e = ApiError.safeParse(body);
    if (e.success) {
      throw new ApiRequestError({ kind: "http", path, status: res.status, code: e.data.error.code, message: e.data.error.message, details: e.data.error.details });
    }
    if (res.status >= 500 && !isJson) throw new ApiRequestError({ kind: "unreachable", path, status: res.status, message: `API not reachable (HTTP ${res.status})` });
    if (res.status === 404 || res.status === 405) {
      throw new ApiRequestError({ kind: "http", path, status: res.status, code: "not_implemented", message: "This Ask Witness scope is not available on this server yet." });
    }
    throw new ApiRequestError({ kind: "contract", path, status: res.status, message: `HTTP ${res.status}`, details: body });
  }
  if (!isJson) throw new ApiRequestError({ kind: "contract", path, status: res.status, message: "Response was not JSON" });
  try {
    return parse(body);
  } catch (err) {
    throw new ApiRequestError({ kind: "contract", path, status: res.status, message: "Response does not match the Ask Witness contract", details: [err instanceof Error ? err.message : String(err)] });
  }
}

export const scopedApi = {
  ask: (s: AskScope, body: ScopedAskBody) =>
    call(scopedPaths.ask(s), parseAskResponse, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
  detail: (id: string) => call(scopedPaths.detail(id), parseDetail),
  list: (s: AskScope) => call(scopedPaths.list(s), parseList),
};

/** AnswerView's lookup type; scoped refs carry a superset of fields and an open `kind`. */
export const asBundleRef = (r: ScopedEvidenceRef) => r as unknown as BundleEvidenceRef;

/**
 * Where a cited id navigates. Only ids the app found in the bundle are ever passed here (invalid ids are not links).
 * Returns null when the record has no page of its own (e.g. raw evidence), in which case the caller opens the
 * evidence inspector.
 */
export function citationHref(id: string, ref: ScopedEvidenceRef | undefined): string | null {
  const kind = ref?.kind ?? "";
  const runId = ref?.run_id ?? null;
  const enc = encodeURIComponent;
  if (kind === "event" || id.startsWith("evt_")) return runId ? `/runs/${enc(runId)}?event=${enc(id)}` : null;
  if (kind === "finding" || kind === "related_finding" || id.startsWith("fnd_")) return `/findings/${enc(id)}`;
  if (kind === "run" || id.startsWith("run_")) return `/runs/${enc(id)}`;
  if (kind === "safeguard" || id.startsWith("sg_")) return `/safeguards/${enc(id)}`;
  if (kind.startsWith("verification") || id.startsWith("ver_")) {
    const sg = ref?.safeguard_id ?? `${ref?.source ?? ""} ${ref?.summary ?? ""}`.match(/\bsg_[A-Za-z0-9_-]+/)?.[0] ?? null;
    return sg ? `/safeguards/${enc(sg)}?verification=${enc(id)}` : "/safeguards";
  }
  if (kind === "digest") return "/findings?mode=digest";
  if (kind === "overview") return "/overview";
  if (kind === "coverage") return runId ? `/runs/${enc(runId)}` : null;
  if (ref?.finding_id) return `/findings/${enc(ref.finding_id)}`;
  return null;
}
