import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Event, EVENT_ID_PATTERN } from "@kw/schema";
import {
  buildProcessTable,
  containerIdMatches,
  findToolShell,
  normalizeSlice,
  parseTetragonRecord,
  recordDocker,
} from "./parser";
import { renameGuardPaths, renderDenyFileOpen } from "./policies";
import { coverageFragment } from "./coverage";
import { isLossy, LOSS_METRICS } from "./metrics";
import { isolationViolations } from "./docker";

const FX = join(import.meta.dirname, "__fixtures__");
const fx = (f: string) => JSON.parse(readFileSync(join(FX, f), "utf8"));
const RUN = "run_fixture_tetragon";
const LIVE_CID = readFileSync(join(FX, "live-alpine-enforced.jsonl"), "utf8").match(/"docker":"([0-9a-f]{31})"/)![1]!;
const liveLines = readFileSync(join(FX, "live-alpine-enforced.jsonl"), "utf8").split("\n");
// The live fixture was captured with an ad-hoc policy name; register it the way applyEnforcement would.
const REG = { "kw-enf-manual": { policy_sha256: "a".repeat(64) } };

describe("containerIdMatches (Tetragon truncates ids to 31 hex chars)", () => {
  const full = "19f40c4a6ef2b24b71cff0f91e3d4381eea5b6d4acfadca6bd77704eab346bc1";
  it("matches the truncated prefix against the full id and vice versa", () => {
    expect(containerIdMatches("19f40c4a6ef2b24b71cff0f91e3d438", full)).toBe(true);
    expect(containerIdMatches("19f40c4a6ef2b24b71cff0f91e3d438", "19f40c4a6ef2")).toBe(true);
  });
  it("rejects other containers, empty and too-short ids", () => {
    expect(containerIdMatches("864fea5e5dc0f3b3643e8c840e5c25d", full)).toBe(false);
    expect(containerIdMatches(null, full)).toBe(false);
    expect(containerIdMatches("19f40c4a", full)).toBe(false);
  });
});

describe("parseTetragonRecord on spike samples", () => {
  it("process_exec (curl) -> process.exec with lineage, args, cwd, uid", () => {
    const e = parseTetragonRecord(fx("spike-example-process_exec-curl.json"), { runId: RUN }, 1);
    expect(Event.parse(e)).toBeTruthy();
    expect(e.id).toMatch(EVENT_ID_PATTERN);
    expect(e.basis).toBe("observed");
    expect(e.observer).toBe("tetragon");
    expect(e.kw_type).toBe("process.exec");
    expect(e.event_type).toBe("process_exec");
    expect(e.process_id).toBe(8162);
    expect(e.parent_process_id).toBe(8161);
    expect(e.process_name).toBe("/usr/bin/curl");
    expect(e.tetragon.process.exec_id).toBe("NmU3MGU2YzIzNWE1OjU1ODE4OTc2NTEzMTo4MTYy");
    expect(e.tetragon.process.parent_exec_id).toBe("NmU3MGU2YzIzNWE1OjU1ODE4OTIxMTc1Njo4MTYx");
    expect(e.tetragon.process.cwd).toBe("/tmp/w");
    expect(e.tetragon.process.uid).toBe(0);
    expect(e.tetragon.process.args).toContain("https://example.com");
    expect(e.tetragon.process.docker).toBe("864fea5e5dc0f3b3643e8c840e5c25d");
  });

  it("security_file_permission MAY_READ -> file.read 'allowed' (never 'content read')", () => {
    const e = parseTetragonRecord(fx("spike-example-process_kprobe-file-permission.json"), { runId: RUN }, 1);
    expect(Event.parse(e)).toBeTruthy();
    expect(e.kw_type).toBe("file.read");
    expect(e.target_resource).toBe("/tmp/w/.env");
    expect(e.outcome).toBe("allowed");
    expect(e.tetragon.file?.mask).toBe(4);
    expect(e.limitations.join(" ")).toMatch(/does not establish bytes read/);
  });

  it("tcp_connect -> net.connect 'attempted' with daddr/dport; transfer not claimed", () => {
    const e = parseTetragonRecord(fx("spike-example-process_kprobe-tcp_connect.json"), { runId: RUN }, 1);
    expect(Event.parse(e)).toBeTruthy();
    expect(e.kw_type).toBe("net.connect");
    expect(e.target_resource).toBe("1.1.1.1:443");
    expect(e.tetragon.net?.dport).toBe(443);
    // In the spike this connect was killed by an ad-hoc Sigkill policy (kw-net) that is not ours -> failed, not blocked.
    expect(e.outcome).toBe("failed");
    expect(e.unavailable_fields).toContain("bytes_transferred");
  });

  it("process_lsm Override is 'blocked' ONLY for our registered policy", () => {
    const raw = fx("spike-example-process_lsm-override.json");
    const notOurs = parseTetragonRecord(raw, { runId: RUN }, 1);
    expect(notOurs.outcome).toBe("failed");
    expect(notOurs.tetragon.enforcement).toBeNull();
    const ours = parseTetragonRecord(raw, { runId: RUN, enforcementPolicies: { "kw-canary-lsm-override": { policy_sha256: "b".repeat(64) } } }, 1);
    expect(Event.parse(ours)).toBeTruthy();
    expect(ours.outcome).toBe("blocked");
    expect(ours.tetragon.enforcement).toMatchObject({ policy_name: "kw-canary-lsm-override", policy_sha256: "b".repeat(64), errno: "EPERM" });
  });

  it("Sigkill kprobe + exit signal from a non-KW policy: failed + exit signal recorded", () => {
    const [kp, exit] = fx("spike-example-sigkill-kprobe-and-exit.json");
    const a = parseTetragonRecord(kp, { runId: RUN }, 1);
    const b = parseTetragonRecord(exit, { runId: RUN }, 2);
    expect(a.outcome).toBe("failed");
    expect(b.kw_type).toBe("process.exit");
    expect(b.tetragon.exit?.signal).toBe("SIGKILL");
    expect(b.outcome).toBe("failed");
  });

  it("is idempotent: same record -> same id; different run -> different id", () => {
    const r = fx("spike-example-process_exec-curl.json");
    expect(parseTetragonRecord(r, { runId: RUN }).id).toBe(parseTetragonRecord(JSON.stringify(r), { runId: RUN }).id);
    expect(parseTetragonRecord(r, { runId: RUN }).id).not.toBe(parseTetragonRecord(r, { runId: "run_other" }).id);
  });

  it("preserves unparseable and unsupported records as raw with collection_status", () => {
    const bad = parseTetragonRecord('{"process_exec": {"pro', { runId: RUN, fallbackTime: "2026-10-17T00:00:00Z" }, 7);
    expect(bad.kw_type).toBe("raw");
    expect(bad.collection_status).toBe("error");
    expect(Event.parse(bad)).toBeTruthy();
    const odd = parseTetragonRecord({ process_tracepoint: { process: {} }, time: "2026-10-17T01:00:00.123456789Z" }, { runId: RUN }, 8);
    expect(odd.kw_type).toBe("raw");
    expect(odd.collection_status).toBe("partial");
    expect(odd.tetragon.raw).toBeTruthy();
  });
});

describe("normalizeSlice on a live capture (alpine container, observe + scoped enforcement)", () => {
  const mine = liveLines.filter((l) => {
    if (!l.trim()) return false;
    return containerIdMatches(recordDocker(JSON.parse(l)), LIVE_CID);
  });
  const { events, stats } = normalizeSlice(mine, { runId: RUN, enforcementPolicies: REG });

  it("container filter drops host-side runc/containerd-shim records that only mention the id in args", () => {
    expect(liveLines.filter((l) => l.trim()).length).toBe(79);
    expect(mine.length).toBeLessThan(79);
    expect(events.every((e) => e.tetragon.process.docker === LIVE_CID)).toBe(true);
    expect(events.some((e) => /runc|containerd/.test(e.process_name ?? ""))).toBe(false);
  });

  it("every event is a valid @kw/schema Event with a unique stable id", () => {
    for (const e of events) Event.parse(e);
    expect(new Set(events.map((e) => e.id)).size).toBe(events.length);
    const again = normalizeSlice(mine, { runId: RUN, enforcementPolicies: REG });
    expect(again.events.map((e) => e.id)).toEqual(events.map((e) => e.id));
  });

  it("collapses overlayfs duplicate opens (counted, not silently dropped)", () => {
    expect(stats.overlay_duplicates_collapsed).toBeGreaterThan(0);
    const catOpens = events.filter((e) => e.kw_type === "file.open" && e.process_name === "/bin/cat" && e.target_resource === "/kw-canary/secret.txt" && e.outcome === "succeeded");
    expect(catOpens).toHaveLength(1);
    expect(catOpens[0]!.tetragon.overlay_duplicates).toBe(1);
  });

  it("labels the denied open blocked with the policy record, and links the failed kprobe open to it", () => {
    const lsm = events.filter((e) => e.tetragon.record_type === "process_lsm");
    expect(lsm).toHaveLength(1);
    expect(lsm[0]!.outcome).toBe("blocked");
    expect(lsm[0]!.tetragon.enforcement?.policy_name).toBe("kw-enf-manual");
    const linked = events.find((e) => e.tetragon.record_type === "process_kprobe" && e.tetragon.file?.return_code === -1);
    expect(linked?.outcome).toBe("blocked");
    expect(linked?.tetragon.linked_enforcement_event_id).toBe(lsm[0]!.id);
    expect(stats.blocked).toBe(1);
    expect(stats.linked_enforcement).toBe(1);
  });

  it("without the registry the same EPERM is only 'failed'", () => {
    const plain = normalizeSlice(mine, { runId: RUN });
    expect(plain.events.some((e) => e.outcome === "blocked")).toBe(false);
    expect(plain.events.some((e) => e.kw_type === "file.open" && e.outcome === "failed")).toBe(true);
  });

  it("attributes cat back through its parent shell (ancestry)", () => {
    const catOpen = events.find((e) => e.kw_type === "file.open" && e.process_name === "/bin/cat" && e.target_resource === "/w/.env")!;
    expect(catOpen.tetragon.ancestry[0]?.binary).toBe("/bin/sh");
    expect(catOpen.tetragon.ancestry[0]?.args).toContain("cat /kw-canary/secret.txt");
    // a bash builtin read (`read x < /w/.env`) is attributed to the shell itself, with no exec
    expect(events.some((e) => e.kw_type === "file.read" && e.process_name === "/bin/sh" && e.target_resource === "/w/.env")).toBe(true);
  });
});

describe("findToolShell", () => {
  it("finds the sh/bash spawned by node for a grandchild", () => {
    const mk = (exec_id: string, parent: string | null, binary: string) => ({ exec_id, parent_exec_id: parent, pid: 1, binary, args: null, cwd: null, start_time: null, docker: "c".repeat(31) });
    const table = new Map([
      ["n", mk("n", "init", "/usr/local/bin/node")],
      ["b", mk("b", "n", "/bin/bash")],
      ["p", mk("p", "b", "/usr/bin/python3")],
      ["c", mk("c", "p", "/bin/cat")],
    ]);
    expect(findToolShell(table, "c")?.exec_id).toBe("b");
    expect(buildProcessTable([]).size).toBe(0);
  });
});

describe("renderDenyFileOpen", () => {
  const tpl = readFileSync(join(import.meta.dirname, "..", "..", "..", "docker", "tetragon", "policies", "deny-file-open.template.yaml"), "utf8");
  it("renders exact + prefix selectors scoped to one pid namespace with Override -1", () => {
    const y = renderDenyFileOpen(tpl, { policyName: "kw-enf-test", pidnsInode: "4026532827", paths: ["/kw-canary/secret.txt", "/secrets/"] });
    expect(y).toContain('name: "kw-enf-test"');
    // open: exact + prefix; rename guard: (exact + prefix) x (inode_rename, inode_link)
    expect(y.match(/- "4026532827"/g)).toHaveLength(6);
    expect(y).not.toMatch(/operator: "Equal"\n\s+values:\n\s+- "\/kw-canary"\n/);
    expect(y).toContain('hook: "inode_rename"');
    expect(y).toContain('hook: "inode_link"');
    expect(y).toContain('operator: "Equal"');
    expect(y).toContain('operator: "Prefix"');
    expect(y).toContain("argError: -1");
    expect(y).not.toMatch(/__[A-Z_]+__|#BEGIN|#END/);
  });
  it("drops an empty selector and rejects unsafe input", () => {
    const y = renderDenyFileOpen(tpl, { policyName: "kw-enf-test", pidnsInode: "1", paths: ["/a/b"] });
    const openHook = y.slice(0, y.indexOf('hook: "inode_rename"'));
    expect(openHook).not.toContain('operator: "Prefix"');
    expect(y).not.toContain("#R1PREFIX");
    expect(y).not.toMatch(/__[A-Z_]+__|#BEGIN|#END/);
    expect(() => renderDenyFileOpen(tpl, { policyName: "kw-enf-test", pidnsInode: "1", paths: ['/a"\n- x'] })).toThrow();
    expect(() => renderDenyFileOpen(tpl, { policyName: "kw-enf-test", pidnsInode: "1", paths: ["/a/../etc"] })).toThrow();
    expect(() => renderDenyFileOpen(tpl, { policyName: "Bad Name", pidnsInode: "1", paths: ["/a"] })).toThrow();
    expect(() => renderDenyFileOpen(tpl, { policyName: "kw-enf-test", pidnsInode: "host", paths: ["/a"] })).toThrow();
  });
});

describe("coverageFragment", () => {
  it("never claims content read / bytes transferred and marks network outcomes unobservable", () => {
    const c = coverageFragment({ active: true, errors: [], observationPolicies: ["kw-observe-files", "kw-observe-net"], enforcementPolicies: [] });
    expect(c.report.network_outcomes_observable).toBe(false);
    expect(c.not_established).toEqual(expect.arrayContaining(["content actually read from a file", "mmap reads unless hooked", "activity outside the container"]));
    expect(c.attribution.available).toBe(true);
    expect(c.report.categories.find((x) => x.category === "process_execution")?.status).toBe("observed");
    expect(c.report.categories.find((x) => x.category === "file_access")?.status).toBe("partial");
    expect(c.lossy).toBe(false);
  });

  it("marks coverage LOSSY (no category 'observed') when any Tetragon loss counter rose, incl. notify overflow", () => {
    expect(LOSS_METRICS).toContain("tetragon_notify_overflowed_events_total");
    const loss = Object.fromEntries(LOSS_METRICS.map((k) => [k, 0])) as Record<string, number>;
    loss.tetragon_notify_overflowed_events_total = 9149;
    expect(isLossy(loss)).toBe(true);
    expect(isLossy(null)).toBe(false);
    const c = coverageFragment({ active: true, errors: [], observationPolicies: ["kw-observe-files", "kw-observe-net"], enforcementPolicies: [], loss });
    expect(c.lossy).toBe(true);
    expect(c.report.categories.some((x) => x.status === "observed")).toBe(false);
    for (const x of c.report.categories.filter((x) => x.status !== "unavailable")) expect(x.note).toMatch(/^LOSSY: .*notify_overflowed_events_total \+9149/);
    expect(c.not_established.join(" ")).toMatch(/lost\/overflowed/);
  });
});

describe("review hardening", () => {
  it("raw records are redacted text, never the unredacted object", () => {
    const secret = "sk-ant-api03-" + "A".repeat(90);
    const odd = parseTetragonRecord({ process_tracepoint: { process: { arguments: `--key ${secret}` } }, time: "2026-10-17T01:00:00.123456789Z" }, { runId: RUN }, 9);
    expect(typeof odd.tetragon.raw).toBe("string");
    expect(odd.tetragon.raw).not.toContain(secret);
  });

  it("an Override from our policy name on a kprobe (not BPF-LSM) record is not 'blocked'", () => {
    const raw = fx("spike-example-process_lsm-override.json");
    const asKprobe = { process_kprobe: { ...raw.process_lsm, function_name: "security_file_open" }, time: raw.time };
    const e = parseTetragonRecord(asKprobe, { runId: RUN, enforcementPolicies: { "kw-canary-lsm-override": { policy_sha256: "b".repeat(64) } } }, 1);
    expect(e.outcome).toBe("failed");
    expect(e.tetragon.enforcement).toBeNull();
  });

  it("enforcement names must be kw-enf-* (cannot replace kw-observe-*) and over-broad prefixes are refused", () => {
    const tpl = readFileSync(join(import.meta.dirname, "..", "..", "..", "docker", "tetragon", "policies", "deny-file-open.template.yaml"), "utf8");
    expect(() => renderDenyFileOpen(tpl, { policyName: "kw-observe-files", pidnsInode: "1", paths: ["/a"] })).toThrow();
    for (const p of ["/", "/etc/", "/usr/", "/proc/"]) expect(() => renderDenyFileOpen(tpl, { policyName: "kw-enf-x", pidnsInode: "1", paths: [p] })).toThrow();
    expect(() => renderDenyFileOpen(tpl, { policyName: "kw-enf-x", pidnsInode: "1", paths: ["/kw-canary/", "/etc/shadow"] })).not.toThrow();
  });
});

describe("isolationViolations", () => {
  const base = { id: "c".repeat(64), name: "a", running: true, pid: 10, image: "x", privileged: false, pidMode: "", networkMode: "bridge", capAdd: [], mountSources: [] };
  const data = "/Users/u/repo/data/observer/tetragon";
  it("accepts a plain container with a workspace bind", () => {
    expect(isolationViolations({ ...base, mountSources: [{ source: "/Users/u/repo/data/workspaces/run_1", destination: "/workspace", type: "bind" }] }, data, "kw-tetragon")).toEqual([]);
  });
  it("flags docker.sock, privileged, pid=host, caps, and mounts that expose the evidence dir", () => {
    const v = isolationViolations(
      {
        ...base,
        privileged: true,
        pidMode: "host",
        capAdd: ["CAP_SYS_ADMIN"],
        mountSources: [
          { source: "/var/run/docker.sock", destination: "/var/run/docker.sock", type: "bind" },
          { source: "/host_mnt/Users/u/repo", destination: "/repo", type: "bind" },
          { source: "/Users/u/repo/data/observer/tetragon/export", destination: "/x", type: "bind" },
        ],
      },
      data,
      "kw-tetragon",
    );
    expect(v.join("\n")).toMatch(/privileged/);
    expect(v.join("\n")).toMatch(/pid namespace/);
    expect(v.join("\n")).toMatch(/CAP_SYS_ADMIN/);
    expect(v.join("\n")).toMatch(/docker socket/);
    expect(v.filter((x) => /evidence directory/.test(x))).toHaveLength(2);
  });
});

describe("renameGuardPaths", () => {
  it("guards the path, its ancestors, prefix dirs, and mount-relative variants (never '/')", () => {
    const g = renameGuardPaths(["/workspace/app/.env", "/kw-canary/", "/workspace/"], ["/workspace"]);
    expect(g.exact).toEqual(expect.arrayContaining(["/workspace/app/.env", "/workspace/app", "/workspace", "/kw-canary", "/app/.env", "/app"]));
    expect(g.prefix).toEqual(expect.arrayContaining(["/kw-canary/", "/workspace/"]));
    expect(g.prefix).not.toContain("/");
    expect(g.exact).not.toContain("/");
  });
});
