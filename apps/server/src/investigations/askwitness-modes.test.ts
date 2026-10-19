/**
 * Addendum C (judge feedback) extensions to finding-scope Ask Witness: concise by default, depth/style on request,
 * recorded action status in the prompt, and app-side flags for unconfirmed action claims. Fake ai& transport only.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { AiAndProvider, type HttpRequest, type HttpResponse, type HttpTransport } from "@kw/inference";
import { apiPaths } from "@kw/schema";
import { afterEach, describe, expect, it } from "vitest";
import { importFixture } from "../ingest/fixtures";
import { createTestApp, getJson, postJson, type TestContext } from "../test/helpers";

const TEST_KEY = "sk-kwtest-askwitness-modes-000000000000000000000";
const FX_DIR = path.resolve(import.meta.dirname, "../../../../fixtures/runs");
const FX04 = "fnd_fx04_env_read_via_bash";

const loadFixture = (name: string): any => JSON.parse(readFileSync(path.join(FX_DIR, `${name}.json`), "utf8"));

function completion(content: unknown): HttpResponse {
  return {
    status: 200,
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ choices: [{ index: 0, message: { role: "assistant", content: JSON.stringify(content) }, finish_reason: "stop" }] }),
  };
}

function modelAnswer(over: Record<string, unknown> = {}) {
  return {
    summary: "The agent read .env through Bash although the policy denies it.",
    verified_facts: [],
    hypotheses: [],
    unknowns: [],
    evidence_references: [],
    recommended_next_steps: ["Add a hook that blocks shell reads of .env."],
    recommended_safeguards: [],
    insufficient_evidence: false,
    ...over,
  };
}

let ctx: TestContext | null = null;
afterEach(async () => {
  await ctx?.close();
  ctx = null;
});

async function setup(reply: (req: HttpRequest) => HttpResponse) {
  const requests: HttpRequest[] = [];
  const transport: HttpTransport = async (req) => (requests.push(req), reply(req));
  const inference = new AiAndProvider({ apiKey: TEST_KEY, maxRetries: 1, baseBackoffMs: 1, timeoutMs: 2_000, maxRetryWaitMs: 5 }, { transport, sleep: async () => {} });
  ctx = await createTestApp({}, { inference });
  expect(importFixture(ctx.db, loadFixture("fx-04-env-read-via-bash")).ok).toBe(true);
  return { c: ctx, requests };
}

const messages = (req: HttpRequest) => (JSON.parse(req.body!) as { messages: Array<{ role: string; content: string }> }).messages;
const system = (req: HttpRequest) => messages(req).find((m) => m.role === "system")!.content;
const user = (req: HttpRequest) => messages(req).find((m) => m.role === "user")!.content;
const ask = (c: TestContext, body: Record<string, unknown>) => postJson(c.app, apiPaths.findingInvestigations(FX04), body);

describe("Ask Witness answer modes (Addendum C)", () => {
  it("concise by default; More detail / Explain simply follow-ups carry their flags into the prompt in the same investigation", async () => {
    const { c, requests } = await setup(() => completion(modelAnswer()));
    const r1 = await ask(c, { question: "Why is this a problem?", client_request_id: "req-modes-0001" });
    expect(r1.status).toBe(200);
    expect(r1.body.turn.prompt_version).toBe("kw.ask-witness@4");
    expect(r1.body.turn).toMatchObject({ depth: "concise", style: "standard" });
    expect(system(requests[0]!)).toContain("Answer depth: CONCISE");
    expect(user(requests[0]!)).toContain("depth=concise, style=standard");

    const inv = r1.body.investigation.id;
    const r2 = await ask(c, { question: "More detail on: Why is this a problem?", client_request_id: "req-modes-0002", investigation_id: inv, depth: "detailed" });
    const r3 = await ask(c, { question: "Explain simply: Why is this a problem?", client_request_id: "req-modes-0003", investigation_id: inv, style: "simple" });
    expect([r2.status, r3.status]).toEqual([200, 200]);
    expect(r2.body.investigation.id).toBe(inv);
    expect(r3.body.investigation.id).toBe(inv);
    expect(system(requests[1]!)).toContain("Answer depth: DETAILED");
    expect(system(requests[2]!)).toContain("Style: SIMPLE");
    expect(user(requests[2]!)).toContain("<<<KW_PRIOR_TURNS_BEGIN");

    // depth/style survive a reload (stored with the turn metadata, no new column)
    const detail = await getJson(c.app, apiPaths.investigation(inv));
    expect(detail.body.turns.map((t: any) => [t.depth, t.style])).toEqual([
      ["concise", "standard"],
      ["detailed", "standard"],
      ["concise", "simple"],
    ]);

    // idempotency: same key with a different mode is a different request
    const conflict = await ask(c, { question: "Why is this a problem?", client_request_id: "req-modes-0001", style: "simple" });
    expect(conflict.status).toBe(409);
    expect((await ask(c, { question: "q?", client_request_id: "req-modes-0009", depth: "huge" })).status).toBe(400);
  });

  it("the prompt carries the recorded action status, and verification claims without a matching record are flagged", async () => {
    const { c, requests } = await setup(() =>
      completion(
        modelAnswer({
          summary: "The read was not blocked. The deny-read safeguard has been verified and now blocks the read.",
          hypotheses: [{ text: "The fix has been applied to the agent settings.", evidence_ids: [] }],
          recommended_next_steps: ["Apply the safeguard, then run a verification to confirm it works."],
        }),
      ),
    );
    const r = await ask(c, { question: "How can I verify that the fix works?", client_request_id: "req-modes-0101" });
    expect(r.status).toBe(200);
    const u = user(requests[0]!);
    expect(u).toContain("<<<KW_RECORD_STATUS_BEGIN");
    expect(u).toContain('"verified":"no record"');
    expect(system(requests[0]!)).toContain("Never say that an action was performed");
    // the finding's deterministic brief (same records) is included as a non-citable block with its action statuses
    expect(u).toContain("<<<KW_FINDING_BRIEF_BEGIN");
    const brief = (await getJson(c.app, apiPaths.finding(FX04))).body.brief;
    expect(brief).toBeTruthy();
    {
      expect(u).toContain(JSON.stringify(brief.problem).slice(1, 40));
      expect(u).toContain(`"status":"${brief.how_to_fix[0].status}"`);
    }

    const a = r.body.turn.answer;
    expect(a.action_claim_flags.map((f: any) => [f.location, f.claim])).toEqual([
      ["summary", "verified"],
      ["hypothesis", "applied"],
    ]);
    expect(a.evidence_limitations.some((l: string) => /no Underwatch record in the evidence sent confirms it/.test(l))).toBe(true);
    // proposals in next steps are never flagged; the citation check is unchanged
    expect(a.recommended_next_steps).toEqual(["Apply the safeguard, then run a verification to confirm it works."]);
    expect(a.evidence_check).toMatchObject({ cited: 0, invalid: 0 });
  });
});
