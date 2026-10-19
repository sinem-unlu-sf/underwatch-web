/**
 * Safeguard generation, versioning and approval (addendum Feature B).
 *
 * - Proposals are deterministic templates derived from the finding; ai& may refine only the CLAUDE.md wording, and
 *   its output is validated (schema, citations against the bundle, forbidden text) or discarded.
 * - Versions are immutable; edits append a version. Events are append-only, and user actions are actor_type "user".
 * - Files change only on approve with confirm:true, through WorkspaceService.applyChange (hash compare-and-swap).
 *   Without an authorized workspace the approval is recorded as a patch export and nothing is written.
 * - permission_rule safeguards are written as append-only overlays under <dataDir>/policies/ for supervised runs only.
 */
import { createTwoFilesPatch } from "diff";
import type { InferenceResult } from "@kw/inference";
import {
  ANY_CLAUDE_MD_MARKER_RE,
  claudeMdBlockMarkers,
  DEFAULT_CLAUDE_MD_PATH,
  ID_PART_SEPARATOR,
  makeStableId,
  MECHANISMS,
  mergeClaudeMdBlock,
  SAFEGUARD_LIFECYCLE_TRANSITIONS,
  sha256Hex,
  VerificationPlan,
  type FileDiffPreview,
  type SafeguardDetailResponse,
  type SafeguardLifecycleStatus,
  type SafeguardMutationResponse,
  type SafeguardProposalBody,
  type SafeguardProposalResponse,
  type SafeguardType,
  type SafeguardVersion,
  type Severity,
  type VerificationRunV2,
  type Workspace,
  type WorkspaceFileChange,
} from "@kw/schema";
import type { ServerContext } from "../context";
import { stmt } from "../db/codec";
import { transaction } from "../db/connection";
import type { FindingStatus } from "@kw/schema";
import { ApiHttpError, notFound } from "../errors";
import { getFindingDetail } from "../repo/findings";
import type { ApplyChangeResult, SafeguardService, SupervisedPolicyRule } from "../services/types";
import { parsePermissionRuleContent, writePolicyOverlay } from "./policy";
import { PROPOSE_SAFEGUARD_V2_PROMPT_VERSION, refinementTemplate, refinementValidator, type SafeguardRefinement } from "./prompt";
import * as store from "./store";
import { buildTemplateProposals, deriveFacts, type TemplateProposal } from "./templates";
import { canonicalKernelEnforcementContent, parseKernelEnforcementContent } from "../observers/enforcement-content";

const PROPOSAL_SCOPE = "safeguard_proposal";
const CLAUDE_MD = "claude_md_instruction";

type Generation = SafeguardProposalResponse["generation"];

function isNotImplemented(err: unknown): boolean {
  return err instanceof ApiHttpError && err.code === "not_implemented";
}

async function orDefault<T>(p: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await p();
  } catch {
    return fallback;
  }
}

function unifiedPatch(relPath: string, before: string | null, after: string): string {
  return createTwoFilesPatch(before === null ? "/dev/null" : `a/${relPath}`, `b/${relPath}`, before ?? "", after);
}

/** Patch-only preview against an empty file (no workspace connected); used only if WorkspaceService is unavailable. */
function localPreview(relPath: string, safeguardId: string, content: string, now: string): FileDiffPreview {
  const after = mergeClaudeMdBlock(null, safeguardId, content);
  return {
    workspace_id: null,
    rel_path: relPath,
    before_exists: false,
    before_sha256: null,
    after_sha256: sha256Hex(after),
    before: null,
    after,
    unified_diff: unifiedPatch(relPath, null, after),
    duplicate_of: null,
    generated_at: now,
  };
}

/** Lifecycle targets the user can reach now. Legacy (unversioned) rows get none; unavailable mechanisms cannot be approved. */
function allowedTransitions(rec: store.SafeguardRecord): SafeguardLifecycleStatus[] {
  if (!rec.versioned) return [];
  const type = rec.safeguard.type;
  // "approved" without application = patch export (no workspace); the user may edit, or approve again with a workspace.
  let next: SafeguardLifecycleStatus[] =
    rec.lifecycle === "approved"
      ? type === CLAUDE_MD
        ? ["proposed", "approved"]
        : []
      : SAFEGUARD_LIFECYCLE_TRANSITIONS[rec.lifecycle].filter((s) => s !== "applied" && s !== "application_failed");
  if (MECHANISMS[type].availability.status !== "available") next = next.filter((s) => s !== "approved");
  if (type !== CLAUDE_MD) next = next.filter((s) => s !== "rolled_back");
  return next;
}

/**
 * Auditor fix: a CLAUDE.md safeguard edited after it was applied is "proposed" (new version) while the OLD block is
 * still on disk. It must stay roll-back-able, and it must not be rejectable while that block is on disk (a "rejected"
 * label next to a live CLAUDE.md block would misstate the file's state).
 */
function transitionsWithChanges(rec: store.SafeguardRecord, changes: readonly { status: string }[]): SafeguardLifecycleStatus[] {
  const next = allowedTransitions(rec);
  if (rec.safeguard.type !== CLAUDE_MD || !changes.some((c) => c.status === "applied")) return next;
  const out = next.filter((s) => s !== "rejected");
  if (rec.lifecycle === "proposed" && !out.includes("rolled_back")) out.push("rolled_back");
  return out;
}

function requireAllowed(rec: store.SafeguardRecord, to: SafeguardLifecycleStatus, what: string): void {
  if (!rec.versioned) {
    throw new ApiHttpError("invalid_transition", `Safeguard ${rec.safeguard.id} is a fixture/legacy record without versions; it cannot be ${what}. Generate a new proposal instead.`);
  }
  if (to === "approved" && MECHANISMS[rec.safeguard.type].availability.status !== "available") {
    const a = MECHANISMS[rec.safeguard.type].availability;
    throw new ApiHttpError("invalid_transition", `This mechanism is unavailable in this build: ${a.status === "unavailable" ? a.reason : ""}`.trim());
  }
  if (!allowedTransitions(rec).includes(to)) {
    throw new ApiHttpError("invalid_transition", `Cannot ${what === "rolled back" ? "roll back" : what.replace(/ed$/, "")} a safeguard in state "${rec.lifecycle}".`);
  }
}

function validateContent(type: SafeguardType, content: string, safeguardId: string): { content: string; plan?: VerificationPlan } {
  const { begin, end } = claudeMdBlockMarkers(safeguardId);
  switch (type) {
    case "claude_md_instruction":
      if (content.includes(begin) || content.includes(end) || ANY_CLAUDE_MD_MARKER_RE.test(content)) {
        throw new ApiHttpError("validation_error", "Instruction text must not contain Underwatch block markers.");
      }
      return { content };
    case "permission_rule": {
      const rules = parsePermissionRuleContent(content);
      const perms: Record<string, string[]> = { deny: rules.deny };
      if (rules.ask.length) perms.ask = rules.ask;
      return { content: JSON.stringify({ permissions: perms }, null, 2) };
    }
    case "regression_test": {
      let raw: unknown;
      try {
        raw = JSON.parse(content);
      } catch {
        throw new ApiHttpError("validation_error", 'regression_test content must be a JSON verification plan: {"cases": [...]}.');
      }
      const plan = VerificationPlan.safeParse(raw);
      if (!plan.success) throw new ApiHttpError("validation_error", "regression_test content is not a valid verification plan.");
      const kinds = new Set(plan.data.cases.map((c) => c.kind));
      if (!kinds.has("restricted") || !kinds.has("legitimate")) {
        throw new ApiHttpError("validation_error", "A verification plan needs at least one restricted and one legitimate case.");
      }
      return { content: JSON.stringify(plan.data, null, 2), plan: plan.data };
    }
    case "hook_policy":
      return { content };
    case "kernel_enforcement": {
      const parsed = parseKernelEnforcementContent(content);
      if (!parsed.ok) throw new ApiHttpError("validation_error", `kernel_enforcement content: ${parsed.reason}. Expected {"deny_open_paths": ["/workspace/.env"]}.`);
      return { content: canonicalKernelEnforcementContent(parsed.paths) };
    }
  }
}

/** Warning flag for proposals whose source finding a reviewer has not confirmed (proposing is still allowed). */
export function proposalBasis(status: FindingStatus): { finding_confirmed: boolean; warnings: string[] } {
  const confirmed = status === "confirmed" || status === "resolved";
  return {
    finding_confirmed: confirmed,
    warnings: confirmed ? [] : [`The source finding is "${status}", not confirmed by a reviewer. Review its evidence before approving these safeguards.`],
  };
}

export function createSafeguardService(ctx: ServerContext): SafeguardService {
  const db = ctx.db;
  const nowIso = () => ctx.now().toISOString();
  const ws = () => ctx.services.workspaces;
  const inflight = new Map<string, Promise<SafeguardProposalResponse>>();

  function requireRecord(id: string): store.SafeguardRecord {
    const rec = store.getSafeguardRecord(db, id);
    if (!rec) throw notFound("Safeguard", id);
    return rec;
  }

  async function preview(workspaceId: string | null, relPath: string, safeguardId: string, content: string): Promise<FileDiffPreview> {
    try {
      return await ws().proposeClaudeMdChange(workspaceId, relPath, { safeguard_id: safeguardId, content });
    } catch (err) {
      if (workspaceId === null && isNotImplemented(err)) return localPreview(relPath, safeguardId, content, nowIso());
      throw err;
    }
  }

  async function get(id: string): Promise<SafeguardDetailResponse> {
    const rec = requireRecord(id);
    const sg = rec.safeguard;
    const f = stmt(db, "SELECT id, title, severity, run_id, is_fixture FROM findings WHERE id = ?").get(sg.finding_id);
    if (!f) throw notFound("Finding", sg.finding_id);
    const versions = store.listVersions(db, id);
    const current = versions.find((v) => v.id === rec.current_version_id) ?? null;
    const workspace: Workspace | null = rec.workspace_id ? await orDefault(() => ws().getWorkspace(rec.workspace_id!), null) : null;

    let diff_preview: FileDiffPreview | null = null;
    if (current && sg.type === CLAUDE_MD) {
      const relPath = current.target.rel_path ?? DEFAULT_CLAUDE_MD_PATH;
      const wsId = workspace && workspace.status === "active" ? workspace.id : null;
      // Recomputed against the live file on every request; never cached.
      diff_preview = await orDefault(() => preview(wsId, relPath, id, current.content), null);
    }
    const file_changes: WorkspaceFileChange[] = await orDefault(() => ws().listChanges({ safeguardId: id }), []);
    const runs: VerificationRunV2[] = await orDefault(() => ctx.services.verification.listForSafeguard(id), []);
    runs.sort((a, b) => Date.parse(b.started_at) - Date.parse(a.started_at));
    file_changes.sort((a, b) => Date.parse(a.applied_at) - Date.parse(b.applied_at));

    return {
      safeguard: store.getSafeguardRecord(db, id)!.safeguard,
      lifecycle_status: rec.lifecycle,
      verification_status: rec.verification,
      finding: {
        id: f.id as string,
        title: f.title as string,
        severity: f.severity as Severity,
        run_id: f.run_id as string,
        is_fixture: f.is_fixture === 1 || f.is_fixture === 1n,
      },
      current_version: rec.versioned ? current : null,
      versions,
      history: store.listEvents(db, id),
      mechanism: MECHANISMS[sg.type],
      workspace,
      diff_preview,
      file_changes,
      verification_runs: runs,
      allowed_transitions: transitionsWithChanges(rec, file_changes),
    };
  }

  async function replay(findingId: string, rec: store.IdempotencyRecord, fingerprint: string): Promise<SafeguardProposalResponse> {
    if (rec.request_fingerprint !== fingerprint) {
      throw new ApiHttpError("conflict", "client_request_id was already used for a different proposal request (finding, workspace or investigation differ).");
    }
    const ref = rec.result_ref as { safeguard_ids: string[]; generation: Generation; finding_id: string };
    if (ref.finding_id !== findingId) throw new ApiHttpError("conflict", "client_request_id was already used for a different finding.");
    return { items: await Promise.all(ref.safeguard_ids.map(get)), generation: ref.generation, replayed: true, ...proposalBasis(getFindingDetail(db, findingId).finding.status) };
  }

  async function doPropose(findingId: string, body: SafeguardProposalBody, actor: string, fingerprint: string): Promise<SafeguardProposalResponse> {
    const detail = getFindingDetail(db, findingId); // 404 for unknown findings
    const finding = detail.finding;
    // FR9-01 evidence/status gate (PRD-COVERAGE 4a #5).
    if (finding.status === "dismissed") {
      throw new ApiHttpError("invalid_transition", "This finding was dismissed; safeguards cannot be proposed from a dismissed finding. Reopen it first.");
    }
    if (detail.related_events.length === 0 && detail.evidence.length === 0) {
      throw new ApiHttpError("validation_error", "This finding has no related events or evidence, so there is nothing to base a safeguard on.");
    }

    if (body.investigation_id) {
      const inv = stmt(db, "SELECT finding_id FROM investigations WHERE id = ?").get(body.investigation_id);
      if (!inv) throw notFound("Investigation", body.investigation_id);
      if (inv.finding_id !== findingId) throw new ApiHttpError("validation_error", "investigation_id belongs to a different finding.");
    }

    const facts = deriveFacts(finding, detail.related_events, detail.policy);
    const { proposals, skipped } = buildTemplateProposals(facts);
    const extraNotes: string[] = [];

    // Authorized workspace: read CLAUDE.md as UNTRUSTED text. It is only checked locally (never sent to ai&, never interpreted).
    let workspaceId: string | null = null;
    if (body.workspace_id) {
      const w = await ws().requireWorkspace(body.workspace_id);
      workspaceId = w.id;
      const md = await ws().readClaudeMd(w.id, DEFAULT_CLAUDE_MD_PATH);
      if (md.content && facts.resources.some((r) => md.content!.includes(r))) {
        extraNotes.push(
          `The current CLAUDE.md already mentions ${facts.resources.join(", ")}; Underwatch did not interpret that text (it is untrusted). Review the diff for overlap.`,
        );
      }
    }

    const evidence = await ctx.services.evidence.forFinding(findingId, null);
    const allowed = new Set(evidence.bundle.allowed_ids);
    const cite = (ids: string[]) => ids.filter((id) => allowed.has(id));

    // ai& refinement of the CLAUDE.md wording only. Never throws; any failure keeps the template text.
    const md = proposals.find((p) => p.type === CLAUDE_MD)!;
    const { tpl, cacheVariant } = refinementTemplate(md.content, { findingId, resources: facts.resources });
    let aiResult: InferenceResult<SafeguardRefinement> | null = null;
    try {
      aiResult = await ctx.inference.runTemplate(tpl, evidence.bundle, refinementValidator(evidence.bundle.allowed_ids), { cacheVariant });
    } catch {
      aiResult = null;
    }
    let mdAuthor: "ai" | "template" = "template";
    let mdModel: string | null = null;
    let generation: Generation;
    const deterministic = "Permission rule, hook and regression scenario are deterministic templates derived from the finding.";
    if (aiResult?.status === "ok") {
      const v = aiResult.value;
      md.content = v.instruction;
      md.rationale = `${v.rationale} (Wording refined by ai& from the Underwatch template; every cited evidence id was checked against the evidence bundle.)`;
      md.limitations = [...md.limitations, ...v.limitations.map((l) => `ai& note: ${l}`)];
      md.evidence_ids = v.evidence_ids;
      mdAuthor = "ai";
      mdModel = aiResult.meta.served_model ?? aiResult.meta.model;
      generation = { author: "ai", ai_status: "ok", detail: `CLAUDE.md wording refined by ai& (${mdModel}); citations validated. ${deterministic}` };
    } else {
      const status = aiResult?.status ?? "error";
      const why =
        aiResult === null
          ? "provider error"
          : aiResult.status === "unavailable"
            ? aiResult.reason
            : aiResult.status === "invalid_output"
              ? `output rejected by validation: ${aiResult.errors.slice(0, 2).join("; ")}`
              : aiResult.status;
      generation = { author: "template", ai_status: status, detail: `template - ai& unavailable (${why}). ${deterministic}` };
    }
    if (skipped.length) generation.detail += ` ${skipped.join(" ")}`;

    const at = nowIso();
    const key = body.client_request_id;
    const ids: string[] = [];
    const committed = transaction(db, () => {
      for (const p of proposals) {
        const sgId = makeStableId("safeguard", findingId, key, p.type);
        const author = p.type === CLAUDE_MD ? mdAuthor : "template";
        const v1 = store.versionId(sgId, 1);
        const evidenceIds = cite(p.evidence_ids);
        const limitations = p.type === CLAUDE_MD ? [...p.limitations, ...extraNotes] : p.limitations;
        store.insertSafeguardRow(
          db,
          {
            id: sgId,
            finding_id: findingId,
            is_fixture: finding.is_fixture,
            type: p.type,
            title: p.title,
            content: p.content,
            application_mechanism: p.application_mechanism,
            target_path: p.target.rel_path ?? null,
            intended_effect: p.intended_effect,
            legitimate_workflow_impact: p.legitimate_workflow_impact,
            approval_status: "proposed",
            application_status: "not_applied",
            verification_status: "not_tested",
            created_at: at,
            approved_at: null,
            approved_by: null,
            applied_at: null,
            last_verification_run_id: null,
          },
          { source_investigation_id: body.investigation_id ?? null, proposal_request_id: key, workspace_id: p.type === CLAUDE_MD ? workspaceId : null },
        );
        const version: SafeguardVersion = {
          id: v1,
          safeguard_id: sgId,
          version: 1,
          type: p.type,
          content: p.content,
          target: { kind: p.target.kind, ...(p.target.rel_path ? { rel_path: p.target.rel_path } : {}), ...(p.type === CLAUDE_MD && workspaceId ? { workspace_id: workspaceId } : {}) },
          rationale: p.rationale,
          intended_effect: p.intended_effect,
          limitations,
          verification_plan: p.verification_plan,
          evidence_ids: evidenceIds,
          author,
          source_investigation_id: body.investigation_id ?? null,
          model: author === "ai" ? mdModel : null,
          prompt_version: author === "ai" ? PROPOSE_SAFEGUARD_V2_PROMPT_VERSION : null,
          created_at: at,
        };
        store.insertVersion(db, version);
        store.setState(db, sgId, { lifecycle: "proposed", verification: "not_tested", current_version_id: v1 });
        const dropped = p.evidence_ids.filter((id) => !allowed.has(id));
        store.appendEvent(db, {
          safeguard_id: sgId,
          version_id: v1,
          action: "proposed",
          actor_type: "user",
          actor,
          note: author === "ai" ? "Proposal generated; CLAUDE.md wording refined by ai&." : "Proposal generated from the deterministic template.",
          details: { author, ai_status: generation.ai_status, mechanism_available: MECHANISMS[p.type].availability.status === "available", dropped_evidence_ids: dropped.length },
          at,
        });
        ids.push(sgId);
      }
      if (!store.putIdempotency(db, PROPOSAL_SCOPE, key, fingerprint, { finding_id: findingId, safeguard_ids: ids, generation }, at)) {
        throw new ApiHttpError("conflict", "concurrent proposal with the same client_request_id");
      }
      return true;
    });
    void committed;
    return { items: await Promise.all(ids.map(get)), generation, replayed: false, ...proposalBasis(finding.status) };
  }

  return {
    get,

    async propose(findingId, body, actor) {
      const fingerprint = sha256Hex([findingId, body.workspace_id ?? "", body.investigation_id ?? ""].join(ID_PART_SEPARATOR));
      const existing = store.getIdempotency(db, PROPOSAL_SCOPE, body.client_request_id);
      if (existing) return replay(findingId, existing, fingerprint);
      const running = inflight.get(body.client_request_id);
      if (running) {
        await running.catch(() => undefined);
        const rec = store.getIdempotency(db, PROPOSAL_SCOPE, body.client_request_id);
        if (rec) return replay(findingId, rec, fingerprint);
      }
      const p = doPropose(findingId, body, actor, fingerprint);
      inflight.set(body.client_request_id, p);
      try {
        return await p;
      } finally {
        inflight.delete(body.client_request_id);
      }
    },

    async addVersion(id, body, actor) {
      const rec = requireRecord(id);
      requireAllowed(rec, "proposed", "edited");
      const current = store.getVersion(db, rec.current_version_id!)!;
      const checked = validateContent(rec.safeguard.type, body.content, id);
      if (checked.content === current.content) throw new ApiHttpError("validation_error", "Content is unchanged; no new version created.");
      const at = nowIso();
      const next: SafeguardVersion = {
        ...current,
        id: store.versionId(id, current.version + 1),
        version: current.version + 1,
        content: checked.content,
        verification_plan: checked.plan ?? current.verification_plan,
        author: "user",
        model: null,
        prompt_version: null,
        created_at: at,
      };
      transaction(db, () => {
        store.insertVersion(db, next);
        // A new version has not been tested; previous runs stay in history for the old version.
        store.setState(db, id, { lifecycle: "proposed", verification: "not_tested", current_version_id: next.id, content: next.content, approved: null });
        store.appendEvent(db, {
          safeguard_id: id,
          version_id: next.id,
          action: "edited",
          actor_type: "user",
          actor,
          note: body.note ?? null,
          details: { from_version: current.version, to_version: next.version },
          at,
        });
      });
      return get(id);
    },

    async reject(id, body, actor) {
      const rec = requireRecord(id);
      requireAllowed(rec, "rejected", "rejected");
      if (rec.safeguard.type === CLAUDE_MD) {
        const live = (await orDefault(() => ws().listChanges({ safeguardId: id }), [] as WorkspaceFileChange[])).filter((c) => c.status === "applied");
        if (live.length > 0)
          throw new ApiHttpError("invalid_transition", `An earlier version of this safeguard is still written to ${live[0]!.rel_path}. Roll that change back first; rejecting now would leave it on disk.`);
      }
      const at = nowIso();
      transaction(db, () => {
        store.setState(db, id, { lifecycle: "rejected", verification: rec.verification });
        store.appendEvent(db, { safeguard_id: id, version_id: rec.current_version_id, action: "rejected", actor_type: "user", actor, note: body.note, at });
      });
      return get(id);
    },

    async approve(id, body, actor): Promise<SafeguardMutationResponse> {
      const rec = requireRecord(id);
      requireAllowed(rec, "approved", "approved");
      if (body.version_id !== rec.current_version_id) {
        throw new ApiHttpError("conflict", "The version you approved is not the current version; review the current version and approve it.");
      }
      const version = store.getVersion(db, body.version_id)!;
      const type = rec.safeguard.type;
      const at = nowIso();
      const approvedEvent = (details: Record<string, unknown>) =>
        store.appendEvent(db, { safeguard_id: id, version_id: version.id, action: "approved", actor_type: "user", actor, details, at });

      if (type === CLAUDE_MD) {
        const relPath = version.target.rel_path ?? DEFAULT_CLAUDE_MD_PATH;
        const workspaceId = body.workspace_id ?? rec.workspace_id ?? null;
        if (!workspaceId) {
          // No authorized workspace: approval is recorded; application is a patch export. Nothing is written.
          transaction(db, () => {
            approvedEvent({ application: "patch_export", file_written: false, rel_path: relPath });
            store.setState(db, id, { lifecycle: "approved", verification: rec.verification, approved: { at, by: actor } });
          });
          return { detail: await get(id), change: null };
        }
        await ws().requireWorkspace(workspaceId); // 403 workspace_not_authorized, no state change
        let result: ApplyChangeResult;
        try {
          result = await ws().applyChange({
            workspaceId,
            relPath,
            expectedBeforeSha256: body.expected_before_sha256,
            block: { safeguard_id: id, content: version.content },
            safeguardId: id,
            versionId: version.id,
          });
        } catch (err) {
          if (err instanceof ApiHttpError && err.statusCode < 500) throw err;
          transaction(db, () => {
            approvedEvent({ application: "workspace_file", workspace_id: workspaceId, rel_path: relPath });
            store.appendEvent(db, {
              safeguard_id: id,
              version_id: version.id,
              action: "application_failed",
              actor_type: "system",
              actor: "underwatch",
              note: "Writing CLAUDE.md failed; the file was not confirmed changed.",
              details: { workspace_id: workspaceId, rel_path: relPath },
              at,
            });
            store.setState(db, id, { lifecycle: "application_failed", verification: rec.verification, workspace_id: workspaceId, approved: { at, by: actor } });
          });
          return { detail: await get(id), change: null };
        }
        if (!result.ok) {
          store.appendEvent(db, {
            safeguard_id: id,
            version_id: version.id,
            action: "conflict_detected",
            actor_type: "system",
            actor: "underwatch",
            note: "CLAUDE.md changed since the diff was generated; nothing was written.",
            details: { expected_sha256: result.conflict.expected_before_sha256, current_sha256: result.conflict.current_sha256, rel_path: relPath },
            at,
          });
          throw new ApiHttpError("file_conflict", `${relPath} changed since you reviewed the diff. Review the regenerated diff and approve again.`, result.conflict);
        }
        const change = result.change;
        transaction(db, () => {
          approvedEvent({ application: "workspace_file", workspace_id: workspaceId, rel_path: relPath, expected_before_sha256: body.expected_before_sha256 });
          store.appendEvent(db, {
            safeguard_id: id,
            version_id: version.id,
            action: "applied",
            actor_type: "system",
            actor: "underwatch",
            details: { change_id: change.id, workspace_id: workspaceId, rel_path: relPath, before_sha256: change.before_sha256, after_sha256: change.after_sha256 },
            at,
          });
          store.setState(db, id, { lifecycle: "applied", verification: rec.verification, workspace_id: workspaceId, approved: { at, by: actor }, applied_at: change.applied_at });
        });
        return { detail: await get(id), change };
      }

      if (type === "permission_rule") {
        const rules = parsePermissionRuleContent(version.content);
        const overlay = writePolicyOverlay(ctx.paths.dataDir, { safeguard_id: id, version_id: version.id, version: version.version, rules, at });
        transaction(db, () => {
          approvedEvent({ application: "supervised_run_policy" });
          store.appendEvent(db, {
            safeguard_id: id,
            version_id: version.id,
            action: "applied",
            actor_type: "system",
            actor: "underwatch",
            note: "Added to Underwatch's supervised-run policy overlay. Your repository and your own Claude Code settings were not changed.",
            details: { policy_overlay: overlay.rel_path, sha256: overlay.sha256, deny: rules.deny, ask: rules.ask },
            at,
          });
          store.setState(db, id, { lifecycle: "applied", verification: rec.verification, approved: { at, by: actor }, applied_at: at });
        });
        return { detail: await get(id), change: null };
      }

      if (type === "kernel_enforcement") {
        const parsed = parseKernelEnforcementContent(version.content);
        transaction(db, () => {
          approvedEvent({ application: "kernel_enforcement" });
          store.appendEvent(db, {
            safeguard_id: id,
            version_id: version.id,
            action: "applied",
            actor_type: "system",
            actor: "underwatch",
            note: "Recorded as a kernel enforcement safeguard: a Tetragon deny-file-open policy is loaded per run, scoped to that run's disposable agent container only, and removed afterwards. Nothing on your Mac or in your repository changes.",
            details: { target: "disposable_agent_container", deny_open_paths: parsed.ok ? parsed.paths : [] },
            at,
          });
          store.setState(db, id, { lifecycle: "applied", verification: rec.verification, approved: { at, by: actor }, applied_at: at });
        });
        return { detail: await get(id), change: null };
      }

      // regression_test: stored as a Underwatch scenario; nothing is written anywhere.
      transaction(db, () => {
        approvedEvent({ application: "scenario" });
        store.appendEvent(db, {
          safeguard_id: id,
          version_id: version.id,
          action: "applied",
          actor_type: "system",
          actor: "underwatch",
          note: "Scenario stored in Underwatch and linked to the finding. Nothing was written to your repository.",
          details: { target: "scenario", cases: version.verification_plan.cases.length },
          at,
        });
        store.setState(db, id, { lifecycle: "applied", verification: rec.verification, approved: { at, by: actor }, applied_at: at });
      });
      return { detail: await get(id), change: null };
    },

    async rollback(id, body, actor): Promise<SafeguardMutationResponse> {
      const rec = requireRecord(id);
      const change = await ws().getChange(body.change_id);
      // Edited after apply: lifecycle is "proposed" (new version) but the applied block is still on disk; allow undoing it.
      const editedAfterApply = rec.versioned && rec.safeguard.type === CLAUDE_MD && rec.lifecycle === "proposed" && change?.status === "applied" && change.safeguard_id === id;
      if (!editedAfterApply) requireAllowed(rec, "rolled_back", "rolled back");
      if (!change || change.safeguard_id !== id) throw notFound("File change", body.change_id);
      if (change.status !== "applied") throw new ApiHttpError("invalid_transition", "This file change was already rolled back.");
      const res = await ws().rollback(body.change_id);
      const at = nowIso();
      if (!res.ok) {
        store.appendEvent(db, {
          safeguard_id: id,
          version_id: change.version_id,
          action: "conflict_detected",
          actor_type: "system",
          actor: "underwatch",
          note: "CLAUDE.md changed after the safeguard was applied; rollback wrote nothing.",
          details: { change_id: change.id, expected_sha256: res.conflict.expected_before_sha256, current_sha256: res.conflict.current_sha256 },
          at,
        });
        throw new ApiHttpError("file_conflict", `${change.rel_path} changed after it was applied; rollback would overwrite those changes. Nothing was written.`, res.conflict);
      }
      transaction(db, () => {
        store.appendEvent(db, {
          safeguard_id: id,
          version_id: change.version_id,
          action: "rolled_back",
          actor_type: "user",
          actor,
          details: { change_id: change.id, rel_path: change.rel_path, restored_sha256: change.before_sha256 },
          at,
        });
        if (!editedAfterApply) store.setState(db, id, { lifecycle: "rolled_back", verification: rec.verification });
      });
      return { detail: await get(id), change: res.change };
    },

    async patch(id, versionId) {
      const rec = requireRecord(id);
      if (rec.safeguard.type !== CLAUDE_MD) throw new ApiHttpError("validation_error", "Patch export is available only for CLAUDE.md instruction safeguards.");
      const vid = versionId ?? rec.current_version_id;
      const version = vid ? store.getVersion(db, vid) : null;
      if (!version || version.safeguard_id !== id) throw notFound("Safeguard version", vid ?? "(none)");
      const relPath = version.target.rel_path ?? DEFAULT_CLAUDE_MD_PATH;
      const block = { safeguard_id: id, content: version.content };
      try {
        return await ws().exportPatch(rec.workspace_id, relPath, block);
      } catch (err) {
        if (rec.workspace_id === null && isNotImplemented(err)) return unifiedPatch(relPath, null, mergeClaudeMdBlock(null, id, version.content));
        throw err;
      }
    },

    async getVersion(versionId) {
      return store.getVersion(db, versionId);
    },

    async supervisedPolicyRules(): Promise<SupervisedPolicyRule[]> {
      const out: SupervisedPolicyRule[] = [];
      for (const r of store.appliedOfType(db, "permission_rule")) {
        const v = store.getVersion(db, r.current_version_id);
        if (!v) continue;
        try {
          const rules = parsePermissionRuleContent(v.content);
          out.push({ safeguard_id: r.id, version_id: v.id, deny: rules.deny, ask: rules.ask });
        } catch {
          // invalid content never reaches the policy
        }
      }
      return out;
    },

    async recordVerification(safeguardId, run) {
      const rec = requireRecord(safeguardId);
      store.setState(db, safeguardId, { lifecycle: rec.lifecycle, verification: run.verification_status, last_verification_run_id: run.id });
    },
  };
}

export type { TemplateProposal };
