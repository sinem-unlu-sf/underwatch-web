/**
 * ADVERSARIAL REVIEW (ISSUE 3, independent reviewer). Demonstrates storage paths / formats where a synthetic canary
 * survives into SQLite or the API despite "redaction is the default". Synthetic KWCANARY values only.
 *
 * Each test asserts the SECURE outcome; they are marked `it.fails` so the suite stays green while the break is open.
 * When a break is fixed, vitest reports the `it.fails` as failing: flip it to `it`.
 */
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { API_ROUTES, apiPaths, type StartSupervisedRunResponse } from "@kw/schema";
import { getSupervisedService, type StoredCapture } from "../supervised";
import type { SupervisedExecutor } from "../supervised/runner";
import { persistRunBundle } from "../ingest/persist";
import { createTestApp, getJson, postJson, type TestContext } from "./helpers";
import { CANARY, findCanaryLeaks } from "./canaries";

const RECORDED = JSON.parse(readFileSync(new URL("./fixtures/supervised-capture-recorded.json", import.meta.url), "utf8")) as StoredCapture;
const allOk = async () => ["docker", "agent_image", "proxy_image", "claude_token", "broker_image"].map((id) => ({ id, ok: true, detail: "test" }));

let t: TestContext | null = null;
afterEach(async () => {
  await t?.close();
  t = null;
});

async function supervised(harnessOk: boolean) {
  t = await createTestApp();
  const executor: SupervisedExecutor = async () => structuredClone(RECORDED.capture);
  const canary = (file: string) => RECORDED.canaries.find((c) => c.file === file)?.value ?? `kw-synthetic-canary-test-${file.length}`;
  return getSupervisedService(t.app.kw, {
    executor,
    canary,
    checkHarness: harnessOk ? allOk : async () => [{ id: "docker", ok: false, detail: "Docker is not reachable (test)" }],
  });
}

const TASK = `Deploy using the key ${CANARY.anthropic} and tell me if it works`;

describe("ADVERSARIAL: supervised run task bypasses the storage-boundary redaction", () => {
  it("runs.task_description / label must not keep a canary from the user's task (full ingest path)", async () => {
    const svc = await supervised(true);
    const start = await postJson<StartSupervisedRunResponse>(t!.app, API_ROUTES.runs, { client_request_id: "adv-sr-0001", task: TASK });
    expect(start.status).toBe(202);
    await svc.wait(start.body.run.id);
    const row = t!.db.prepare("SELECT label, task_description FROM runs WHERE id = ?").get(start.body.run.id) as Record<string, string>;
    expect(findCanaryLeaks(JSON.stringify(row))).toEqual([]);
  });

  it("supervised_runs.task and GET /api/runs/:id must not return the canary", async () => {
    const svc = await supervised(false);
    const start = await postJson<StartSupervisedRunResponse>(t!.app, API_ROUTES.runs, { client_request_id: "adv-sr-0002", task: TASK });
    await svc.wait(start.body.run.id);
    const detail = await getJson(t!.app, apiPaths.run(start.body.run.id));
    expect(findCanaryLeaks(JSON.stringify(detail.body))).toEqual([]);
  });

  it("POST /api/runs response itself must not echo the canary", async () => {
    const svc = await supervised(false);
    const start = await postJson<StartSupervisedRunResponse>(t!.app, API_ROUTES.runs, { client_request_id: "adv-sr-0003", task: TASK });
    await svc.wait(start.body.run.id);
    expect(findCanaryLeaks(JSON.stringify(start.body))).toEqual([]);
  });
});

describe("ADVERSARIAL: contextual secrets the detectors miss (random-looking synthetic values)", () => {
  // Random-looking but synthetic; starts with a letter, alnum only (the shape the lower-case-key exemption skips).
  const RND = "KWCANARYq7Zr3Tn6Wy1Xv4Pm8Lk2Hs9Jd5Fb0Gc";
  const cases: Record<string, string> = {
    url_query_access_token: `curl 'https://api.example.test/v1/data?access_token=${RND}&x=1'`,
    npmrc_authToken: `//registry.npmjs.org/:_authToken=npm_${RND}`,
    cookie_session: `Cookie: session=${RND}`,
  };
  for (const [name, text] of Object.entries(cases)) {
    it(`persistRunBundle must redact ${name} in events.target_resource`, async () => {
      t = await createTestApp();
      const fx = JSON.parse(readFileSync(new URL("../../../../fixtures/runs/fx-04-env-read-via-bash.json", import.meta.url), "utf8"));
      fx.events[0].target_resource = text;
      fx.events[0].summary = `Bash requested: ${text}`;
      persistRunBundle(t.db, fx);
      const row = t.db.prepare("SELECT target_resource, summary FROM events WHERE id = ?").get(fx.events[0].id) as Record<string, string>;
      expect(JSON.stringify(row)).not.toContain(RND.slice(8));
    });
  }
});
