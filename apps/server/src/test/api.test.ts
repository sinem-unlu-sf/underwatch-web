import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  API_ROUTES,
  EventBasis,
  FindingStatus,
  apiPaths,
  fixtureRunId,
  type FindingDetailResponse,
  type OverviewResponse,
  type RunsResponse,
  type SafeguardsResponse,
  type SettingsStatusResponse,
} from "@kw/schema";
import { displayTime, overallStatus } from "../status";
import { importFixture } from "../ingest/fixtures";
import { persistRunBundle } from "../ingest/persist";
import { buildBundle, buildFixtureFile } from "./bundle";
import { createTestApp, getJson, postJson, tableCount, type TestContext } from "./helpers";

const FX = "fx-api";
const FX_RUN = fixtureRunId(FX);
const LIVE_RUN = "run_live_live_api";
const FX_NEW_FINDING = "fnd_fx_api_1";
const FX_CONFIRMED_FINDING = "fnd_fx_api_2";

let ctx: TestContext;

beforeEach(async () => {
  ctx = await createTestApp();
  const imported = importFixture(ctx.db, buildFixtureFile(FX));
  if (!imported.ok) throw new Error(imported.errors.join("\n"));
  persistRunBundle(ctx.db, buildBundle("live-api", false));
});
afterEach(() => ctx.close());

describe("health and errors", () => {
  it("reports health", async () => {
    const { status, body } = await getJson(ctx.app, apiPaths.health());
    expect(status).toBe(200);
    expect(body).toMatchObject({ status: "ok", service: "underwatch-api", database: { ok: true, driver: "node:sqlite" } });
  });

  it("uses the ApiError shape for unknown routes, unknown ids, and bad input", async () => {
    expect(await getJson(ctx.app, "/api/nope")).toMatchObject({ status: 404, body: { error: { code: "not_found" } } });
    expect(await getJson(ctx.app, apiPaths.run("run_missing"))).toMatchObject({ status: 404, body: { error: { code: "not_found" } } });
    expect(await getJson(ctx.app, apiPaths.evidence("evd_missing"))).toMatchObject({ status: 404 });
    const bad = await getJson(ctx.app, `${apiPaths.runs()}?limit=0&has_findings=yes`);
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe("validation_error");
    expect(bad.body.error.details.issues.map((i: { path: string }) => i.path).sort()).toEqual(["has_findings", "limit"]);
  });

  it("allows CORS only from the web dev origins", async () => {
    const ok = await ctx.app.inject({ method: "GET", url: apiPaths.health(), headers: { origin: "http://127.0.0.1:4601" } });
    expect(ok.headers["access-control-allow-origin"]).toBe("http://127.0.0.1:4601");
    const other = await ctx.app.inject({ method: "GET", url: apiPaths.health(), headers: { origin: "http://evil.example" } });
    expect(other.headers["access-control-allow-origin"]).toBeUndefined();
  });
});

describe("finding status changes", () => {
  it("persists an allowed transition and appends history", async () => {
    const before = await getJson<FindingDetailResponse>(ctx.app, apiPaths.finding(FX_NEW_FINDING));
    expect(before.body.finding.status).toBe("new");
    expect(before.body.allowed_transitions).toEqual(["under_review", "confirmed", "dismissed", "unresolved"]);

    const res = await postJson(ctx.app, apiPaths.findingStatus(FX_NEW_FINDING), { to: "under_review", note: "  looking  " });
    expect(res.status).toBe(200);
    expect(res.body.finding).toMatchObject({ id: FX_NEW_FINDING, status: "under_review", is_fixture: true });
    expect(res.body.status_change).toMatchObject({ from: "new", to: "under_review", actor_type: "user", actor: "developer", note: "looking" });
    expect(res.body.allowed_transitions).toEqual(["confirmed", "dismissed", "unresolved"]);

    const after = await getJson<FindingDetailResponse>(ctx.app, apiPaths.finding(FX_NEW_FINDING));
    expect(after.body.finding.status).toBe("under_review");
    expect(after.body.finding.updated_at).toBe(res.body.status_change.at);
    expect(after.body.status_history.map((h) => [h.from, h.to])).toEqual([
      [null, "new"],
      ["new", "under_review"],
    ]);

    const dismissed = await postJson(ctx.app, apiPaths.findingStatus(FX_NEW_FINDING), { to: "dismissed", note: "benign" });
    expect(dismissed.status).toBe(200);
    expect(tableCount(ctx.db, "finding_status_history")).toBe(3 + 3 + 2);
  });

  it("rejects a disallowed transition with 409 and changes nothing", async () => {
    const historyBefore = tableCount(ctx.db, "finding_status_history");
    const res = await postJson(ctx.app, apiPaths.findingStatus(FX_NEW_FINDING), { to: "resolved", note: "done" });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatchObject({ code: "invalid_transition", details: { from: "new", to: "resolved" } });
    const detail = await getJson<FindingDetailResponse>(ctx.app, apiPaths.finding(FX_NEW_FINDING));
    expect(detail.body.finding.status).toBe("new");
    expect(detail.body.finding.updated_at).toBe("2026-03-01T10:01:10.000Z");
    expect(tableCount(ctx.db, "finding_status_history")).toBe(historyBefore);
  });

  it("requires a note for dismissal (422) and validates the body (400)", async () => {
    const historyBefore = tableCount(ctx.db, "finding_status_history");
    const noNote = await postJson(ctx.app, apiPaths.findingStatus(FX_NEW_FINDING), { to: "dismissed", note: "   " });
    expect(noNote).toMatchObject({ status: 422, body: { error: { code: "note_required" } } });
    const badBody = await postJson(ctx.app, apiPaths.findingStatus(FX_NEW_FINDING), { to: "gone" });
    expect(badBody).toMatchObject({ status: 400, body: { error: { code: "validation_error" } } });
    const missing = await postJson(ctx.app, apiPaths.findingStatus("fnd_missing"), { to: "under_review" });
    expect(missing.status).toBe(404);
    expect(tableCount(ctx.db, "finding_status_history")).toBe(historyBefore);
  });
});

describe("overview", () => {
  it("computes every count from persisted rows with fixture/live breakdown", async () => {
    const { status, body } = await getJson<OverviewResponse>(ctx.app, apiPaths.overview());
    expect(status).toBe(200);
    const perRun = { runs: 1, events: 4, findings: 2, safeguards: 1, verification_runs: 1 };
    expect(body.breakdown).toEqual({ fixture: perRun, live: perRun });
    expect(body.totals).toEqual({ runs: 2, events: 8, findings: 4, safeguards: 2, verification_runs: 2 });
    expect(body.data_mode).toEqual({ fixture_runs: 1, live_runs: 1, contains_fixture_data: true });
    expect(body.recent_runs.count).toBe(2);
    expect(body.runs_needing_review.count).toBe(2);
    expect(body.runs_needing_review.items[0]).toMatchObject({ open_finding_count: 1, max_open_severity: "high", event_count: 4, finding_count: 2 });
    expect(body.new_findings.count).toBe(2);
    expect(body.confirmed_findings.count).toBe(2);
    expect(body.safeguards_awaiting_approval.count).toBe(2);
    expect(body.recent_verification_results.count).toBe(2);
    expect(body.recent_verification_results.items[0]?.safeguard_title).toBe("Deny .env reads");
    // Not-implemented collectors are listed per component but do not drive the summary (browser check: it read as if
    // nothing is observed). In the test env Neo4j and ai& are not configured, so the summary is "not_configured".
    expect(body.observation_health.overall).toBe("not_configured");
    expect(body.observation_health.components.some((c) => c.status === "not_implemented")).toBe(true);
    // FR10 read guard (PRD-COVERAGE 4a #6): the bundle's legacy "verified" run has no independently observed task
    // success, so it is served as inconclusive here exactly as on the detail endpoint; nothing stale shows as passed.
    for (const v of body.recent_verification_results.items) expect(v.result).not.toBe("verified_for_tested_scenario");
    expect(body.recent_verification_results.items[0]?.result).toBe("verification_inconclusive");
    expect(body.observation_health.components.find((c) => c.id === "claude-code")?.status).toBe("configured");

    await postJson(ctx.app, apiPaths.findingStatus(FX_NEW_FINDING), { to: "confirmed" });
    const after = await getJson<OverviewResponse>(ctx.app, apiPaths.overview());
    expect(after.body.new_findings.count).toBe(1);
    expect(after.body.confirmed_findings.count).toBe(3);
    expect(after.body.confirmed_findings.items[0]?.id).toBe(FX_NEW_FINDING);
    expect(after.body.runs_needing_review.count).toBe(1);
  });

  it("is all zeros on an empty database", async () => {
    const empty = await createTestApp();
    try {
      const { body } = await getJson<OverviewResponse>(empty.app, apiPaths.overview());
      expect(body.totals).toEqual({ runs: 0, events: 0, findings: 0, safeguards: 0, verification_runs: 0 });
      expect(body.data_mode).toEqual({ fixture_runs: 0, live_runs: 0, contains_fixture_data: false });
      expect(body.recent_runs).toEqual({ count: 0, items: [] });
    } finally {
      await empty.close();
    }
  });
});

describe("is_fixture propagation and filters", () => {
  it("keeps is_fixture on every record of a fixture run and separates live data", async () => {
    const only = await getJson<RunsResponse>(ctx.app, `${apiPaths.runs()}?fixture=only`);
    expect(only.body.items.map((r) => [r.id, r.is_fixture])).toEqual([[FX_RUN, true]]);
    const live = await getJson<RunsResponse>(ctx.app, `${apiPaths.runs()}?fixture=exclude`);
    expect(live.body.items.map((r) => [r.id, r.is_fixture])).toEqual([[LIVE_RUN, false]]);

    const events = await getJson(ctx.app, apiPaths.runEvents(FX_RUN));
    expect(events.body.items.every((e: { is_fixture: boolean }) => e.is_fixture)).toBe(true);
    expect(events.body.correlations[0].is_fixture).toBe(true);

    const detail = await getJson<FindingDetailResponse>(ctx.app, apiPaths.finding(FX_NEW_FINDING));
    const records = [detail.body.finding, detail.body.run, detail.body.policy!, ...detail.body.related_events, ...detail.body.evidence, ...detail.body.status_history, ...detail.body.safeguards];
    expect(records.every((r) => r.is_fixture === true)).toBe(true);

    const run = await getJson(ctx.app, apiPaths.run(FX_RUN));
    expect(run.body.coverage.is_fixture).toBe(true);
    const findings = await getJson(ctx.app, `${apiPaths.findings()}?fixture=exclude`);
    expect(findings.body.items.every((f: { is_fixture: boolean }) => !f.is_fixture)).toBe(true);
    const safeguards = await getJson(ctx.app, `${apiPaths.safeguards()}?fixture=only`);
    expect(safeguards.body.items.map((s: { is_fixture: boolean; last_verification: { is_fixture: boolean } }) => [s.is_fixture, s.last_verification.is_fixture])).toEqual([[true, true]]);
  });

  it("filters runs by text, status, dates, and findings", async () => {
    const q = (s: string) => getJson<RunsResponse>(ctx.app, `${apiPaths.runs()}?${s}`);
    expect((await q("q=FX-API")).body.items.map((r) => r.id)).toEqual([FX_RUN]);
    expect((await q("q=100%25")).body.total).toBe(0);
    expect((await q("status=failed")).body.total).toBe(0);
    expect((await q("from=2026-03-01T10:00:00Z&to=2026-03-01T10:00:00%2B00:00")).body.total).toBe(2);
    expect((await q("from=2026-03-01T11:00:00%2B01:00")).body.total).toBe(2);
    expect((await q("from=2026-03-01T10:00:01Z")).body.total).toBe(0);
    expect((await q("has_findings=false")).body.total).toBe(0);
    const page = await q("limit=1&offset=1");
    expect(page.body).toMatchObject({ total: 2 });
    expect(page.body.items).toHaveLength(1);
  });
});

describe("run, event, finding, safeguard, evidence, settings endpoints", () => {
  it("returns run detail with complete count records", async () => {
    const { body } = await getJson(ctx.app, apiPaths.run(FX_RUN));
    expect(Object.keys(body.counts.events_by_basis).sort()).toEqual([...EventBasis.options].sort());
    expect(Object.keys(body.counts.findings_by_status).sort()).toEqual([...FindingStatus.options].sort());
    expect(body.counts).toMatchObject({ events: 4, evidence: 2, findings: 2, open_findings: 1, events_by_basis: { reported: 2, observed: 2, derived: 0 } });
    expect(body.policy.id).toBe("pol_fx_api");
  });

  it("orders and filters run events", async () => {
    const all = await getJson(ctx.app, apiPaths.runEvents(FX_RUN));
    expect(all.body.items.map((e: { source_sequence: number }) => e.source_sequence)).toEqual([1, 2, 3, 4]);
    const observed = await getJson(ctx.app, `${apiPaths.runEvents(FX_RUN)}?basis=observed`);
    expect(observed.body.total).toBe(2);
    const forFinding = await getJson(ctx.app, `${apiPaths.runEvents(FX_RUN)}?finding_id=${FX_CONFIRMED_FINDING}`);
    expect(forFinding.body.items.map((e: { source_sequence: number }) => e.source_sequence)).toEqual([1, 2]);
    expect((await getJson(ctx.app, `${apiPaths.runEvents(FX_RUN)}?finding_id=bad`)).status).toBe(400);
  });

  it("returns finding detail with evidence union, policy, safeguards, and pending AI status", async () => {
    const { body } = await getJson<FindingDetailResponse>(ctx.app, apiPaths.finding(FX_CONFIRMED_FINDING));
    expect(body.related_events).toHaveLength(2);
    expect(body.evidence.map((e) => e.id)).toEqual(["evd_fx_api_1"]);
    expect(body.policy?.id).toBe("pol_fx_api");
    expect(body.ai_explanation.status).toBe("not_implemented");
    const runFindings = await getJson(ctx.app, apiPaths.runFindings(FX_RUN));
    expect(runFindings.body.items.map((f: { severity: string }) => f.severity)).toEqual(["high", "medium"]);
    expect(runFindings.body.items[0].run_label).toBe("Test run fx-api");
  });

  it("lists safeguards and resolves evidence references", async () => {
    const sg = await getJson(ctx.app, `${apiPaths.safeguards()}?approval_status=proposed&finding_id=${FX_NEW_FINDING}`);
    expect(sg.body.total).toBe(1);
    expect(sg.body.items[0]).toMatchObject({ finding_title: "Unreported .env open", finding_status: "new", run_id: FX_RUN });
    const ev = await getJson(ctx.app, apiPaths.evidence("evd_fx_api_2"));
    expect(ev.body.referenced_by_finding_ids).toEqual([FX_NEW_FINDING]);
    expect(ev.body.referenced_by_event_ids).toHaveLength(1);
  });

  it("reports settings honestly and never echoes secret values", async () => {
    const plain = await getJson<SettingsStatusResponse>(ctx.app, apiPaths.settingsStatus());
    expect(plain.body.adapter.status).toBe("configured");
    expect(plain.body.collectors.length).toBeGreaterThan(0);
    // Only the observers actually wired into the Docker harness are "configured"; the rest stay not_implemented.
    expect(plain.body.collectors.filter((c) => c.status === "configured").map((c) => c.id).sort()).toEqual(["git_observer", "kernel_tracer", "network_proxy"]);
    expect(plain.body.collectors.filter((c) => c.status !== "configured").every((c) => c.status === "not_implemented")).toBe(true);
    expect(plain.body.ai_inference).toMatchObject({ status: "not_configured", configured_via: null });
    expect(plain.body.neo4j).toMatchObject({ status: "not_configured", configured_via: null });
    expect(plain.body.policy.active_policy_version_id).toBe("pol_live_api");
    // 4a #12: Settings names the built-in supervised policy; kernel tracer text reflects attachment to supervised runs.
    expect(plain.body.policy.detail).toMatch(/Underwatch supervised policy/);
    expect(plain.body.policy.detail).not.toMatch(/no policy is active/);
    const kernel = plain.body.collectors.find((c) => c.id === "kernel_tracer")!;
    expect(kernel.detail).toMatch(/Attached to supervised runs/);
    expect(kernel.detail).not.toMatch(/not attached to supervised runs/);
    expect(plain.body.data_mode.contains_fixture_data).toBe(true);

    const secret = "sk-super-secret-value-123";
    const configured = await createTestApp({ AIAND_API_KEY: secret, NEO4J_URI: "neo4j+s://user:pw@host" });
    try {
      const res = await configured.app.inject({ method: "GET", url: API_ROUTES.settingsStatus });
      expect(res.body).not.toContain(secret);
      expect(res.body).not.toContain("user:pw");
      const body = res.json() as SettingsStatusResponse;
      // Tests inject no provider (NullProvider): a key in the env alone does not make ai& active.
      expect(body.ai_inference).toMatchObject({ status: "disabled", configured_via: "AIAND_API_KEY" });
      // No KwGraph is injected in tests: the graph runtime reports not_configured (never the URI or its credentials).
      expect(body.neo4j).toMatchObject({ status: "not_configured", configured_via: null });
    } finally {
      await configured.close();
    }
  });
});

describe("verification read guards on lists (PRD-COVERAGE 4a #6)", () => {
  it("serves a stale legacy pass as inconclusive in the safeguard list, last_verification and finding detail", async () => {
    const list = await getJson<SafeguardsResponse>(ctx.app, apiPaths.safeguards());
    expect(list.status).toBe(200);
    expect(list.body.items.length).toBeGreaterThan(0);
    for (const sg of list.body.items) {
      expect(sg.verification_status).toBe("verification_inconclusive");
      expect(sg.last_verification?.result).toBe("verification_inconclusive");
    }
    const stored = ctx.db.prepare("SELECT COUNT(*) AS n FROM safeguards WHERE verification_status = 'verified_for_tested_scenario'").get() as { n: number };
    expect(Number(stored.n)).toBe(2); // stored rows are not modified
    const detail = await getJson<FindingDetailResponse>(ctx.app, apiPaths.finding(FX_NEW_FINDING));
    for (const sg of detail.body.safeguards) expect(sg.verification_status).not.toBe("verified_for_tested_scenario");
  });
});

describe("overallStatus", () => {
  it("ignores not-implemented components unless every component is not implemented", () => {
    expect(overallStatus(["configured", "not_implemented", "connected"])).toBe("configured");
    expect(overallStatus(["connected", "not_implemented", "degraded"])).toBe("degraded");
    expect(overallStatus(["not_implemented", "not_implemented"])).toBe("not_implemented");
  });

  it("formats status-detail timestamps in JST like the UI", () => {
    expect(displayTime("2026-10-17T03:31:01.000Z")).toBe("2026-10-17 12:31:01 JST");
    expect(displayTime("not a date")).toBe("not a date");
  });
});
