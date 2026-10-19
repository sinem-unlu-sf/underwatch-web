import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { API_ROUTES, MECHANISMS, apiPaths } from "@kw/schema";
import { importFixture } from "../ingest/fixtures";
import { buildFixtureFile } from "./bundle";
import { createTestApp, getJson, postJson, tableCount, type TestContext } from "./helpers";

let ctx: TestContext;
beforeEach(async () => {
  ctx = await createTestApp();
});
afterEach(() => ctx.close());

describe("Ask Witness scaffold", () => {
  it("applies migration 002 with all addendum tables", () => {
    for (const t of ["workspaces", "workspace_file_changes", "investigations", "investigation_turns", "safeguard_versions", "safeguard_events", "idempotency_keys"]) {
      expect(tableCount(ctx.db, t)).toBe(0);
    }
    const cols = (ctx.db.prepare("PRAGMA table_info(safeguards)").all() as { name: string }[]).map((c) => c.name);
    expect(cols).toEqual(expect.arrayContaining(["lifecycle_status", "verification_state", "current_version_id", "workspace_id"]));
    const vcols = (ctx.db.prepare("PRAGMA table_info(verification_runs)").all() as { name: string }[]).map((c) => c.name);
    expect(vcols).toEqual(expect.arrayContaining(["verification_status", "cases", "environment", "artifacts", "limitations", "client_request_id"]));
  });

  it("keeps v1 fixture import working on the extended tables", () => {
    const res = importFixture(ctx.db, buildFixtureFile("fx-scaffold"));
    expect(res.ok).toBe(true);
    expect(tableCount(ctx.db, "safeguards")).toBe(1);
  });

  it("serves auth check and the mechanism table", async () => {
    expect((await getJson(ctx.app, apiPaths.authCheck())).status).toBe(200);
    const m = await getJson(ctx.app, apiPaths.safeguardMechanisms());
    expect(m.status).toBe(200);
    expect(m.body.items).toHaveLength(Object.keys(MECHANISMS).length);
  });

  it("registers every addendum route (stubs answer with the ApiError shape, never 404)", async () => {
    const gets = [apiPaths.workspaces(), apiPaths.findingInvestigations("fnd_x"), apiPaths.investigation("inv_x"), apiPaths.safeguard("sg_x"), apiPaths.verificationRun("ver_x"), apiPaths.findingGraph("fnd_x")];
    for (const url of gets) {
      const r = await getJson(ctx.app, url);
      expect(String(r.body?.error?.message ?? ""), url).not.toMatch(/^No route/);
    }
    const r = await postJson(ctx.app, apiPaths.safeguardApprove("sg_x"), { version_id: "sgv_x", expected_before_sha256: null });
    expect(r.status).toBe(400); // confirm: true missing
    expect(Object.keys(API_ROUTES).length).toBeGreaterThan(12);
  });
});
