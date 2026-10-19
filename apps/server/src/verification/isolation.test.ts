import { describe, expect, it } from "vitest";
import { guardAndSelfTest, judgeSelfTest, netguardScript, selfTestTargets, type ProbeResult } from "./isolation";

describe("P11 isolation self-test", () => {
  it("netguard script allowlists only lo + the given IPs and rejects everything else", () => {
    const s = netguardScript(["10.0.0.2", "10.0.0.3"]);
    expect(s).toContain("-o lo -j ACCEPT");
    expect(s).toContain("-d 10.0.0.2/32 -j ACCEPT");
    expect(s).toContain("-d 10.0.0.3/32 -j ACCEPT");
    expect(s).toMatch(/-A OUTPUT -j DROP/);
    expect(() => netguardScript(["10.0.0.2; rm -rf /"])).toThrow(/invalid IP/);
  });

  it("targets include the gateway listeners 111/57271 and every KW port", () => {
    const { must, control } = selfTestTargets("10.0.0.1", [{ name: "b", ip: "10.0.0.3" }], { b: 8080 });
    const gwPorts = must.filter((m) => m.h === "10.0.0.1").map((m) => m.p);
    for (const p of [111, 57271, 4600, 4601, 7687, 7474, 7697, 7484, 2112, 29112, 3128]) expect(gwPorts).toContain(p);
    expect(control).toEqual([{ h: "10.0.0.3", p: 8080, ms: 3000 }]);
  });

  it("refuses when any must-fail target is open or refused, or the control is unreachable", () => {
    const ctl = new Set(["10.0.0.3:8080"]);
    const ok: ProbeResult[] = [
      { h: "10.0.0.1", p: 111, s: "error", e: "EHOSTUNREACH" },
      { h: "10.0.0.3", p: 8080, s: "open", e: null },
    ];
    expect(judgeSelfTest(ok, ctl)).toEqual({ reachable: [], controlFailures: [] });
    const open = judgeSelfTest([{ h: "10.0.0.1", p: 57271, s: "open", e: null }, ok[1]!], ctl);
    expect(open.reachable).toHaveLength(1);
    const refused = judgeSelfTest([{ h: "10.0.0.1", p: 4600, s: "refused", e: "ECONNREFUSED" }, ok[1]!], ctl);
    expect(refused.reachable).toHaveLength(1);
    const noCtl = judgeSelfTest([ok[0]!, { h: "10.0.0.3", p: 8080, s: "timeout", e: null }], ctl);
    expect(noCtl.controlFailures).toHaveLength(1);
  });

  it("fails closed when the guard cannot be installed (never releases the agent)", async () => {
    const docker = async (args: string[]) => {
      if (args[0] === "network") return { code: 0, stdout: "10.0.0.1\n", stderr: "" };
      if (args[0] === "inspect") return { code: 0, stdout: "10.0.0.3\n", stderr: "" };
      if (args[0] === "run") return { code: 1, stdout: "", stderr: "image not found" };
      throw new Error("probe must not run without the guard");
    };
    const r = await guardAndSelfTest(docker, { agent: "a", network: "n", peers: [{ name: "b", port: 8080 }], labels: [] });
    expect(r.status).toBe("failed");
    expect(r.detail).toMatch(/network guard not installed/);
  });

  it("fails when the probe reports the gateway reachable", async () => {
    const docker = async (args: string[], o?: { input?: Buffer }) => {
      if (args[0] === "network") return { code: 0, stdout: "10.0.0.1", stderr: "" };
      if (args[0] === "inspect") return { code: 0, stdout: "10.0.0.3", stderr: "" };
      if (args[0] === "run") return { code: 0, stdout: "-A OUTPUT -j DROP", stderr: "" };
      const T = JSON.parse(o!.input!.toString()) as Array<{ h: string; p: number }>;
      const out = T.map((t) => ({ h: t.h, p: t.p, s: t.h === "10.0.0.3" || t.p === 111 ? "open" : "error", e: null }));
      return { code: 0, stdout: JSON.stringify(out), stderr: "" };
    };
    const r = await guardAndSelfTest(docker, { agent: "a", network: "n", peers: [{ name: "b", port: 8080 }], labels: [] });
    expect(r.status).toBe("failed");
    expect(r.reachable.map((x) => `${x.h}:${x.p}`)).toEqual(["10.0.0.1:111"]);
  });
});
