import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createTwoFilesPatch } from "diff";
import { afterEach, describe, expect, it } from "vitest";
import { emptyMeta, NullProvider, type EvidenceBundle, type InferenceProvider, type InferenceResult, type PromptTemplate, type TemplateValidator } from "@kw/inference";
import {
  apiPaths,
  EVIDENCE_SUPPORT_LABELS,
  makeStableId,
  mergeClaudeMdBlock,
  sha256Hex,
  type FileDiffPreview,
  type SafeguardDetailResponse,
  type SafeguardProposalResponse,
  type Workspace,
  type WorkspaceFileChange,
} from "@kw/schema";
import { importFixtureFile } from "../ingest/fixtures";
import { ApiHttpError } from "../errors";
import { FIXTURE_RUNS_DIR } from "../config";
import type { ServerContext } from "../context";
import type { ApplyChangeResult, WorkspaceService } from "../services/types";
import { createTestApp, createTestPaths, getJson, postJson, tableCount, type TestContext } from "../test/helpers";

const FINDING = "fnd_fx04_env_read_via_bash";

/** In-memory WorkspaceService over a real temp directory (the real one is owned by the AUTH+WORKSPACE module). */
function fakeWorkspaces(root: string, wsId: string) {
  const changes = new Map<string, WorkspaceFileChange>();
  const blobs = new Map<string, string>();
  const ws: Workspace = { id: wsId, label: "test", root_path: root, kind: "demo", authorized_at: "2026-10-17T00:00:00.000Z", status: "active" };
  const file = (rel: string) => path.join(root, rel);
  const read = (rel: string) => (existsSync(file(rel)) ? readFileSync(file(rel), "utf8") : null);
  const preview = (workspaceId: string | null, rel: string, sgId: string, content: string): FileDiffPreview => {
    const before = workspaceId ? read(rel) : null;
    const after = mergeClaudeMdBlock(before, sgId, content);
    return {
      workspace_id: workspaceId,
      rel_path: rel,
      before_exists: before !== null,
      before_sha256: before === null ? null : sha256Hex(before),
      after_sha256: sha256Hex(after),
      before,
      after,
      unified_diff: createTwoFilesPatch(`a/${rel}`, `b/${rel}`, before ?? "", after),
      duplicate_of: null,
      generated_at: new Date().toISOString(),
    };
  };
  const svc = (_ctx: ServerContext): WorkspaceService => ({
    listWorkspaces: async () => [ws],
    getWorkspace: async (id) => (id === wsId ? ws : null),
    requireWorkspace: async (id) => {
      if (id !== wsId) throw new ApiHttpError("workspace_not_authorized", "not authorized");
      return ws;
    },
    authorizeWorkspace: async () => ws,
    createDemoWorkspace: async () => ({ workspace: ws, reset: false, files: [] }),
    readClaudeMd: async (_id, rel) => {
      const c = read(rel);
      return { content: c, sha256: c === null ? null : sha256Hex(c), size_bytes: c === null ? null : c.length };
    },
    proposeClaudeMdChange: async (id, rel, block) => preview(id, rel, block.safeguard_id, block.content),
    applyChange: async (input): Promise<ApplyChangeResult> => {
      const before = read(input.relPath);
      const cur = before === null ? null : sha256Hex(before);
      if (cur !== input.expectedBeforeSha256) {
        return {
          ok: false,
          conflict: { expected_before_sha256: input.expectedBeforeSha256, current_sha256: cur, diff_preview: preview(input.workspaceId, input.relPath, input.block.safeguard_id, input.block.content) },
        };
      }
      const after = mergeClaudeMdBlock(before, input.block.safeguard_id, input.block.content);
      writeFileSync(file(input.relPath), after);
      if (before !== null) blobs.set(sha256Hex(before), before);
      const change: WorkspaceFileChange = {
        id: `wfc_${changes.size + 1}`,
        workspace_id: input.workspaceId,
        safeguard_id: input.safeguardId,
        version_id: input.versionId,
        rel_path: input.relPath,
        before_sha256: cur,
        after_sha256: sha256Hex(after),
        before_blob: cur,
        after_blob: sha256Hex(after),
        status: "applied",
        applied_at: new Date().toISOString(),
        rolled_back_at: null,
      };
      changes.set(change.id, change);
      return { ok: true, change };
    },
    rollback: async (changeId) => {
      const c = changes.get(changeId)!;
      const now = read(c.rel_path);
      if (now === null || sha256Hex(now) !== c.after_sha256) {
        return { ok: false, conflict: { expected_before_sha256: c.after_sha256, current_sha256: now === null ? null : sha256Hex(now), diff_preview: preview(c.workspace_id, c.rel_path, c.safeguard_id, "x") } };
      }
      if (c.before_blob) writeFileSync(file(c.rel_path), blobs.get(c.before_blob)!);
      else rmSync(file(c.rel_path));
      const done = { ...c, status: "rolled_back" as const, rolled_back_at: new Date().toISOString() };
      changes.set(c.id, done);
      return { ok: true, change: done };
    },
    getChange: async (id) => changes.get(id) ?? null,
    listChanges: async ({ safeguardId }) => [...changes.values()].filter((c) => c.safeguard_id === safeguardId),
    exportPatch: async (id, rel, block) => preview(id, rel, block.safeguard_id, block.content).unified_diff,
    snapshot: async () => ({ workspace_id: wsId, manifest_sha256: "0".repeat(64), files: [] }),
  });
  return { svc, file };
}

/** ai& stand-in: runs the app's validator on a canned model output (never touches the network). */
function fakeAi(raw: (allowed: string[]) => unknown): InferenceProvider {
  class FakeAi extends NullProvider {
    override async runTemplate<T>(tpl: PromptTemplate, bundle: EvidenceBundle, validate: TemplateValidator<T>): Promise<InferenceResult<T>> {
      const meta = emptyMeta({ provider: "fake-aiand", model: "fake-model", prompt_version: tpl.prompt_version, schema_version: tpl.schema_version });
      const v = validate(raw(bundle.allowed_ids));
      return v.ok ? { status: "ok", value: v.value, meta } : { status: "invalid_output", errors: v.errors, detail: "invalid", meta };
    }
  }
  return new FakeAi();
}

let ctx: TestContext | null = null;
afterEach(async () => {
  await ctx?.close();
  ctx = null;
});

async function setup(opts: { ai?: InferenceProvider; claudeMd?: string | null } = {}) {
  const paths = createTestPaths();
  const root = path.join(paths.workspacesDir, "demo");
  mkdirSync(root, { recursive: true });
  if (opts.claudeMd !== null) writeFileSync(path.join(root, "CLAUDE.md"), opts.claudeMd ?? "# demo\n\n- Run the tests.\n");
  const wsId = "ws_test";
  const fake = fakeWorkspaces(root, wsId);
  const c = await createTestApp({}, { paths, inference: opts.ai, services: { workspaces: fake.svc } });
  const ownClose = c.close;
  ctx = { ...c, close: async () => (await ownClose(), rmSync(paths.dataDir, { recursive: true, force: true })) };
  expect(importFixtureFile(c.db, path.join(FIXTURE_RUNS_DIR, "fx-04-env-read-via-bash.json")).ok).toBe(true);
  c.db.prepare("INSERT INTO workspaces (id, label, root_path, kind, authorized_at, status, created_at, updated_at) VALUES (?, 'test', ?, 'demo', ?, 'active', ?, ?)").run(
    wsId,
    root,
    "2026-10-17T00:00:00.000Z",
    "2026-10-17T00:00:00.000Z",
    "2026-10-17T00:00:00.000Z",
  );
  return { app: c.app, db: c.db, wsId, file: fake.file, paths };
}

async function propose(app: TestContext["app"], body: Record<string, unknown>) {
  return postJson<SafeguardProposalResponse>(app, apiPaths.findingSafeguardProposals(FINDING), body);
}

const byType = (r: SafeguardProposalResponse, t: string): SafeguardDetailResponse => r.items.find((i) => i.safeguard.type === t)!;

describe("safeguard proposals", () => {
  it("produces finding-specific proposals citing valid bundle evidence, labeled template when ai& is unavailable", async () => {
    const { app } = await setup();
    const r = await propose(app, { client_request_id: "req-proposal-0001" });
    expect(r.status).toBe(200);
    expect(r.body.replayed).toBe(false);
    expect(r.body.generation.author).toBe("template");
    expect(r.body.generation.detail).toMatch(/^template - ai& unavailable/);
    expect(r.body.items.map((i) => i.safeguard.type).sort()).toEqual(["claude_md_instruction", "hook_policy", "kernel_enforcement", "permission_rule", "regression_test"]);

    const evidence = await ctx!.app.inject({ method: "GET", url: apiPaths.finding(FINDING) });
    const detail = evidence.json();
    const known = new Set<string>([FINDING, ...detail.related_events.map((e: { id: string }) => e.id), ...detail.evidence.map((e: { id: string }) => e.id), `${detail.policy.id}#R1`]);
    for (const item of r.body.items) {
      expect(item.finding.id).toBe(FINDING);
      expect(item.lifecycle_status).toBe("proposed");
      expect(item.current_version!.version).toBe(1);
      expect(item.current_version!.author).toBe("template");
      expect(item.current_version!.evidence_ids.length).toBeGreaterThan(0);
      for (const id of item.current_version!.evidence_ids) expect(known.has(id)).toBe(true);
      expect(item.current_version!.verification_plan.cases.map((c) => c.kind).sort()).toEqual(["legitimate", "restricted"]);
      expect(item.history.map((h) => [h.action, h.actor_type])).toEqual([["proposed", "user"]]);
    }

    const md = byType(r.body, "claude_md_instruction");
    expect(md.current_version!.content).toContain(".env");
    expect(md.current_version!.content).toContain("cat .env");
    expect(md.current_version!.content).toContain(FINDING);
    expect(md.mechanism.can_enforce).toBe(false);
    expect(md.mechanism.kind).toBe("instruction");
    expect(md.diff_preview!.workspace_id).toBeNull();
    expect(md.diff_preview!.unified_diff).toContain("+");

    const perm = byType(r.body, "permission_rule");
    expect(JSON.parse(perm.current_version!.content)).toEqual({ permissions: { deny: ["Read(./.env)"] } });
    expect(perm.current_version!.target.kind).toBe("supervised_run_policy");
    expect(perm.current_version!.limitations.join(" ")).toMatch(/python3|subprocess/);

    const hook = byType(r.body, "hook_policy");
    expect(hook.mechanism.availability.status).toBe("unavailable");
    expect(hook.allowed_transitions).not.toContain("approved");
  });

  it("is idempotent on client_request_id and rejects key reuse with a different payload", async () => {
    const { app, db, wsId } = await setup();
    const a = await propose(app, { client_request_id: "req-proposal-0002" });
    const n = tableCount(db, "safeguards");
    const b = await propose(app, { client_request_id: "req-proposal-0002" });
    expect(b.status).toBe(200);
    expect(b.body.replayed).toBe(true);
    expect(b.body.items.map((i) => i.safeguard.id)).toEqual(a.body.items.map((i) => i.safeguard.id));
    expect(tableCount(db, "safeguards")).toBe(n);
    const c = await propose(app, { client_request_id: "req-proposal-0002", workspace_id: wsId });
    expect(c.status).toBe(409);
    expect((c.body as any).error.code).toBe("conflict");
  });

  it("uses ai& wording only when its citations validate; invalid citations fall back to the template", async () => {
    const good = fakeAi((allowed) => ({
      instruction: "Never read .env, neither with the Read tool nor with Bash cat .env or scripts. Ask the user instead.",
      rationale: "The agent read .env via Bash after a denied Read.",
      limitations: ["Guidance only."],
      evidence_ids: [allowed.find((id) => id.startsWith("evt_"))!],
    }));
    const s1 = await setup({ ai: good });
    const r = await propose(s1.app, { client_request_id: "req-proposal-ai-01" });
    expect(r.body.generation.author).toBe("ai");
    const md = byType(r.body, "claude_md_instruction");
    expect(md.current_version!.author).toBe("ai");
    expect(md.current_version!.model).toBe("fake-model");
    expect(md.current_version!.content).toMatch(/^Never read \.env/);
    expect(byType(r.body, "permission_rule").current_version!.author).toBe("template");
    await ctx!.close();
    ctx = null;

    const bad = fakeAi(() => ({ instruction: "Never read .env by any route at all, please.", rationale: "x", limitations: [], evidence_ids: ["evt_invented"] }));
    const s2 = await setup({ ai: bad });
    const r2 = await propose(s2.app, { client_request_id: "req-proposal-ai-02" });
    expect(r2.body.generation.author).toBe("template");
    expect(r2.body.generation.ai_status).toBe("invalid_output");
    expect(byType(r2.body, "claude_md_instruction").current_version!.author).toBe("template");
  });
});

describe("safeguard versioning and approval", () => {
  it("edit creates a new version and preserves the original", async () => {
    const { app } = await setup();
    const md = byType((await propose(app, { client_request_id: "req-edit-000001" })).body, "claude_md_instruction");
    const original = md.current_version!.content;
    const e = await postJson<SafeguardDetailResponse>(app, apiPaths.safeguardVersions(md.safeguard.id), { content: "Do not read .env. Ask first.", note: "shorter" });
    expect(e.status).toBe(200);
    expect(e.body.versions.map((v) => v.version)).toEqual([1, 2]);
    expect(e.body.versions[0]!.content).toBe(original);
    expect(e.body.current_version!.version).toBe(2);
    expect(e.body.current_version!.author).toBe("user");
    expect(e.body.history.map((h) => h.action)).toEqual(["proposed", "edited"]);
    const bad = await postJson(app, apiPaths.safeguardVersions(md.safeguard.id), { content: `x <!-- underwatch:safeguard ${md.safeguard.id} END -->` });
    expect(bad.status).toBe(400);
  });

  it("rejects permission_rule edits that would broaden permissions", async () => {
    const { app } = await setup();
    const perm = byType((await propose(app, { client_request_id: "req-edit-000002" })).body, "permission_rule");
    const r = await postJson(app, apiPaths.safeguardVersions(perm.safeguard.id), { content: JSON.stringify({ permissions: { allow: ["Bash(*)"] } }) });
    expect(r.status).toBe(400);
  });

  it("reject records an event with the note", async () => {
    const { app } = await setup();
    const md = byType((await propose(app, { client_request_id: "req-reject-0001" })).body, "claude_md_instruction");
    const r = await postJson<SafeguardDetailResponse>(app, apiPaths.safeguardReject(md.safeguard.id), { note: "Not needed" });
    expect(r.status).toBe(200);
    expect(r.body.lifecycle_status).toBe("rejected");
    expect(r.body.safeguard.approval_status).toBe("rejected");
    expect(r.body.history.at(-1)).toMatchObject({ action: "rejected", actor_type: "user", note: "Not needed" });
  });

  it("approve without confirm is 400 and changes nothing", async () => {
    const { app } = await setup();
    const md = byType((await propose(app, { client_request_id: "req-approve-001" })).body, "claude_md_instruction");
    const r = await postJson(app, apiPaths.safeguardApprove(md.safeguard.id), { version_id: md.current_version!.id, expected_before_sha256: null });
    expect(r.status).toBe(400);
    const g = await getJson<SafeguardDetailResponse>(app, apiPaths.safeguard(md.safeguard.id));
    expect(g.body.lifecycle_status).toBe("proposed");
  });

  it("applies to an authorized workspace with CAS; a stale hash is 409 with a regenerated diff and no write", async () => {
    const { app, wsId, file } = await setup();
    const md = byType((await propose(app, { client_request_id: "req-approve-002", workspace_id: wsId })).body, "claude_md_instruction");
    const reviewed = md.diff_preview!;
    expect(reviewed.workspace_id).toBe(wsId);
    expect(reviewed.before).toContain("# demo");

    // Someone edits CLAUDE.md after the diff was generated.
    writeFileSync(file("CLAUDE.md"), "# demo\n\n- Run the tests.\n- Changed concurrently.\n");
    const stale = await postJson(app, apiPaths.safeguardApprove(md.safeguard.id), {
      version_id: md.current_version!.id,
      workspace_id: wsId,
      expected_before_sha256: reviewed.before_sha256,
      confirm: true,
    });
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe("file_conflict");
    expect(stale.body.error.details.diff_preview.before).toContain("Changed concurrently");
    expect(readFileSync(file("CLAUDE.md"), "utf8")).not.toContain("underwatch");
    const afterConflict = await getJson<SafeguardDetailResponse>(app, apiPaths.safeguard(md.safeguard.id));
    expect(afterConflict.body.history.map((h) => h.action)).toContain("conflict_detected");
    expect(afterConflict.body.lifecycle_status).toBe("proposed");

    const ok = await postJson(app, apiPaths.safeguardApprove(md.safeguard.id), {
      version_id: md.current_version!.id,
      workspace_id: wsId,
      expected_before_sha256: stale.body.error.details.current_sha256,
      confirm: true,
    });
    expect(ok.status).toBe(200);
    expect(ok.body.detail.lifecycle_status).toBe("applied");
    expect(ok.body.change.status).toBe("applied");
    const text = readFileSync(file("CLAUDE.md"), "utf8");
    expect(text).toContain("Changed concurrently");
    expect(text).toContain(`underwatch:safeguard ${md.safeguard.id} BEGIN`);
    // Instruction stays an instruction: never an enforced control.
    expect(ok.body.detail.mechanism.can_enforce).toBe(false);

    const rb = await postJson(app, apiPaths.safeguardRollback(md.safeguard.id), { change_id: ok.body.change.id });
    expect(rb.status).toBe(200);
    expect(rb.body.detail.lifecycle_status).toBe("rolled_back");
    expect(readFileSync(file("CLAUDE.md"), "utf8")).not.toContain("underwatch");
  });

  it("edited after apply: the on-disk block stays roll-back-able and the safeguard cannot be rejected while it is on disk", async () => {
    const { app, wsId, file } = await setup();
    const md = byType((await propose(app, { client_request_id: "req-approve-edit-1", workspace_id: wsId })).body, "claude_md_instruction");
    const ok = await postJson(app, apiPaths.safeguardApprove(md.safeguard.id), {
      version_id: md.current_version!.id,
      workspace_id: wsId,
      expected_before_sha256: md.diff_preview!.before_sha256,
      confirm: true,
    });
    expect(ok.status).toBe(200);
    const edited = await postJson(app, apiPaths.safeguardVersions(md.safeguard.id), { content: "Never open .env by any route; ask the user instead." });
    expect(edited.status).toBe(200);
    expect(edited.body.lifecycle_status).toBe("proposed");
    expect(edited.body.allowed_transitions).toContain("rolled_back");
    expect(edited.body.allowed_transitions).not.toContain("rejected");
    const rej = await postJson(app, apiPaths.safeguardReject(md.safeguard.id), { note: "no" });
    expect(rej.status).toBe(409);
    expect(readFileSync(file("CLAUDE.md"), "utf8")).toContain(`underwatch:safeguard ${md.safeguard.id} BEGIN`);
    const rb = await postJson(app, apiPaths.safeguardRollback(md.safeguard.id), { change_id: ok.body.change.id });
    expect(rb.status).toBe(200);
    expect(rb.body.detail.lifecycle_status).toBe("proposed");
    expect(readFileSync(file("CLAUDE.md"), "utf8")).not.toContain("underwatch");
    const rej2 = await postJson(app, apiPaths.safeguardReject(md.safeguard.id), { note: "no" });
    expect(rej2.status).toBe(200);
  });

  it("without a workspace, approval is a patch export and no file is written", async () => {
    const { app, file } = await setup();
    const before = readFileSync(file("CLAUDE.md"), "utf8");
    const md = byType((await propose(app, { client_request_id: "req-approve-003" })).body, "claude_md_instruction");
    const r = await postJson(app, apiPaths.safeguardApprove(md.safeguard.id), { version_id: md.current_version!.id, expected_before_sha256: null, confirm: true });
    expect(r.status).toBe(200);
    expect(r.body.change).toBeNull();
    expect(r.body.detail.lifecycle_status).toBe("approved");
    expect(r.body.detail.safeguard.application_status).toBe("not_applied");
    expect(r.body.detail.history.at(-1)).toMatchObject({ action: "approved", details: { application: "patch_export", file_written: false } });
    expect(readFileSync(file("CLAUDE.md"), "utf8")).toBe(before);
    const p = await ctx!.app.inject({ method: "GET", url: apiPaths.safeguardPatch(md.safeguard.id) });
    expect(p.statusCode).toBe(200);
    expect(p.headers["content-type"]).toMatch(/text\/plain/);
    expect(p.body).toContain(`+<!-- underwatch:safeguard ${md.safeguard.id} BEGIN -->`);
  });

  it("permission_rule approval writes an append-only supervised-run overlay, never the repo", async () => {
    const { app, paths, file } = await setup();
    const perm = byType((await propose(app, { client_request_id: "req-approve-004" })).body, "permission_rule");
    const r = await postJson(app, apiPaths.safeguardApprove(perm.safeguard.id), { version_id: perm.current_version!.id, expected_before_sha256: null, confirm: true });
    expect(r.status).toBe(200);
    expect(r.body.detail.lifecycle_status).toBe("applied");
    const dir = path.join(paths.dataDir, "policies", "overlays", perm.safeguard.id);
    expect(readdirSync(dir)).toEqual(["v1.json"]);
    expect(JSON.parse(readFileSync(path.join(dir, "v1.json"), "utf8")).permissions.deny).toEqual(["Read(./.env)"]);
    expect(existsSync(file(".claude"))).toBe(false);
    const rules = await ctx!.app.kw.services.safeguards.supervisedPolicyRules();
    expect(rules).toEqual([{ safeguard_id: perm.safeguard.id, version_id: perm.current_version!.id, deny: ["Read(./.env)"], ask: [] }]);
  });

  it("refuses to approve unavailable mechanisms and legacy fixture safeguards", async () => {
    const { app } = await setup();
    const hook = byType((await propose(app, { client_request_id: "req-approve-005" })).body, "hook_policy");
    const r = await postJson(app, apiPaths.safeguardApprove(hook.safeguard.id), { version_id: hook.current_version!.id, expected_before_sha256: null, confirm: true });
    expect(r.status).toBe(409);
    const legacy = await getJson<SafeguardDetailResponse>(app, apiPaths.safeguard("sg_fx04_deny_read_env"));
    expect(legacy.status).toBe(200);
    expect(legacy.body.current_version).toBeNull();
    expect(legacy.body.allowed_transitions).toEqual([]);
    const lr = await postJson(app, apiPaths.safeguardApprove("sg_fx04_deny_read_env"), { version_id: makeStableId("safeguard_version", "x"), expected_before_sha256: null, confirm: true });
    expect(lr.status).toBe(409);
  });

  it("keeps the v1 safeguard list working with synced statuses", async () => {
    const { app } = await setup();
    const md = byType((await propose(app, { client_request_id: "req-list-000001" })).body, "claude_md_instruction");
    await postJson(app, apiPaths.safeguardReject(md.safeguard.id), { note: "no" });
    const list = await getJson(app, `${apiPaths.safeguards()}?finding_id=${FINDING}`);
    expect(list.status).toBe(200);
    expect(list.body.items.find((i: { id: string }) => i.id === md.safeguard.id).approval_status).toBe("rejected");
    expect(EVIDENCE_SUPPORT_LABELS).toBeDefined();
  });
});

describe("safeguard proposal gate (FR9-01, PRD-COVERAGE 4a #5)", () => {
  it("allows a new finding with evidence but flags it as not confirmed", async () => {
    const { app } = await setup();
    const r = await propose(app, { client_request_id: "req-gate-new-0001" });
    expect(r.status).toBe(200);
    expect(r.body.finding_confirmed).toBe(false);
    expect(r.body.warnings?.join(" ")).toMatch(/not confirmed/);
    const replay = await propose(app, { client_request_id: "req-gate-new-0001" });
    expect(replay.body.replayed).toBe(true);
    expect(replay.body.finding_confirmed).toBe(false);
  });

  it("reports a confirmed finding as confirmed with no warning", async () => {
    const { app } = await setup();
    expect((await postJson(app, apiPaths.findingStatus(FINDING), { to: "confirmed" })).status).toBe(200);
    const r = await propose(app, { client_request_id: "req-gate-conf-0001" });
    expect(r.status).toBe(200);
    expect(r.body.finding_confirmed).toBe(true);
    expect(r.body.warnings).toEqual([]);
  });

  it("rejects a dismissed finding with 409 and creates nothing", async () => {
    const { app, db } = await setup();
    const before = tableCount(db, "safeguards");
    db.prepare("UPDATE findings SET status = 'dismissed' WHERE id = ?").run(FINDING);
    const r = await propose(app, { client_request_id: "req-gate-dism-0001" });
    expect(r.status).toBe(409);
    expect((r.body as unknown as { error: { code: string; message: string } }).error.code).toBe("invalid_transition");
    expect(tableCount(db, "safeguards")).toBe(before);
  });

  it("rejects a finding with no related events or evidence with 400", async () => {
    const { app, db } = await setup();
    const before = tableCount(db, "safeguards");
    db.prepare("DELETE FROM finding_events WHERE finding_id = ?").run(FINDING);
    db.prepare("DELETE FROM finding_evidence WHERE finding_id = ?").run(FINDING);
    const r = await propose(app, { client_request_id: "req-gate-empty-0001" });
    expect(r.status).toBe(400);
    expect((r.body as unknown as { error: { code: string } }).error.code).toBe("validation_error");
    expect(tableCount(db, "safeguards")).toBe(before);
  });
});
