/**
 * LIVE integration test: real Docker Desktop + Tetragon. Opt-in because it loads VM-wide observation policies and a
 * scoped enforcement policy on a Docker daemon other work may share:
 *
 *   KW_TETRAGON_LIVE=1 pnpm --filter @kw/observer-tetragon test:live
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { Event } from "@kw/schema";
import { docker } from "./docker";
import { ensureTetragon, health } from "./lifecycle";
import { applyEnforcement, loadObservationPolicies, removeEnforcement } from "./policies";
import { attach, type CaptureResult } from "./capture";
import { buildProcessTable, findToolShell } from "./parser";
import { readRunEvents } from "./collector";
import { sha256 } from "./policies";

const IMAGE = "node:22-bookworm"; // node + bash + python3: node -> bash -> cat mirrors an agent's Bash tool call
const ts = Date.now().toString(36);
const RUN = `run_live_tetragon_${ts}`;
const A = `kw-tt-live-a-${ts}`;
const B = `kw-tt-live-b-${ts}`;
const POLICY = `kw-enf-live-${ts}`;
const C = `kw-tt-live-sock-${ts}`;
const CANARY = "/kw-canary/secret.txt";
const TOOL_CMD = `cat ${CANARY}; python3 -c "import socket;s=socket.socket();s.settimeout(1);print('connect_ex', s.connect_ex(('192.0.2.1',443)))"; sh -c 'echo child-sh'`;
const MAIN = `mkdir -p /kw-canary && echo KW_SYNTHETIC_CANARY_LIVE_0001 > ${CANARY}
node -e 'require("child_process").execFileSync("/bin/bash",["-c",process.env.TOOL_CMD],{stdio:"inherit"})'
echo phase1-done
sleep 600`;

let skipReason: string | null = null;
if (process.env.KW_TETRAGON_LIVE !== "1") skipReason = "set KW_TETRAGON_LIVE=1 to run the live Tetragon test";
else {
  try {
    execFileSync("docker", ["version", "--format", "{{.Server.Version}}"], { stdio: "pipe", timeout: 15000 });
    execFileSync("docker", ["image", "inspect", IMAGE], { stdio: "pipe", timeout: 15000 });
  } catch {
    skipReason = `Docker not reachable or image ${IMAGE} missing - live Tetragon test skipped`;
  }
}
if (skipReason) console.warn(`[observer-tetragon live] SKIPPED: ${skipReason}`);

const sh = (args: string[]) => docker(args, { timeoutMs: 60_000 });
const m: Record<string, unknown> = {};

describe.skipIf(skipReason !== null)("live: Tetragon capture + scoped enforcement", () => {
  let result: CaptureResult;
  let blockedExec: { code: number; out: string };
  let pyErrno: string;
  let otherContainer: { code: number; out: string };
  let afterRemove: { code: number; out: string };
  let enforcementHash = "";
  let hardlinkProbe = "";
  let metricsFromAgent: { code: number; out: string };
  let attachRefusal = "";

  beforeAll(async () => {
    let t = Date.now();
    const h = await ensureTetragon();
    m.ensure_ms = Date.now() - t;
    if (!h.tetragon_healthy) throw new Error(`tetragon unhealthy: ${h.errors.join("; ")}`);
    t = Date.now();
    m.observation_policies = await loadObservationPolicies();
    m.load_policies_ms = Date.now() - t;

    // kw-tetragon has --network none: a sibling container must not reach its metrics (old shape published 29112).
    const mr = await sh(["run", "--rm", "--label", "kw-dev=1", "alpine:3", "sh", "-c", "wget -qO- -T 3 http://host.docker.internal:29112/metrics | head -c 200; echo rc=$?"]);
    metricsFromAgent = { code: mr.code, out: mr.stdout.trim() };
    // attach() refuses a container that could tamper with the observer (docker socket mounted).
    await sh(["create", "--label", "kw-dev=1", "--name", C, "-v", "/var/run/docker.sock:/var/run/docker.sock", "alpine:3", "true"]);
    attachRefusal = await attach({ runId: `${RUN}_sock`, containerId: C }).then(
      async (c) => {
        await c.stop({ settleMs: 0 });
        return "ATTACHED";
      },
      (e: unknown) => String(e),
    );

    // Paused start: create -> attach -> start, so the container's very first exec is captured.
    const created = await sh(["create", "--label", "kw-dev=1", "--name", A, "-e", `TOOL_CMD=${TOOL_CMD}`, IMAGE, "bash", "-c", MAIN]);
    if (created.code !== 0) throw new Error(created.stderr);
    const cap = await attach({ runId: RUN, containerId: A, backfill: false });
    await sh(["start", A]);
    for (let i = 0; i < 60; i++) {
      if ((await sh(["logs", A])).stdout.includes("phase1-done")) break;
      await new Promise((r) => setTimeout(r, 250));
    }
    m.container_logs = (await sh(["logs", A])).stdout.trim();

    t = Date.now();
    const enf = await applyEnforcement({ scopeContainerId: A, paths: [CANARY], policyName: POLICY });
    m.apply_enforcement_ms = Date.now() - t;
    m.enforcement = { name: enf.policyName, hash: enf.policyHash, loaded: enf.loaded, mode: enf.mode, pidns: enf.pidnsInode };
    enforcementHash = enf.policyHash;
    if (!enf.loaded) throw new Error("enforcement policy not loaded");

    // Same agent-like lineage (node -> bash -> cat) inside A, now under enforcement.
    const r1 = await sh(["exec", A, "node", "-e", `try{require("child_process").execFileSync("/bin/bash",["-c","cat ${CANARY}"],{stdio:"pipe"});console.log("READ-OK")}catch(e){console.log("EXIT",e.status,String(e.stderr).trim())}`]);
    blockedExec = { code: r1.code, out: r1.stdout.trim() };
    const r2 = await sh(["exec", A, "python3", "-c", `import errno\ntry:\n  open("${CANARY}").read(); print("READ-OK")\nexcept OSError as e: print(errno.errorcode[e.errno])`]);
    pyErrno = r2.stdout.trim();
    // A DIFFERENT container with the same path must not be affected by A's scoped policy.
    const r3 = await sh(["run", "--rm", "--label", "kw-dev=1", "--name", B, "alpine:3", "sh", "-c", `mkdir -p /kw-canary; echo other > ${CANARY}; cat ${CANARY}`]);
    otherContainer = { code: r3.code, out: r3.stdout.trim() };
    // Known limitation probe: exact-path deny is path-based; a hard link created by root gives a second path.
    const r5 = await sh(["exec", A, "sh", "-c", `ln ${CANARY} /tmp/kw-hl 2>&1; cat /tmp/kw-hl 2>&1; echo hardlink_rc=$?; rm -f /tmp/kw-hl; mv /kw-canary /kw-moved 2>&1; cat /kw-moved/secret.txt 2>&1; echo rename_rc=$?; mv /kw-moved /kw-canary 2>/dev/null; true`]);
    hardlinkProbe = r5.stdout.trim();
    m.hardlink_probe = hardlinkProbe;

    t = Date.now();
    m.remove = await removeEnforcement(POLICY);
    m.remove_enforcement_ms = Date.now() - t;
    const r4 = await sh(["exec", A, "cat", CANARY]);
    afterRemove = { code: r4.code, out: r4.stdout.trim() };

    t = Date.now();
    result = await cap.stop({ settleMs: 2000 });
    m.stop_ms = Date.now() - t;
  }, 240_000);

  afterAll(async () => {
    await removeEnforcement(POLICY).catch(() => undefined);
    await sh(["rm", "-f", A, B, C]);
    const h = await health();
    m.policies_after = h.policies_loaded.map((p) => `${p.name}:${p.mode}`);
    m.health = { kernel: h.kernel_version, btf: h.btf_present, lsm: h.bpf_lsm_supported, version: h.tetragon_server_version };
    if (result) {
      m.stats = result.stats;
      m.slice = { file: result.sliceFile, sha256: result.sha256, bytes: result.sizeBytes };
    }
    console.log("[observer-tetragon live] MEASURED " + JSON.stringify(m, null, 2));
  });

  it("enforcement returned EPERM inside the scoped container (node->bash->cat and python)", () => {
    expect(blockedExec.out).toMatch(/^EXIT 1 .*Operation not permitted/);
    expect(pyErrno).toBe("EPERM");
  });

  it("observer is not reachable from an agent container, and attach refuses a docker.sock container", () => {
    expect(metricsFromAgent.out).not.toContain("tetragon_");
    expect(attachRefusal).toMatch(/refusing to attach: .*docker socket/);
    expect(result.stats.kernel_loss).not.toBeNull(); // metrics still readable via docker exec
    expect(result.stats.isolation_violations).toEqual([]);
  });

  it("rename/hard-link of the protected path is denied too (open-time deny is path based)", () => {
    expect(hardlinkProbe).toMatch(/hardlink_rc=1/);
    expect(hardlinkProbe).toMatch(/rename_rc=[1-9]/);
    expect(hardlinkProbe).not.toContain("KW_SYNTHETIC_CANARY_LIVE_0001");
    const guard = result.events.filter((e) => (e.kw_type === "file.rename" || e.kw_type === "file.link") && e.outcome === "blocked");
    expect(guard.some((e) => e.kw_type === "file.rename" && e.target_resource === "/kw-canary")).toBe(true);
    expect(guard.some((e) => e.kw_type === "file.link")).toBe(true);
    for (const e of guard) expect(e.tetragon.enforcement?.policy_name).toBe(POLICY);
  });

  it("a different container reading the same path was NOT affected", () => {
    expect(otherContainer).toEqual({ code: 0, out: "other" });
  });

  it("after removeEnforcement the read works again", () => {
    expect(m.remove).toEqual({ removed: true, stillLoaded: false });
    expect(afterRemove).toEqual({ code: 0, out: "KW_SYNTHETIC_CANARY_LIVE_0001" });
  });

  it("slice is attributed to container A only, hashed, and schema-valid", () => {
    expect(result.stats.matched_records).toBeGreaterThan(0);
    expect(sha256(readFileSync(result.sliceFile))).toBe(result.sha256);
    expect(result.events.every((e) => e.kw_type === "raw" || result.stats.container_id.startsWith(e.tetragon.process.docker!))).toBe(true);
    expect(result.events.some((e) => e.process_name === "/bin/cat" && e.tetragon.process.args === `${CANARY}` && e.tetragon.parent?.args?.includes("other"))).toBe(false);
    for (const e of result.events) Event.parse(e);
  });

  it("captures exec lineage node -> bash -> cat/python3/sh and attributes to the tool shell", () => {
    const ex = result.events.filter((e) => e.kw_type === "process.exec");
    const table = buildProcessTable(result.events);
    const cat = ex.find((e) => e.process_name === "/usr/bin/cat" && e.tetragon.ancestry.some((a) => a.binary === "/usr/local/bin/node"))!;
    expect(cat).toBeTruthy();
    expect(cat.tetragon.ancestry.map((a) => a.binary).slice(0, 2)).toEqual(["/bin/bash", "/usr/local/bin/node"]);
    const py = ex.find((e) => /python3/.test(e.process_name ?? ""));
    expect(py?.tetragon.ancestry[0]?.binary).toBe("/bin/bash");
    expect(ex.some((e) => /\/(dash|sh)$/.test(e.process_name ?? "") && e.tetragon.ancestry[0]?.binary === "/bin/bash")).toBe(true);
    const shell = findToolShell(table, cat.tetragon.process.exec_id);
    expect(shell?.binary).toBe("/bin/bash");
    expect(shell?.args).toContain("cat /kw-canary/secret.txt");
  });

  it("file events: canary open succeeded before enforcement, blocked (with policy record) under it", () => {
    const opens = result.events.filter((e) => e.kw_type === "file.open" && e.target_resource === CANARY);
    expect(opens.some((e) => e.outcome === "succeeded" && e.process_name === "/usr/bin/cat")).toBe(true);
    const blocked = result.events.filter((e) => e.outcome === "blocked");
    expect(blocked.length).toBeGreaterThanOrEqual(2); // cat + python3
    for (const b of blocked) {
      expect(b.tetragon.enforcement).toMatchObject({ policy_name: POLICY, policy_sha256: enforcementHash, errno: "EPERM" });
    }
    expect(blocked.some((b) => b.process_name === "/usr/bin/cat")).toBe(true);
    expect(blocked.some((b) => /python3/.test(b.process_name ?? ""))).toBe(true);
    expect(result.events.some((e) => e.kw_type === "file.read" && e.target_resource === CANARY && e.outcome === "allowed")).toBe(true);
  });

  it("network: tcp connect attempt to 192.0.2.1:443 recorded as attempted (not as transfer)", () => {
    const net = result.events.filter((e) => e.kw_type === "net.connect" && e.target_resource === "192.0.2.1:443");
    expect(net.length).toBeGreaterThanOrEqual(1);
    expect(net[0]!.outcome).toBe("attempted");
    expect(net[0]!.tetragon.ancestry[0]?.binary).toBe("/bin/bash");
  });

  it("re-reading the slice from disk is idempotent and integrity-checked", async () => {
    const again = await readRunEvents(RUN);
    expect(again.integrityOk).toBe(true);
    expect(again.events.map((e) => e.id)).toEqual(result.events.map((e) => e.id));
  });

  it("coverage fragment states what is and is not established", () => {
    expect(result.coverage.report.network_outcomes_observable).toBe(false);
    expect(result.coverage.attribution.available).toBe(true);
    expect(result.coverage.not_established).toContain("content actually read from a file");
  });
});
