/**
 * Docker harness for ONE verification run. Reuses the reviewed kw-agent image and kw-egress-proxy image
 * (docker/agent, docker/egress-proxy; same isolation as scripts/agent-smoke.sh) but drives `docker` directly so
 * every resource is suffixed with the run id: runs can execute concurrently and never touch other kw containers.
 *
 * Evidence is captured on the HOST (container stdout, `docker logs` of the proxy, hook volume copied out after the
 * run, git diff against a baseline git dir the container never sees).
 *
 * Credentials (credential broker, docker/llm-broker): the real Claude OAuth token file is bind-mounted read-only into
 * a per-run broker container ONLY. The agent container never receives it (not in env, argv, files or mounts): it gets
 * ANTHROPIC_BASE_URL=http://<broker>:8080 and a random per-run placeholder as CLAUDE_CODE_OAUTH_TOKEN, which only that
 * broker accepts. The broker forwards only POST /v1/messages[/count_tokens] to https://api.anthropic.com and swaps
 * in the real token. The egress proxy's default allowlist is empty, so the agent has no direct route to the API.
 * The token is still scrubbed from every captured artifact (defence in depth).
 */
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync, chmodSync, copyFileSync } from "node:fs";
import path from "node:path";
import type { HarnessCaptures } from "./evaluate";
import { GATE_COMMAND, GATE_ENTRYPOINT_ARGS, GATE_FILE, runUnderTetragon, type KernelHarnessOptions, type KernelObservation } from "../observers";
import { loadAiAndConfig } from "@kw/inference";
import { translateCodexJsonl, type CodexTranslation } from "./codex-stream";
import { guardAndSelfTest, NETGUARD_IMAGE, type IsolationSelfTest } from "./isolation";

export const AGENT_IMAGE = "kw-agent:2.1.302";
export const PROXY_IMAGE = "kw-egress-proxy:1";
export const BROKER_IMAGE = "kw-llm-broker:1";
export const DEFAULT_MODEL = "haiku";
export const DEFAULT_MAX_TURNS = 10;
export const DEFAULT_TIMEOUT_MS = 6 * 60_000;
/** EXPERIMENTAL generic CLI agent: OpenAI Codex CLI headless on ai& (Responses API) via the credential broker. */
export const CODEX_IMAGE = "kw-agent-codex:0.163.0";
export const CODEX_VERSION = "0.163.0";
export const DEFAULT_GENERIC_AGENT_MODEL = "deepseek-ai/deepseek-v4-flash";
export type VerificationAgent = "claude-code" | "codex-cli";
export const GENERIC_AGENT_LABEL =
  "Experimental - generic CLI agent (Codex CLI on ai&): kernel/proxy/git observation + reported commands/final-summary comparison only; no Claude-specific hooks or permission rules";
/** KW_VERIFICATION_AGENT=codex-cli selects the experimental generic CLI agent; anything else keeps Claude Code. */
export function selectVerificationAgent(env: NodeJS.ProcessEnv): VerificationAgent {
  return env.KW_VERIFICATION_AGENT?.trim() === "codex-cli" ? "codex-cli" : "claude-code";
}

export interface HarnessPlan {
  runId: string;
  /** Files of the disposable copy, already modified (safeguard applied, scenario seeded). */
  files: Array<{ rel_path: string; bytes: Buffer }>;
  policyJson: string;
  task: string;
  model: string;
  maxTurns: number;
  timeoutMs: number;
  /** Per-run scratch dir on the host (deleted afterwards). Must be shareable with Docker Desktop. */
  workDir: string;
  dockerDir: string;
  repoRoot: string;
  tokenFile: string;
  /** Kernel observer (Tetragon) for this run; null/absent => no kernel observation (original `docker run` path). */
  kernel?: KernelHarnessOptions | null;
  /** Agent under test. Default "claude-code" (unchanged behaviour); "codex-cli" = EXPERIMENTAL generic CLI agent. */
  agent?: VerificationAgent;
}

export interface HarnessResult {
  captures: HarnessCaptures;
  stderr: string;
  imageId: string | null;
  /** Token scrubbing applied to artifacts ("clean" | "scrubbed" | "no-token"). */
  tokenScan: "clean" | "scrubbed" | "no-token";
  authenticated: boolean;
  /** Tetragon observation of the agent container (only when plan.kernel was set). */
  kernel?: KernelObservation | null;
  /** Host-captured credential broker log (metadata only: method, path, status, decision). */
  brokerLog?: string;
  /** Per-run network guard + isolation self-test (P11), OBSERVED inside the agent container before the gate opened. */
  isolation?: IsolationSelfTest | null;
  /** EXPERIMENTAL codex-cli only: raw `codex exec --json` stdout (AGENT-REPORTED) and its translation summary. */
  agentRawStdout?: string;
  codex?: Pick<CodexTranslation, "commands" | "finalMessage" | "warnings" | "failed" | "parseErrors"> | null;
}

export type HarnessExecutor = (plan: HarnessPlan) => Promise<HarnessResult>;

interface Cmd {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/** Runs a command without a shell. `input` is piped to stdin. Never pass secrets in args. */
function run(cmd: string, args: string[], opts: { input?: Buffer; env?: NodeJS.ProcessEnv; timeoutMs?: number; onTimeout?: () => void } = {}): Promise<Cmd> {
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
    child.stdout.on("data", (c: Buffer) => out.push(c));
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

/** Reads the OAuth token (trimmed). Returns null when missing or malformed; never logs it. */
export function readClaudeToken(tokenFile: string): string | null {
  try {
    if (!existsSync(tokenFile) || statSync(tokenFile).size === 0) return null;
    const t = readFileSync(tokenFile, "utf8").replace(/[\r\n]/g, "");
    return /^[A-Za-z0-9._-]+$/.test(t) ? t : null;
  } catch {
    return null;
  }
}

/** The ai& key for the experimental generic agent's broker (AIAND_API_KEY env or .env.local). Never logged. */
export function readAiandKey(): string | null {
  try {
    const k = loadAiAndConfig().config.apiKey;
    return k && /^[A-Za-z0-9._-]{8,512}$/.test(k) ? k : null;
  } catch {
    return null;
  }
}

export interface HarnessCheck {
  id: string;
  ok: boolean;
  detail: string;
}

/** Readiness checks (names/status only; never secret values). */
export async function checkHarness(tokenFile: string, agentKind: VerificationAgent = "claude-code"): Promise<HarnessCheck[]> {
  const checks: HarnessCheck[] = [];
  const info = await docker(["info", "--format", "{{.ServerVersion}}"], { timeoutMs: 8000 });
  const dockerOk = info.code === 0;
  checks.push({ id: "docker", ok: dockerOk, detail: dockerOk ? `Docker engine ${info.stdout.trim()}` : "Docker is not reachable (is Docker Desktop running?)" });
  for (const [id, image] of [
    ["agent_image", AGENT_IMAGE],
    ["proxy_image", PROXY_IMAGE],
    ["broker_image", BROKER_IMAGE],
    ["netguard_image", NETGUARD_IMAGE],
  ] as const) {
    const r = dockerOk ? await docker(["image", "inspect", "-f", "{{.Id}}", image], { timeoutMs: 8000 }) : null;
    const ok = r?.code === 0;
    checks.push({ id, ok, detail: ok ? `${image} present` : `${image} not built (docker compose -f docker/compose.agent.yml --profile agent build)` });
  }
  if (agentKind === "codex-cli") {
    const r = dockerOk ? await docker(["image", "inspect", "-f", "{{.Id}}", CODEX_IMAGE], { timeoutMs: 8000 }) : null;
    checks.push({ id: "codex_image", ok: r?.code === 0, detail: r?.code === 0 ? `${CODEX_IMAGE} present (experimental generic CLI agent)` : `${CODEX_IMAGE} not built (docker build -t ${CODEX_IMAGE} docker/agent-codex)` });
    const keyOk = readAiandKey() !== null;
    checks.push({ id: "aiand_key", ok: keyOk, detail: keyOk ? "ai& API key present (held by the credential broker only)" : "No AIAND_API_KEY in the environment or .env.local" });
    return checks;
  }
  const tokenOk = readClaudeToken(tokenFile) !== null;
  checks.push({ id: "claude_token", ok: tokenOk, detail: tokenOk ? "Claude OAuth token file present" : "No usable Claude OAuth token at ~/.underwatch/claude-oauth-token (run `claude setup-token`)" });
  return checks;
}

function scrub(text: string, token: string | null): { text: string; hit: boolean } {
  if (!token || !text.includes(token)) return { text, hit: false };
  return { text: text.split(token).join("[REDACTED:claude-oauth-token]"), hit: true };
}

/** Real executor. Every docker resource is named kw-vr-<suffix>-*, labelled kw-verification-run=<runId>, and removed. */
export const dockerHarnessExecutor: HarnessExecutor = async (plan) => {
  const suffix = plan.runId.replace(/[^A-Za-z0-9]/g, "").slice(-16).toLowerCase();
  const n = {
    netInt: `kw-vr-${suffix}-int`,
    netEg: `kw-vr-${suffix}-eg`,
    proxy: `kw-vr-${suffix}-proxy`,
    broker: `kw-vr-${suffix}-broker`,
    agent: `kw-vr-${suffix}-agent`,
    wsVol: `kw-vr-${suffix}-ws`,
    hookVol: `kw-vr-${suffix}-hooks`,
  };
  const labels = ["--label", "kw-dev=1", "--label", `kw-verification-run=${plan.runId}`];
  const codex = plan.agent === "codex-cli";
  const token = codex ? readAiandKey() : readClaudeToken(plan.tokenFile);
  const W = plan.workDir;
  const baseline = path.join(W, "baseline");
  const after = path.join(W, "after");
  const policyDir = path.join(W, "policy");
  const forwarder = path.join(W, "kw-hook.mjs");
  const allowlist = path.join(W, "allowlist.ere");
  const brokerDir = path.join(W, "broker");
  // Per-run placeholder: NOT a Claude credential; only this run's broker accepts it.
  const clientToken = codex ? `kw-aiand-run-${randomBytes(24).toString("hex")}` : `sk-ant-oat01-kwbroker-${randomBytes(24).toString("hex")}`;
  // Without a usable token the broker holds a synthetic canary (the model call then fails with 401).
  const canaryToken = `sk-ant-oat01-KWCANARY-harness-${randomBytes(16).toString("hex")}`;
  let stderrLog = "";
  let proxyLog = "";
  let brokerLog = "";
  let hooks = "";
  let streamJson = "";
  let gitStatus = "";
  let gitDiff = "";
  let readmeAfter: string | null = null;
  let exitCode: number | null = null;
  let timedOut = false;
  let error: string | null = null;
  let imageId: string | null = null;
  let kernel: KernelObservation | null = null;
  let isolation: IsolationSelfTest | null = null;
  let agentRawStdout = "";
  let codexT: CodexTranslation | null = null;
  const agentImage = codex ? CODEX_IMAGE : AGENT_IMAGE;

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

  try {
    rmSync(W, { recursive: true, force: true });
    mkdirSync(baseline, { recursive: true });
    mkdirSync(after, { recursive: true });
    mkdirSync(policyDir, { recursive: true });
    mkdirSync(brokerDir, { recursive: true });
    writeFileSync(path.join(brokerDir, "client-token"), clientToken, { mode: 0o600 });
    writeFileSync(path.join(brokerDir, "canary-token"), canaryToken, { mode: 0o600 });
    // codex-cli: the ai& key is written to a 0600 file in the per-run dir and bind-mounted into the BROKER only.
    if (codex && token) writeFileSync(path.join(brokerDir, "upstream-token"), token, { mode: 0o600 });

    // Disposable copy + host-held baseline git dir (never mounted into any container).
    for (const f of plan.files) {
      const p = path.join(baseline, f.rel_path);
      if (!p.startsWith(baseline + path.sep)) throw new Error(`unsafe path in snapshot: ${f.rel_path}`);
      mkdirSync(path.dirname(p), { recursive: true });
      writeFileSync(p, f.bytes);
    }
    const gitEnv = { ...process.env, GIT_AUTHOR_DATE: "2026-01-01T00:00:00Z", GIT_COMMITTER_DATE: "2026-01-01T00:00:00Z" };
    const git = (args: string[]) => spawnSync("git", args, { cwd: baseline, env: gitEnv, encoding: "utf8" });
    if (git(["init", "-q", "-b", "main", "."]).status !== 0) throw new Error("git init failed on the host");
    git(["add", "-A", "-f"]);
    if (git(["-c", "user.name=kw-harness", "-c", "user.email=harness@kw.invalid", "commit", "-q", "-m", "baseline"]).status !== 0)
      throw new Error("git baseline commit failed on the host");

    // Policy (one complete merged managed-settings.json), forwarder, allowlist: world-readable, mounted read-only.
    writeFileSync(path.join(policyDir, "managed-settings.json"), plan.policyJson);
    const realForwarder = path.join(plan.repoRoot, "packages", "adapter-claude-code", "bin", "kw-hook.mjs");
    copyFileSync(existsSync(realForwarder) ? realForwarder : path.join(plan.dockerDir, "agent", "kw-hook.placeholder.mjs"), forwarder);
    copyFileSync(path.join(plan.dockerDir, "egress-proxy", codex ? "allowlist.generic.ere" : "allowlist.ere"), allowlist);
    chmodSync(W, 0o755);
    chmodSync(policyDir, 0o755);
    for (const f of [path.join(policyDir, "managed-settings.json"), forwarder, allowlist]) chmodSync(f, 0o644);

    await teardown(); // leftovers of an interrupted run with the same id
    imageId = must(await docker(["image", "inspect", "-f", "{{.Id}}", agentImage], { timeoutMs: 15_000 }), "agent image inspect").stdout.trim() || null;
    must(await docker(["image", "inspect", "-f", "{{.Id}}", PROXY_IMAGE], { timeoutMs: 15_000 }), "proxy image inspect");
    must(await docker(["image", "inspect", "-f", "{{.Id}}", BROKER_IMAGE], { timeoutMs: 15_000 }), "broker image inspect");

    // Networks: internal (no route out) for the agent, a bridge only the proxy joins.
    must(await docker(["network", "create", "--internal", ...labels, n.netInt], { timeoutMs: 30_000 }), "internal network create");
    must(await docker(["network", "create", ...labels, n.netEg], { timeoutMs: 30_000 }), "egress network create");
    const subnet = must(await docker(["network", "inspect", "-f", "{{range .IPAM.Config}}{{.Subnet}}{{end}}", n.netInt], { timeoutMs: 15_000 }), "network inspect").stdout.trim();
    if (!/^[0-9./]+$/.test(subnet)) throw new Error(`unexpected internal subnet "${subnet}"`);

    // Volumes: workspace copy (without .git) and the hook spool.
    must(await docker(["volume", "create", ...labels, n.wsVol], { timeoutMs: 30_000 }), "workspace volume create");
    must(await docker(["volume", "create", ...labels, n.hookVol], { timeoutMs: 30_000 }), "hook volume create");
    const tar = spawnSync("tar", ["-C", baseline, "--exclude", "./.git", "-cf", "-", "."], { env: { ...process.env, COPYFILE_DISABLE: "1" }, maxBuffer: 256 * 1024 * 1024 });
    if (tar.status !== 0) throw new Error("tar of the disposable copy failed");
    must(await volSh(n.wsVol, "/workspace", "rw", "tar -xf - -C /workspace && chown -R 1000:1000 /workspace", tar.stdout), "workspace copy into volume");
    must(await volSh(n.hookVol, "/kw-hooks", "rw", "chown 1000:1000 /kw-hooks && chmod 0700 /kw-hooks"), "hook volume init");

    // Egress proxy (default-deny allowlist), then attach it to the egress bridge.
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
    for (let i = 0; i < 40; i++) {
      const l = await docker(["logs", n.proxy], { timeoutMs: 10_000 });
      if (/listening on fd/.test(l.stdout + l.stderr)) break;
      await new Promise((r) => setTimeout(r, 250));
    }

    // Credential broker: the ONLY holder of the real token (file bind-mounted read-only; docker inspect shows the
    // path, never the value) and the agent's only route to the Claude API.
    must(
      await docker(
        [
          "run", "-d", "--name", n.broker, ...labels, "--network", n.netInt, "--read-only",
          "--cap-drop", "ALL", "--security-opt", "no-new-privileges:true", "--pids-limit", "64", "--memory", "256m",
          "-v", `${token ? (codex ? path.join(brokerDir, "upstream-token") : path.resolve(plan.tokenFile)) : path.join(brokerDir, "canary-token")}:/run/kw-secrets/claude-token:ro`,
          "-v", `${path.join(brokerDir, "client-token")}:/run/kw-secrets/client-token:ro`,
          ...(codex ? ["-e", "KW_BROKER_PROFILE=openai-responses"] : []),
          BROKER_IMAGE,
        ],
        { timeoutMs: 60_000 },
      ),
      "credential broker start",
    );
    must(await docker(["network", "connect", n.netEg, n.broker], { timeoutMs: 30_000 }), "broker egress attach");
    let brokerUp = false;
    for (let i = 0; i < 40 && !brokerUp; i++) {
      const l = await docker(["logs", n.broker], { timeoutMs: 10_000 });
      brokerUp = /"event":"listening"/.test(l.stdout + l.stderr);
      if (!brokerUp) await new Promise((r) => setTimeout(r, 250));
    }
    if (!brokerUp) throw new Error("credential broker did not start");

    // Agent run. Only the broker URL and the per-run placeholder; the placeholder goes by NAME through the docker
    // client's environment (not argv). No real credential is passed to the agent container.
    const proxyUrl = `http://${n.proxy}:8888`;
    const env: NodeJS.ProcessEnv = codex ? { ...process.env, KW_TASK: plan.task, AIAND_API_KEY: clientToken } : { ...process.env, KW_TASK: plan.task, CLAUDE_CODE_OAUTH_TOKEN: clientToken };
    delete env.ANTHROPIC_API_KEY;
    delete env.ANTHROPIC_AUTH_TOKEN;
    if (codex) {
      delete env.OPENAI_API_KEY;
      delete env.CODEX_API_KEY;
      delete env.CLAUDE_CODE_OAUTH_TOKEN;
    }
    // EXPERIMENTAL codex-cli: no /etc/claude-code, hook forwarder/spool or Claude env; only the broker URL + placeholder.
    const codexArgs = [
        "--name", n.agent, ...labels, "--network", n.netInt, "--user", "1000:1000", "--init",
        "--cap-drop", "ALL", "--security-opt", "no-new-privileges:true", "--pids-limit", "512", "--memory", "2g",
        "-v", `${n.wsVol}:/workspace`,
        "-e", "KW_TASK", "-e", `KW_MODEL=${plan.model}`, "-e", `KW_LLM_BASE_URL=http://${n.broker}:8080/v1`, "-e", "AIAND_API_KEY",
        ...(process.env.KW_SCRIPTED_AGENT === "1" ? ["-e", "KW_SCRIPTED_AGENT=1"] : []),
        "-e", `HTTPS_PROXY=${proxyUrl}`, "-e", `HTTP_PROXY=${proxyUrl}`, "-e", `https_proxy=${proxyUrl}`, "-e", `http_proxy=${proxyUrl}`,
        "-e", `NO_PROXY=localhost,127.0.0.1,${n.broker}`, "-e", `no_proxy=localhost,127.0.0.1,${n.broker}`,
    ];
    const claudeArgs = [
        "--name", n.agent, ...labels, "--network", n.netInt, "--user", "1000:1000", "--init",
        "--cap-drop", "ALL", "--security-opt", "no-new-privileges:true", "--pids-limit", "512", "--memory", "2g",
        "-v", `${n.wsVol}:/workspace`, "-v", `${n.hookVol}:/kw-hooks`,
        "-v", `${policyDir}:/etc/claude-code:ro`, "-v", `${forwarder}:/opt/kw/kw-hook.mjs:ro`,
        "-e", "KW_TASK", "-e", `KW_MODEL=${plan.model}`, "-e", `KW_MAX_TURNS=${plan.maxTurns}`, "-e", "KW_HOOK_LOG=/kw-hooks/hooks.ndjson",
        "-e", `HTTPS_PROXY=${proxyUrl}`, "-e", `HTTP_PROXY=${proxyUrl}`, "-e", `https_proxy=${proxyUrl}`, "-e", `http_proxy=${proxyUrl}`,
        "-e", `NO_PROXY=localhost,127.0.0.1,${n.broker}`, "-e", `no_proxy=localhost,127.0.0.1,${n.broker}`,
        "-e", `ANTHROPIC_BASE_URL=http://${n.broker}:8080`, "-e", "CLAUDE_CODE_OAUTH_TOKEN",
    ];
    const agentArgs = codex ? codexArgs : claudeArgs;
    // P11 (per run): install the netguard allowlist in the agent's netns and self-test it; false => never release.
    const isolateBeforeRelease = async (): Promise<boolean> => {
      isolation = await guardAndSelfTest(docker, { agent: n.agent, network: n.netInt, peers: [{ name: n.proxy, port: 8888 }, { name: n.broker, port: 8080 }], labels });
      return isolation.status === "passed";
    };
    const agentOpts = { env, timeoutMs: plan.timeoutMs, onTimeout: () => void docker(["kill", n.agent], { timeoutMs: 15_000 }) };
    let agent: Cmd;
    if (plan.kernel) {
      // Paused start under Tetragon (observers/tetragon-run.ts): create with the entrypoint held behind a gate,
      // attach, start, [load kernel enforcement], release the gate.
      must(await docker(["create", ...agentArgs, ...GATE_ENTRYPOINT_ARGS, agentImage, ...GATE_COMMAND], { env, timeoutMs: 60_000 }), "agent container create");
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
        releaseGate: async () => (await isolateBeforeRelease()) && (await docker(["exec", n.agent, "touch", GATE_FILE], { timeoutMs: 20_000 })).code === 0,
        kill: async () => void (await docker(["kill", n.agent], { timeoutMs: 15_000 })),
      });
      kernel = k.observation;
      agent = k.result ?? { code: null, stdout: "", stderr: "", timedOut: false };
      if (!k.result && isolation && (isolation as IsolationSelfTest).status !== "passed") throw new Error(`agent not started: isolation self-test ${(isolation as IsolationSelfTest).detail}`);
      if (!k.result && !error) throw new Error(`kernel observer: ${k.observation.reason || k.observation.errors.join("; ") || "agent not started"}`);
    } else {
      // Same gated start as the kernel path (without Tetragon), so the network guard + self-test run before the
      // agent's entrypoint executes.
      must(await docker(["create", ...agentArgs, ...GATE_ENTRYPOINT_ARGS, agentImage, ...GATE_COMMAND], { env, timeoutMs: 60_000 }), "agent container create");
      const started = docker(["start", "-a", n.agent], agentOpts);
      let running = false;
      for (let i = 0; i < 100 && !running; i++) {
        const r = await docker(["inspect", "-f", "{{.State.Running}}", n.agent], { timeoutMs: 10_000 });
        running = r.stdout.trim() === "true";
        if (!running) await new Promise((res) => setTimeout(res, 100));
      }
      if (!running || !(await isolateBeforeRelease()) || (await docker(["exec", n.agent, "touch", GATE_FILE], { timeoutMs: 20_000 })).code !== 0) {
        await docker(["kill", n.agent], { timeoutMs: 15_000 });
        await started;
        throw new Error(`agent not started: ${!running ? "container did not reach running state" : `isolation self-test ${(isolation as IsolationSelfTest | null)?.detail ?? "did not run"}`}`);
      }
      agent = await started;
    }
    exitCode = agent.code;
    timedOut = agent.timedOut;
    streamJson = agent.stdout;
    stderrLog = agent.stderr;
    if (codex) {
      // Codex's own JSONL (AGENT-REPORTED) -> Claude-stream-json shape for evaluateCaptures(); raw kept separately.
      agentRawStdout = agent.stdout;
      codexT = translateCodexJsonl(agent.stdout, { model: plan.model, codexVersion: CODEX_VERSION });
      streamJson = codexT.streamJson;
    }

    // Collect on the host.
    hooks = (await volSh(n.hookVol, "/kw-hooks", "ro", "cat /kw-hooks/hooks.ndjson 2>/dev/null; true")).stdout;
    const out = spawn("docker", ["run", "--rm", ...labels, "--network", "none", "--user", "0", "--entrypoint", "sh", "-v", `${n.wsVol}:/workspace:ro`, AGENT_IMAGE, "-c", "tar -cf - -C /workspace ."], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    const untar = spawn("tar", ["-xf", "-", "-C", after], { stdio: ["pipe", "ignore", "pipe"] });
    out.stdout.pipe(untar.stdin);
    await new Promise<void>((resolve) => untar.on("close", () => resolve()));
    const pl = await docker(["logs", "--timestamps", n.proxy], { timeoutMs: 20_000 });
    proxyLog = pl.stdout + pl.stderr;
    const bl = await docker(["logs", n.broker], { timeoutMs: 20_000 });
    brokerLog = bl.stdout + bl.stderr;

    // Git diff of the after-tree against the host-held baseline (the container's own .git, if any, is ignored).
    const g = (args: string[]) => spawnSync("git", ["--git-dir", path.join(baseline, ".git"), "--work-tree", after, ...args], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    g(["add", "-A", "-f"]);
    gitStatus = g(["status", "--porcelain", "--untracked-files=all"]).stdout ?? "";
    gitDiff = g(["diff", "--cached", "--no-color", "--stat", "--patch"]).stdout ?? "";
    const readmePath = path.join(after, "README.md");
    // lstat: never follow a symlink the agent may have planted in the disposable tree.
    readmeAfter = existsSync(readmePath) && lstatSync(readmePath).isFile() ? readFileSync(readmePath, "utf8") : null;
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  } finally {
    await teardown();
    rmSync(W, { recursive: true, force: true });
  }

  let tokenHit = false;
  const clean = (t: string) => {
    const r = scrub(t, token);
    const c = scrub(r.text, canaryToken);
    const p = scrub(c.text, clientToken);
    tokenHit ||= r.hit || c.hit;
    return p.text;
  };
  const captures: HarnessCaptures = {
    streamJson: clean(streamJson),
    hooks: clean(hooks),
    proxyLog: clean(proxyLog),
    gitStatus: clean(gitStatus),
    gitDiff: clean(gitDiff),
    readmeAfter: readmeAfter === null ? null : clean(readmeAfter),
    exitCode,
    timedOut,
    error: error === null ? null : clean(error),
  };
  return {
    captures,
    stderr: clean(stderrLog),
    imageId,
    tokenScan: tokenHit ? "scrubbed" : token ? "clean" : "no-token",
    authenticated: token !== null,
    kernel,
    brokerLog: clean(brokerLog),
    isolation,
    ...(codex
      ? { agentRawStdout: clean(agentRawStdout), codex: codexT ? { commands: codexT.commands.map((c) => ({ ...c, command: clean(c.command) })), finalMessage: codexT.finalMessage === null ? null : clean(codexT.finalMessage), warnings: codexT.warnings.map(clean), failed: codexT.failed, parseErrors: codexT.parseErrors } : null }
      : {}),
  };
};
