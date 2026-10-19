import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FindingBrief, FindingDetailResponse, apiPaths, fixtureRunId, type FindingBriefResponse } from "@kw/schema";
import { importFixture } from "../ingest/fixtures";
import { persistRunBundle } from "../ingest/persist";
import { getFindingDetail } from "../repo/findings";
import { buildBundle, buildFixtureFile } from "../test/bundle";
import { CANARY } from "../test/canaries";
import { createTestApp, getJson, type TestContext } from "../test/helpers";

const LIVE_FINDING = "fnd_live_brief_1";
const LIVE_SG = "sg_live_brief_1";
const LIVE_VER = "ver_live_brief_1";
const FX_FINDING = "fnd_fx_brief_1";

let ctx: TestContext;

beforeEach(async () => {
  ctx = await createTestApp();
  const imported = importFixture(ctx.db, buildFixtureFile("fx-brief"));
  if (!imported.ok) throw new Error(imported.errors.join("\n"));
  persistRunBundle(ctx.db, buildBundle("live-brief", false));
});
afterEach(() => ctx.close());

async function detail(id: string): Promise<FindingDetailResponse> {
  const res = await getJson<FindingDetailResponse>(ctx.app, apiPaths.finding(id));
  expect(res.status).toBe(200);
  return res.body;
}

async function brief(id: string): Promise<FindingBrief> {
  const res = await getJson<FindingBriefResponse>(ctx.app, apiPaths.findingBrief(id));
  expect(res.status).toBe(200);
  return FindingBrief.parse(res.body.brief);
}

function action(b: FindingBrief, mechanism: string) {
  const a = b.how_to_fix.find((x) => x.mechanism === mechanism);
  expect(a, `action for ${mechanism}`).toBeDefined();
  return a!;
}

describe("finding brief (Addendum C)", () => {
  it("is embedded in GET /api/findings/:id without changing any existing field, and matches the finding", async () => {
    const d = await detail(LIVE_FINDING);
    const { brief: embedded, short_read: _shortRead, ...rest } = d;
    // Existing response fields are exactly what the repo served before the brief existed.
    expect(rest).toEqual(JSON.parse(JSON.stringify(getFindingDetail(ctx.db, LIVE_FINDING))));
    expect(embedded).toBeDefined();
    const b = FindingBrief.parse(embedded);
    expect(await brief(LIVE_FINDING)).toEqual(b);

    expect(b.deterministic).toBe(true);
    expect(b.finding_id).toBe(d.finding.id);
    expect(b.category).toBe(d.finding.category);
    expect(b.is_fixture).toBe(false);
    expect(b.affected.run_id).toBe(d.run.id);
    expect(b.affected.task).toBe(d.run.task_description);
    expect(b.affected.resource).toBe(".env");
    expect(b.affected.policy_rule).toEqual({ id: "deny-env", effect: "deny", description: "No .env reads" });
    expect(b.problem).toContain(".env");
    expect(b.why_it_matters.length).toBeGreaterThan(0);
    expect(b.how_to_fix.length).toBeGreaterThanOrEqual(1);
    expect(b.how_to_fix.length).toBeLessThanOrEqual(3);

    // Evidence counts come from the same related events / evidence the full detail serves.
    expect(b.evidence_summary.agent_reported).toBe(d.related_events.filter((e) => e.basis === "reported").length);
    expect(b.evidence_summary.independently_observed).toBe(d.related_events.filter((e) => e.basis === "observed").length);
    expect(b.evidence_summary.evidence_records).toBe(d.evidence.length);
    expect(b.generated_from.event_ids).toEqual(d.related_events.map((e) => e.id));
    expect(b.generated_from.evidence_ids).toEqual(d.evidence.map((e) => e.id));
    expect(b.generated_from.safeguard_ids).toEqual(d.safeguards.map((s) => s.id));
    expect(b.generated_from.verification_run_ids).toEqual([LIVE_VER]);
    expect(b.generated_from.policy_rule_id).toBe("deny-env");
    for (const id of b.evidence_summary.key_event_ids) expect(b.generated_from.event_ids).toContain(id);
    // Missing information on the finding is carried into the uncertainty list verbatim.
    expect(b.uncertainty).toContainEqual({ kind: "missing_information", text: "Whether contents were read" });
    expect(b.uncertainty.map((u) => u.kind)).toContain("confidence");
  });

  it("lists partial coverage as uncertainty", async () => {
    const b = await brief(LIVE_FINDING);
    expect(b.evidence_summary.coverage_level).toBe("partial");
    expect(b.uncertainty.map((u) => u.kind)).toContain("partial_coverage");
    expect(b.evidence_summary.coverage_caveats.join(" ")).toMatch(/network/);
  });

  it("says fixture findings are hand-labeled", async () => {
    const b = await brief(FX_FINDING);
    expect(b.is_fixture).toBe(true);
    expect(b.data_origin).toMatch(/hand-labeled/i);
    expect(b.uncertainty.find((u) => u.kind === "fixture_data")?.text).toMatch(/hand-labeled/);
    expect(b.evidence_summary.text).toMatch(/hand-labeled/);
    expect(b.affected.run_id).toBe(fixtureRunId("fx-brief"));
  });

  it("computes action statuses from stored safeguard / verification rows and never claims an unestablished pass", async () => {
    ctx.db.prepare("UPDATE findings SET category = 'permission_violation' WHERE id = ?").run(LIVE_FINDING);

    // Stored legacy "verified" without independent task evidence is served as inconclusive (read guard), so the brief
    // must not say verified.
    let b = await brief(LIVE_FINDING);
    expect(b.category).toBe("permission_violation");
    const perm = action(b, "permission_rule");
    expect(perm.status).toBe("inconclusive");
    expect(perm.safeguard_id).toBe(LIVE_SG);
    expect(perm.verification_run_id).toBe(LIVE_VER);
    expect(b.how_to_fix.some((a) => a.status === "verified_for_tested_scenario")).toBe(false);
    // Mechanisms without a safeguard record are only proposed.
    expect(action(b, "kernel_enforcement").status).toBe("proposed");
    expect(action(b, "kernel_enforcement").text).toContain("Add a kernel enforcement safeguard for .env");
    expect(action(b, "kernel_enforcement").safeguard_id).toBeNull();

    // After a failed verification the fix shows failed.
    ctx.db.prepare("UPDATE verification_runs SET result = 'failed_verification' WHERE id = ?").run(LIVE_VER);
    ctx.db.prepare("UPDATE safeguards SET verification_status = 'failed_verification' WHERE id = ?").run(LIVE_SG);
    b = await brief(LIVE_FINDING);
    expect(action(b, "permission_rule")).toMatchObject({ status: "failed_verification", status_label: "Failed verification" });
    expect((await detail(LIVE_FINDING)).brief?.how_to_fix.find((a) => a.mechanism === "permission_rule")?.status).toBe("failed_verification");

    // Applied but not verified.
    ctx.db
      .prepare("UPDATE safeguards SET approval_status = 'approved', application_status = 'applied', verification_status = 'not_tested', last_verification_run_id = NULL WHERE id = ?")
      .run(LIVE_SG);
    b = await brief(LIVE_FINDING);
    expect(action(b, "permission_rule").status).toBe("applied");

    // Proposed safeguard, not applied.
    ctx.db.prepare("UPDATE safeguards SET approval_status = 'proposed', application_status = 'not_applied' WHERE id = ?").run(LIVE_SG);
    b = await brief(LIVE_FINDING);
    expect(action(b, "permission_rule").status).toBe("safeguard_proposed");
    for (const a of b.how_to_fix) expect(["proposed", "safeguard_proposed", "applied", "verified_for_tested_scenario", "failed_verification", "inconclusive"]).toContain(a.status);
  });

  it("instruction actions are never presented as enforcement", async () => {
    const b = await brief(LIVE_FINDING);
    const md = action(b, "claude_md_instruction");
    expect(md.enforces).toBe(false);
    expect(md.text).toMatch(/guidance only/);
  });

  it("redacts secrets copied from stored records", async () => {
    ctx.db.prepare("UPDATE runs SET task_description = ? WHERE id = (SELECT run_id FROM findings WHERE id = ?)").run(`Use key ${CANARY.anthropic} to deploy`, LIVE_FINDING);
    ctx.db.prepare("UPDATE findings SET title = ?, category = 'outcome_mismatch' WHERE id = ?").run(`Agent printed ${CANARY.openai} in its report`, LIVE_FINDING);
    const b = await brief(LIVE_FINDING);
    const json = JSON.stringify(b);
    expect(json).not.toContain(CANARY.anthropic);
    expect(json).not.toContain(CANARY.openai);
    expect(json).not.toContain("KWCANARY");
    const embedded = JSON.stringify((await detail(LIVE_FINDING)).brief);
    expect(embedded).not.toContain("KWCANARY");
  });

  it("returns 404 for an unknown finding", async () => {
    expect((await getJson(ctx.app, apiPaths.findingBrief("fnd_does_not_exist"))).status).toBe(404);
  });
});
