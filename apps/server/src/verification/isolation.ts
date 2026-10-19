/**
 * Per-run network isolation for the agent container (PRD/ARCHITECTURE P11, R15).
 *
 * Docker documents that an `--internal` network still reaches its bridge gateway, and the isolation probe found two
 * Docker Desktop VM listeners there (10.x.x.1:111 and :57271). Before the agent's entrypoint is released through the
 * start gate, the harness:
 *
 *  1. runs a short-lived helper (image kw-netguard:1, docker/netguard) in the AGENT's network namespace
 *     (`--network container:<agent>`) with CAP_NET_ADMIN only, which installs an OUTPUT allowlist: loopback (Docker's
 *     embedded DNS), the egress proxy IP and the credential broker IP; everything else, including the gateway, is
 *     rejected. The agent itself never holds NET_ADMIN (cap-drop ALL + no-new-privileges), so it cannot undo the rules.
 *  2. runs a self-test from inside the agent container (as the agent user): TCP connects to the gateway (known VM
 *     listeners + every Underwatch port) and the Docker Desktop host names must ALL fail, and the broker/proxy
 *     must stay reachable (positive control). Any success refuses the run.
 *
 * What this establishes is limited to the probed targets at run start (recorded verbatim as evidence); it is not a
 * proof that no other path exists.
 */

export const NETGUARD_IMAGE = "kw-netguard:1";

/** Underwatch host/VM ports (API, web, Neo4j, Tetragon metrics, daemon proxy) plus the 2 known gateway listeners. */
export const KW_PORTS = [4600, 4601, 7474, 7484, 7687, 7697, 2112, 29112, 3128] as const;
export const GATEWAY_EXTRA_PORTS = [111, 57271, 22, 53, 80, 443, 2375, 2376, 8080, 8888] as const;
export const DESKTOP_HOSTS = ["host.docker.internal", "gateway.docker.internal", "http.docker.internal"] as const;

export type ProbeState = "open" | "refused" | "timeout" | "error";
export interface ProbeResult {
  h: string;
  p: number;
  s: ProbeState;
  e: string | null;
}

export interface IsolationSelfTest {
  status: "passed" | "failed";
  gateway: string;
  allow: Array<{ name: string; ip: string }>;
  netguard: { ok: boolean; rules: string; detail: string };
  /** Targets that must be unreachable but answered (open = listener, refused = packet path to the host exists). */
  reachable: ProbeResult[];
  /** Positive control: broker/proxy targets that should be reachable but were not. */
  controlFailures: ProbeResult[];
  probes: ProbeResult[];
  detail: string;
  recorded_at: string;
}

/** Probe run inside the agent with `node -e`; targets come on stdin (no file mount, no argv size limit). */
export const PROBE_JS = `const net=require("net");let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{const T=JSON.parse(d);const out=[];let i=0;
const one=t=>new Promise(r=>{const s=net.connect({host:t.h,port:t.p});const done=(st,e)=>{s.destroy();r({h:t.h,p:t.p,s:st,e:e||null})};s.setTimeout(t.ms||1000,()=>done("timeout"));s.on("connect",()=>done("open"));s.on("error",e=>done(e.code==="ECONNREFUSED"?"refused":"error",e.code))});
const w=async()=>{while(i<T.length){const t=T[i++];out.push(await one(t))}};Promise.all(Array.from({length:Math.min(200,T.length)},w)).then(()=>process.stdout.write(JSON.stringify(out)))});`;

const IPV4 = /^(\d{1,3}\.){3}\d{1,3}$/;

/** iptables script for the helper. Only validated IPv4 literals are interpolated. */
export function netguardScript(allowIps: string[]): string {
  for (const ip of allowIps) if (!IPV4.test(ip)) throw new Error(`netguard: invalid IP "${ip}"`);
  return [
    "set -e",
    "iptables -A OUTPUT -o lo -j ACCEPT",
    ...allowIps.map((ip) => `iptables -A OUTPUT -d ${ip}/32 -j ACCEPT`),
    "iptables -A OUTPUT -p tcp -j REJECT --reject-with icmp-admin-prohibited",
    "iptables -A OUTPUT -j DROP",
    "(ip6tables -A OUTPUT -o lo -j ACCEPT && ip6tables -A OUTPUT -j DROP) 2>/dev/null || echo 'ip6tables unavailable (no IPv6 on the internal network expected)'",
    "iptables -S OUTPUT",
  ].join("; ");
}

export function selfTestTargets(gateway: string, allow: Array<{ name: string; ip: string }>, allowPorts: Record<string, number>) {
  const must: Array<{ h: string; p: number; ms: number }> = [];
  for (const p of new Set<number>([...KW_PORTS, ...GATEWAY_EXTRA_PORTS])) must.push({ h: gateway, p, ms: 1000 });
  for (const h of DESKTOP_HOSTS) for (const p of KW_PORTS) must.push({ h, p, ms: 1000 });
  const control = allow.filter((a) => allowPorts[a.name]).map((a) => ({ h: a.ip, p: allowPorts[a.name]!, ms: 3000 }));
  return { must, control };
}

/** Pure verdict: any must-fail target that is open/refused, or any control target not open, fails the self-test. */
export function judgeSelfTest(probes: ProbeResult[], controlKeys: Set<string>): { reachable: ProbeResult[]; controlFailures: ProbeResult[] } {
  const reachable = probes.filter((r) => !controlKeys.has(`${r.h}:${r.p}`) && (r.s === "open" || r.s === "refused"));
  const controlFailures = probes.filter((r) => controlKeys.has(`${r.h}:${r.p}`) && r.s !== "open");
  return { reachable, controlFailures };
}

type DockerFn = (args: string[], opts?: { input?: Buffer; timeoutMs?: number }) => Promise<{ code: number | null; stdout: string; stderr: string }>;

/**
 * Installs the netguard rules in the agent's namespace and runs the self-test. Never throws; status "failed" means
 * the caller must NOT release the agent.
 */
export async function guardAndSelfTest(
  docker: DockerFn,
  o: { agent: string; network: string; peers: Array<{ name: string; port: number }>; labels: string[] },
): Promise<IsolationSelfTest> {
  const recorded_at = new Date().toISOString();
  const base = { gateway: "", allow: [] as Array<{ name: string; ip: string }>, netguard: { ok: false, rules: "", detail: "" }, reachable: [], controlFailures: [], probes: [], recorded_at };
  const fail = (detail: string, extra: Partial<IsolationSelfTest> = {}): IsolationSelfTest => ({ ...base, ...extra, status: "failed", detail });
  const gw = await docker(["network", "inspect", "-f", "{{range .IPAM.Config}}{{.Gateway}}{{end}}", o.network], { timeoutMs: 15_000 });
  const gateway = gw.stdout.trim();
  if (gw.code !== 0 || !IPV4.test(gateway)) return fail(`could not determine the internal network gateway ("${gateway}")`);
  const allow: Array<{ name: string; ip: string }> = [];
  for (const p of o.peers) {
    const r = await docker(["inspect", "-f", `{{(index .NetworkSettings.Networks "${o.network}").IPAddress}}`, p.name], { timeoutMs: 15_000 });
    const ip = r.stdout.trim();
    if (r.code !== 0 || !IPV4.test(ip)) return fail(`could not resolve ${p.name} on ${o.network}`, { gateway });
    allow.push({ name: p.name, ip });
  }
  let script: string;
  try {
    script = netguardScript(allow.map((a) => a.ip));
  } catch (e) {
    return fail((e as Error).message, { gateway, allow });
  }
  const ng = await docker(
    ["run", "--rm", ...o.labels, "--network", `container:${o.agent}`, "--cap-drop", "ALL", "--cap-add", "NET_ADMIN", "--security-opt", "no-new-privileges:true", NETGUARD_IMAGE, "-c", script],
    { timeoutMs: 60_000 },
  );
  const netguard = { ok: ng.code === 0, rules: ng.stdout.trim(), detail: ng.code === 0 ? "rules installed" : `netguard exit ${ng.code}: ${ng.stderr.trim().slice(0, 300)}` };
  if (!netguard.ok) return fail(`network guard not installed (${netguard.detail}); the gateway would stay reachable`, { gateway, allow, netguard });

  const ports = Object.fromEntries(o.peers.map((p) => [p.name, p.port]));
  const { must, control } = selfTestTargets(gateway, allow, ports);
  const pr = await docker(["exec", "-i", o.agent, "node", "-e", PROBE_JS], { input: Buffer.from(JSON.stringify([...must, ...control])), timeoutMs: 90_000 });
  let probes: ProbeResult[] = [];
  try {
    probes = JSON.parse(pr.stdout) as ProbeResult[];
  } catch {
    return fail(`self-test probe did not run (exit ${pr.code}): ${pr.stderr.trim().slice(0, 300)}`, { gateway, allow, netguard });
  }
  if (probes.length !== must.length + control.length) return fail(`self-test returned ${probes.length}/${must.length + control.length} results`, { gateway, allow, netguard, probes });
  const { reachable, controlFailures } = judgeSelfTest(probes, new Set(control.map((c) => `${c.h}:${c.p}`)));
  const ok = reachable.length === 0 && controlFailures.length === 0;
  const detail = ok
    ? `OBSERVED at run start: ${must.length} must-fail TCP probes (gateway ${gateway} on ${new Set(must.filter((m) => m.h === gateway).map((m) => m.p)).size} ports incl. 111/57271 and all KW ports; ${DESKTOP_HOSTS.join(", ")}) all failed; broker/proxy control reachable.`
    : `REFUSED: ${reachable.map((r) => `${r.h}:${r.p} ${r.s}`).join(", ") || "no must-fail target reachable"}${controlFailures.length ? `; control unreachable: ${controlFailures.map((r) => `${r.h}:${r.p} ${r.s}`).join(", ")}` : ""}`;
  return { status: ok ? "passed" : "failed", gateway, allow, netguard, reachable, controlFailures, probes, detail, recorded_at };
}
