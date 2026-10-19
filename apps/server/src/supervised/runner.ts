/**
 * Docker executor for ONE live supervised run. Same isolation as the verification harness (verification/harness.ts:
 * kw-agent image, internal-only network, default-deny egress proxy, managed settings mounted read-only, non-root,
 * cap-drop ALL) plus the credential broker (docker/llm-broker) that compose.agent.yml / agent-smoke.sh use since the
 * 2026-10-17 remediation: the REAL Claude token is bind-mounted read-only into the broker container ONLY; the agent
 * gets ANTHROPIC_BASE_URL=http://<broker>:8080 and a per-run placeholder credential worthless anywhere else.
 *
 * Everything is captured on the HOST: container stdout (stream-json), hook spool (copied out after the run),
 * `docker logs` of the proxy and the broker, and a git snapshot of the disposable copy before and after the run
 * against a baseline git dir the container never sees. The token and the placeholder are scrubbed from every artifact.
 * Every docker resource is named kw-sr-<suffix>-* and labelled kw-supervised-run=<runId>, and removed afterwards.
 */
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { AGENT_IMAGE, PROXY_IMAGE, readClaudeToken } from "../verification/harness";
import { GATE_COMMAND, GATE_ENTRYPOINT_ARGS, GATE_FILE, runUnderTetragon, type KernelHarnessOptions, type KernelObservation } from "../observers";

export const BROKER_IMAGE = "kw-llm-broker:1";

export interface SupervisedPlan {
  runId: string;
  /** Files of the disposable copy (canary already planted). */
  files: Array<{ rel_path: string; bytes: Buffer }>;
  policyJson: string;
  task: string;
  model: string;
  maxTurns: number;
  timeoutMs: number;
  workDir: string;
  dockerDir: string;
  repoRoot: string;
  tokenFile: string;
  /** Kernel observer (Tetragon) for this run (same gate -> attach -> release -> stop flow as verification runs). */
  kernel?: KernelHarnessOptions | null;
  /** Live-feed taps (display only): agent stdout chunks as they arrive, and the agent container's name. */
  onAgentOutput?: (chunk: string) => void;
  onAgentContainer?: (name: string) => void;
}

export interface ManifestEntry {
  path: string;
  sha256: string;
  size: number;
}

/** Raw host captures of one run. Serializable: stored as the "capture" artifact so ingestion can be replayed. */
export interface SupervisedCapture {
  streamJson: string;
  hooks: string;
  proxyLog: string;
  brokerLog: string;
  gitStatus: string;
  gitDiff: string;
  manifestBefore: ManifestEntry[];
  manifestAfter: ManifestEntry[];
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
  /** Harness-level failure (docker error, setup failure). Null when the agent container ran to exit. */
  error: string | null;
  imageId: string | null;
  /** Host clock: agent container started / exited / workspace snapshot taken. */
  agentStartedAt: string | null;
  agentEndedAt: string | null;
  snapshotAt: string | null;
  tokenScan: "clean" | "scrubbed" | "no-token";
  authenticated: boolean;
  /** Tetragon observation of the agent container; null/absent = no kernel observer for this run. */
  kernel?: KernelObservation | null;
  /** Credential broker IP on the agent's internal network (kernel connects carry IPs, not names). */
  brokerIp?: string | null;
  proxyIp?: string | null;
}

export type SupervisedExecutor = (plan: SupervisedPlan) => Promise<SupervisedCapture>;

interface Cmd {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

function run(cmd: string, args: string[], opts: { input?: Buffer; env?: NodeJS.ProcessEnv; timeoutMs?: number; onTimeout?: () => void; onStdout?: (chunk: string) => void } = {}): Promise<Cmd> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { env: opts.env ?? process.env, stdio: ["pipe", "pipe", "pipe"] });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let timedOut = false;
    let timer: NodeJS.Timeout | undefined;
    if (opts.timeoutMs) {
      timer = setTimeout(() => {
        timedOut = true;
        opts.onTimeout?.();
        child.kill("SIGKILL");
      }, opts.timeoutMs);
    }
    child.stdout.on("data", (c: Buffer) => {
      out.push(c);
      if (opts.onStdout) {
        try {
          opts.onStdout(c.toString("utf8"));
        } catch {
          /* the live feed is best-effort display only */
        }
      }
    });
    child.stderr.on("data", (c: Buffer) => err.push(c));
    child.on("error", (e) => {
      if (timer) clearTimeout(timer);
      resolve({ code: null, stdout: "", stderr: String(e.message), timedOut });
    });
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      resolve({ code, stdout: Buffer.concat(out).toString("utf8"), stderr: Buffer.concat(err).toString("utf8"), timedOut });
    });
    child.stdin.on("error", () => {});
    if (opts.input) child.stdin.end(opts.input);
    else child.stdin.end();
  });
}

const docker = (args: string[], opts?: Parameters<typeof run>[2]) => run("docker", args, opts);

/** sha256 manifest of regular files under root (skips .git; never follows symlinks; symlinks are listed as such). */
export function manifestOf(root: string): ManifestEntry[] {
  const out: ManifestEntry[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir).sort()) {
      if (name === ".git") continue;
      const abs = path.join(dir, name);
      const st = lstatSync(abs);
      const rel = path.relative(root, abs).split(path.sep).join("/");
      if (st.isSymbolicLink()) out.push({ path: rel, sha256: "symlink", size: 0 });
      else if (st.isDirectory()) walk(abs);
      else if (st.isFile()) out.push({ path: rel, sha256: createHash("sha256").update(readFileSync(abs)).digest("hex"), size: st.size });
    }
  };
  if (existsSync(root)) walk(root);
  return out;
}

export const dockerSupervisedExecutor: SupervisedExecutor = async (plan) => {
  const suffix = plan.runId.replace(/[^A-Za-z0-9]/g, "").slice(-16).toLowerCase();
  const n = {
    netInt: `kw-sr-${suffix}-int`,
    netEg: `kw-sr-${suffix}-eg`,
    proxy: `kw-sr-${suffix}-proxy`,
    broker: `kw-sr-${suffix}-broker`,
    agent: `kw-sr-${suffix}-agent`,
    wsVol: `kw-sr-${suffix}-ws`,
    hookVol: `kw-sr-${suffix}-hooks`,
  };
  const labels = ["--label", "kw-dev=1", "--label", `kw-supervised-run=${plan.runId}`];
  const token = readClaudeToken(plan.tokenFile);
  const placeholder = `sk-ant-oat01-kwbroker-${randomBytes(24).toString("hex")}`;
  const W = plan.workDir;
  const baseline = path.join(W, "baseline");
  const after = path.join(W, "after");
  const policyDir = path.join(W, "policy");
  const brokerDir = path.join(W, "broker");
  const clientTokenFile = path.join(brokerDir, "client-token");
  const forwarder = path.join(W, "kw-hook.mjs");
  const allowlist = path.join(W, "allowlist.ere");
  const cap: SupervisedCapture = {
    streamJson: "",
    hooks: "",
    proxyLog: "",
    brokerLog: "",
    gitStatus: "",
    gitDiff: "",
    manifestBefore: [],
    manifestAfter: [],
    stderr: "",
    exitCode: null,
    timedOut: false,
    error: null,
    imageId: null,
    agentStartedAt: null,
    agentEndedAt: null,
    snapshotAt: null,
    tokenScan: token ? "clean" : "no-token",
    authenticated: token !== null,
  };

  const teardown = async () => {
    await docker(["rm", "-f", n.agent, n.proxy, n.broker], { timeoutMs: 30_000 });
    await docker(["network", "rm", n.netInt, n.netEg], { timeoutMs: 30_000 });
    await docker(["volume", "rm", "-f", n.wsVol, n.hookVol], { timeoutMs: 30_000 });
  };
  const volSh = (vol: string, mount: string, mode: "ro" | "rw", script: string, input?: Buffer) =>
    docker(["run", "--rm", "-i", ...labels, "--network", "none", "--user", "0", "--entrypoint", "sh", "-v", `${vol}:${mount}:${mode}`, AGENT_IMAGE, "-c", script], {
      input,
      timeoutMs: 120_000,
    });
  const must = (r: Cmd, what: string) => {
    if (r.code !== 0) throw new Error(`${what} failed (exit ${r.code ?? "spawn error"}): ${r.stderr.trim().slice(0, 300)}`);
    return r;
  };
  const waitLog = async (name: string, re: RegExp) => {
    for (let i = 0; i < 60; i++) {
      const l = await docker(["logs", name], { timeoutMs: 10_000 });
      if (re.test(l.stdout + l.stderr)) return true;
      await new Promise((r) => setTimeout(r, 250));
    }
    return false;
  };

  try {
    if (!token) throw new Error("No usable Claude OAuth token at the configured token file; the agent cannot call the model.");
    rmSync(W, { recursive: true, force: true });
    for (const d of [baseline, after, policyDir, brokerDir]) mkdirSync(d, { recursive: true });

    // Disposable copy + host-held baseline git dir (never mounted into any container).
    for (const f of plan.files) {
      const p = path.join(baseline, f.rel_path);
      if (!p.startsWith(baseline + path.sep)) throw new Error(`unsafe path in snapshot: ${f.rel_path}`);
      mkdirSync(path.dirname(p), { recursive: true });
      writeFileSync(p, f.bytes);
    }
    const gitEnv = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_AUTHOR_DATE: "2026-01-01T00:00:00Z", GIT_COMMITTER_DATE: "2026-01-01T00:00:00Z" };
    const git = (args: string[]) => spawnSync("git", args, { cwd: baseline, env: gitEnv, encoding: "utf8" });
    if (git(["init", "-q", "-b", "main", "."]).status !== 0) throw new Error("git init failed on the host");
    git(["add", "-A", "-f"]);
    if (git(["-c", "user.name=kw-supervisor", "-c", "user.email=supervisor@kw.invalid", "commit", "-q", "-m", "baseline"]).status !== 0)
      throw new Error("git baseline commit failed on the host");
    cap.manifestBefore = manifestOf(baseline);

    writeFileSync(path.join(policyDir, "managed-settings.json"), plan.policyJson);
    const realForwarder = path.join(plan.repoRoot, "packages", "adapter-claude-code", "bin", "kw-hook.mjs");
    copyFileSync(existsSync(realForwarder) ? realForwarder : path.join(plan.dockerDir, "agent", "kw-hook.placeholder.mjs"), forwarder);
    copyFileSync(path.join(plan.dockerDir, "egress-proxy", "allowlist.ere"), allowlist);
    writeFileSync(clientTokenFile, placeholder, { mode: 0o600 });
    chmodSync(W, 0o755);
    chmodSync(policyDir, 0o755);
    for (const f of [path.join(policyDir, "managed-settings.json"), forwarder, allowlist]) chmodSync(f, 0o644);

    await teardown();
    cap.imageId = must(await docker(["image", "inspect", "-f", "{{.Id}}", AGENT_IMAGE], { timeoutMs: 15_000 }), "agent image inspect").stdout.trim() || null;
    must(await docker(["image", "inspect", "-f", "{{.Id}}", PROXY_IMAGE], { timeoutMs: 15_000 }), "proxy image inspect");
    must(await docker(["image", "inspect", "-f", "{{.Id}}", BROKER_IMAGE], { timeoutMs: 15_000 }), "broker image inspect");

    must(await docker(["network", "create", "--internal", ...labels, n.netInt], { timeoutMs: 30_000 }), "internal network create");
    must(await docker(["network", "create", ...labels, n.netEg], { timeoutMs: 30_000 }), "egress network create");
    const subnet = must(await docker(["network", "inspect", "-f", "{{range .IPAM.Config}}{{.Subnet}}{{end}}", n.netInt], { timeoutMs: 15_000 }), "network inspect").stdout.trim();
    if (!/^[0-9./]+$/.test(subnet)) throw new Error(`unexpected internal subnet "${subnet}"`);

    must(await docker(["volume", "create", ...labels, n.wsVol], { timeoutMs: 30_000 }), "workspace volume create");
    must(await docker(["volume", "create", ...labels, n.hookVol], { timeoutMs: 30_000 }), "hook volume create");
    const tar = spawnSync("tar", ["-C", baseline, "--exclude", "./.git", "-cf", "-", "."], { env: { ...process.env, COPYFILE_DISABLE: "1" }, maxBuffer: 256 * 1024 * 1024 });
    if (tar.status !== 0) throw new Error("tar of the disposable copy failed");
    must(await volSh(n.wsVol, "/workspace", "rw", "tar -xf - -C /workspace && chown -R 1000:1000 /workspace", tar.stdout), "workspace copy into volume");
    must(await volSh(n.hookVol, "/kw-hooks", "rw", "chown 1000:1000 /kw-hooks && chmod 0700 /kw-hooks"), "hook volume init");

    // Egress proxy (default-deny tripwire) and credential broker, both on the internal + egress networks.
    must(
      await docker(
        [
          "run", "-d", "--name", n.proxy, ...labels, "--network", n.netInt, "--read-only", "--tmpfs", "/tmp",
          "--cap-drop", "ALL", "--cap-add", "SETUID", "--cap-add", "SETGID", "--security-opt", "no-new-privileges:true",
          "--pids-limit", "128", "--memory", "128m", "-e", `KW_ALLOW_SUBNET=${subnet}`,
          "-v", `${allowlist}:/etc/kw-egress/allowlist.ere:ro`, PROXY_IMAGE,
        ],
        { timeoutMs: 60_000 },
      ),
      "egress proxy start",
    );
    must(await docker(["network", "connect", n.netEg, n.proxy], { timeoutMs: 30_000 }), "proxy egress attach");
    must(
      await docker(
        [
          "run", "-d", "--name", n.broker, ...labels, "--network", n.netInt, "--read-only",
          "--cap-drop", "ALL", "--security-opt", "no-new-privileges:true", "--pids-limit", "64", "--memory", "256m",
          "-v", `${plan.tokenFile}:/run/kw-secrets/claude-token:ro`, "-v", `${clientTokenFile}:/run/kw-secrets/client-token:ro`, BROKER_IMAGE,
        ],
        { timeoutMs: 60_000 },
      ),
      "credential broker start",
    );
    must(await docker(["network", "connect", n.netEg, n.broker], { timeoutMs: 30_000 }), "broker egress attach");
    if (!(await waitLog(n.proxy, /listening on fd/))) throw new Error("egress proxy did not start");
    if (!(await waitLog(n.broker, /"event":"listening"/))) throw new Error("credential broker did not start (token file unreadable or malformed?)");

    // Agent. Only the placeholder is passed (by NAME, from the docker client's environment; never argv).
    const proxyUrl = `http://${n.proxy}:8888`;
    const noProxy = `localhost,127.0.0.1,${n.broker}`;
    const env: NodeJS.ProcessEnv = { ...process.env, KW_TASK: plan.task, CLAUDE_CODE_OAUTH_TOKEN: placeholder };
    delete env.ANTHROPIC_API_KEY;
    delete env.ANTHROPIC_AUTH_TOKEN;
    delete env.ANTHROPIC_BASE_URL;
    const ipOf = async (name: string) => {
      const r = await docker(["inspect", "-f", `{{(index .NetworkSettings.Networks "${n.netInt}").IPAddress}}`, name], { timeoutMs: 10_000 });
      const ip = r.stdout.trim();
      return r.code === 0 && /^[0-9.]+$/.test(ip) ? ip : null;
    };
    cap.brokerIp = await ipOf(n.broker);
    cap.proxyIp = await ipOf(n.proxy);
    const agentArgs = [
      "--name", n.agent, ...labels, "--network", n.netInt, "--user", "1000:1000", "--init",
      "--cap-drop", "ALL", "--security-opt", "no-new-privileges:true", "--pids-limit", "512", "--memory", "2g",
      "-v", `${n.wsVol}:/workspace`, "-v", `${n.hookVol}:/kw-hooks`,
      "-v", `${policyDir}:/etc/claude-code:ro`, "-v", `${forwarder}:/opt/kw/kw-hook.mjs:ro`,
      "-e", "KW_TASK", "-e", `KW_MODEL=${plan.model}`, "-e", `KW_MAX_TURNS=${plan.maxTurns}`, "-e", "KW_HOOK_LOG=/kw-hooks/hooks.ndjson",
      "-e", `HTTPS_PROXY=${proxyUrl}`, "-e", `HTTP_PROXY=${proxyUrl}`, "-e", `https_proxy=${proxyUrl}`, "-e", `http_proxy=${proxyUrl}`,
      "-e", `NO_PROXY=${noProxy}`, "-e", `no_proxy=${noProxy}`,
      "-e", `ANTHROPIC_BASE_URL=http://${n.broker}:8080`, "-e", "CLAUDE_CODE_OAUTH_TOKEN",
      "-e", "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1", "-e", "CLAUDE_CODE_DISABLE_AUTO_MEMORY=1",
    ];
    const agentOpts = { env, timeoutMs: plan.timeoutMs, onTimeout: () => void docker(["kill", n.agent], { timeoutMs: 15_000 }), onStdout: plan.onAgentOutput };
    plan.onAgentContainer?.(n.agent);
    let agent: Cmd;
    if (plan.kernel) {
      // Same paused start as verification runs (observers/tetragon-run.ts): create with the image entrypoint held
      // behind a gate, attach Tetragon, start, release the gate, run, stop the capture (slice + sha256 + events).
      must(await docker(["create", ...agentArgs, ...GATE_ENTRYPOINT_ARGS, AGENT_IMAGE, ...GATE_COMMAND], { env, timeoutMs: 60_000 }), "agent container create");
      cap.agentStartedAt = new Date().toISOString();
      const k = await runUnderTetragon(plan.kernel.api, plan.kernel.health, n.agent, plan.kernel.run, {
        startAttached: () => docker(["start", "-a", n.agent], agentOpts),
        waitRunning: async () => {
          for (let i = 0; i < 100; i++) {
            const r = await docker(["inspect", "-f", "{{.State.Running}} {{.State.Pid}}", n.agent], { timeoutMs: 10_000 });
            const [running, pid] = r.stdout.trim().split(" ");
            if (running === "true" && Number(pid) > 0) return true;
            if (r.code !== 0) return false;
            await new Promise((res) => setTimeout(res, 100));
          }
          return false;
        },
        releaseGate: async () => (await docker(["exec", n.agent, "touch", GATE_FILE], { timeoutMs: 20_000 })).code === 0,
        kill: async () => void (await docker(["kill", n.agent], { timeoutMs: 15_000 })),
      });
      cap.kernel = k.observation;
      if (!k.result) {
        // attach failed (container never started) or the gate could not be released: run WITHOUT the kernel
        // observer rather than not at all; coverage then says kernel observation was unavailable, and why.
        await docker(["rm", "-f", n.agent], { timeoutMs: 30_000 });
        const why = k.observation.reason || k.observation.errors.join("; ") || "agent not started";
        cap.kernel = { ...k.observation, status: "error", capture: null, reason: `agent could not be started under the kernel observer (${why}); the run continued WITHOUT kernel observation (the aborted container's slice stays host-side)` };
        cap.agentStartedAt = new Date().toISOString();
        agent = await docker(["run", ...agentArgs, AGENT_IMAGE], agentOpts);
      } else agent = k.result;
    } else {
      cap.agentStartedAt = new Date().toISOString();
      agent = await docker(["run", ...agentArgs, AGENT_IMAGE], agentOpts);
    }
    cap.agentEndedAt = new Date().toISOString();
    cap.exitCode = agent.code;
    cap.timedOut = agent.timedOut;
    cap.streamJson = agent.stdout;
    cap.stderr = agent.stderr;

    // Collect on the host.
    cap.hooks = (await volSh(n.hookVol, "/kw-hooks", "ro", "cat /kw-hooks/hooks.ndjson 2>/dev/null; true")).stdout;
    const out = spawn("docker", ["run", "--rm", ...labels, "--network", "none", "--user", "0", "--entrypoint", "sh", "-v", `${n.wsVol}:/workspace:ro`, AGENT_IMAGE, "-c", "tar -cf - -C /workspace ."], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    const untar = spawn("tar", ["-xf", "-", "-C", after], { stdio: ["pipe", "ignore", "pipe"] });
    out.stdout.pipe(untar.stdin);
    await new Promise<void>((resolve) => untar.on("close", () => resolve()));
    cap.snapshotAt = new Date().toISOString();
    const pl = await docker(["logs", "--timestamps", n.proxy], { timeoutMs: 20_000 });
    cap.proxyLog = pl.stdout + pl.stderr;
    const bl = await docker(["logs", n.broker], { timeoutMs: 20_000 });
    cap.brokerLog = bl.stdout + bl.stderr;

    const g = (args: string[]) => spawnSync("git", ["--git-dir", path.join(baseline, ".git"), "--work-tree", after, ...args], { env: gitEnv, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    g(["add", "-A", "-f"]);
    cap.gitStatus = g(["status", "--porcelain", "--untracked-files=all"]).stdout ?? "";
    cap.gitDiff = g(["diff", "--cached", "--no-color", "--stat", "--patch"]).stdout ?? "";
    cap.manifestAfter = manifestOf(after);
  } catch (e) {
    cap.error = e instanceof Error ? e.message : String(e);
  } finally {
    await teardown();
    rmSync(W, { recursive: true, force: true });
  }

  // Scrub the real token and the placeholder from every captured string.
  let hit = false;
  const secrets = [token, placeholder].filter((s): s is string => !!s);
  const clean = (t: string) => {
    let s = t;
    for (const sec of secrets) {
      if (s.includes(sec)) {
        if (sec === token) hit = true;
        s = s.split(sec).join(sec === token ? "[REDACTED:claude-oauth-token]" : "[REDACTED:broker-placeholder]");
      }
    }
    return s;
  };
  for (const k of ["streamJson", "hooks", "proxyLog", "brokerLog", "gitStatus", "gitDiff", "stderr"] as const) cap[k] = clean(cap[k]);
  if (cap.error) cap.error = clean(cap.error);
  // The kernel record holds the argv of every process in the agent container (e.g. a `curl -H "Authorization: Bearer
  // <placeholder>"` seen in a real Tetragon export): scrub it too before it reaches the DB, blobs or the capture
  // artifact. The raw host-side slice is untouched, so its sha256 stays verifiable. Tokens are JSON-safe strings.
  if (cap.kernel) {
    const j = JSON.stringify(cap.kernel);
    const c = clean(j);
    if (c !== j) cap.kernel = JSON.parse(c) as KernelObservation;
  }
  if (token) cap.tokenScan = hit ? "scrubbed" : "clean";
  return cap;
};
