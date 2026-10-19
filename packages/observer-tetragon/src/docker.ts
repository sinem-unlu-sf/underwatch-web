import { execFile } from "node:child_process";

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Run the docker CLI (argv, no shell). Never throws; a missing binary yields code 127. */
export function docker(args: string[], opts: { timeoutMs?: number; input?: string } = {}): Promise<ExecResult> {
  return new Promise((resolvePromise) => {
    const child = execFile(
      "docker",
      args,
      { timeout: opts.timeoutMs ?? 60_000, maxBuffer: 64 * 1024 * 1024, encoding: "utf8" },
      (err, stdout, stderr) => {
        let code = 0;
        if (err) {
          const e = err as NodeJS.ErrnoException & { code?: unknown };
          code = typeof e.code === "number" ? e.code : e.code === "ENOENT" ? 127 : 1;
        }
        resolvePromise({ code, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
      },
    );
    if (opts.input !== undefined) {
      child.stdin?.end(opts.input);
    }
  });
}

export async function dockerOk(args: string[], what: string, opts: { timeoutMs?: number; input?: string } = {}): Promise<string> {
  const r = await docker(args, opts);
  if (r.code !== 0) throw new Error(`${what} failed (docker ${args.slice(0, 3).join(" ")} ... exit ${r.code}): ${r.stderr.trim() || r.stdout.trim()}`);
  return r.stdout;
}

export interface ContainerInfo {
  id: string;
  name: string;
  running: boolean;
  /** Pid of the container's init in the Docker Desktop VM pid namespace; 0 when not running. */
  pid: number;
  image: string;
  privileged: boolean;
  pidMode: string;
  networkMode: string;
  capAdd: string[];
  /** Bind/volume mount sources as reported by Docker (host paths for binds on Docker Desktop). */
  mountSources: Array<{ source: string; destination: string; type: string }>;
}

export async function inspectContainer(ref: string): Promise<ContainerInfo | null> {
  const r = await docker(["inspect", "--type", "container", "-f", "{{json .}}", ref], { timeoutMs: 15_000 });
  if (r.code !== 0) return null;
  const j = JSON.parse(r.stdout) as {
    Id: string;
    Name: string;
    State: { Running: boolean; Pid: number };
    Config: { Image: string };
    HostConfig?: { Privileged?: boolean; PidMode?: string; NetworkMode?: string; CapAdd?: string[] | null };
    Mounts?: Array<{ Source?: string; Destination?: string; Type?: string }> | null;
  };
  return {
    id: j.Id,
    name: j.Name.replace(/^\//, ""),
    running: j.State.Running,
    pid: j.State.Pid,
    image: j.Config.Image,
    privileged: j.HostConfig?.Privileged === true,
    pidMode: j.HostConfig?.PidMode ?? "",
    networkMode: j.HostConfig?.NetworkMode ?? "",
    capAdd: j.HostConfig?.CapAdd ?? [],
    mountSources: (j.Mounts ?? []).map((m) => ({ source: m.Source ?? "", destination: m.Destination ?? "", type: m.Type ?? "" })),
  };
}

/**
 * Reasons the given (agent) container could see, tamper with, or escape the observer. Empty = none found.
 * Evidence independence requires: no docker socket, not privileged, own pid namespace, no observer data mount,
 * no capabilities that allow BPF/ptrace/admin, and no shared namespace with kw-tetragon.
 */
export function isolationViolations(info: ContainerInfo, observerDataDir: string, observerContainer: string): string[] {
  const out: string[] = [];
  if (info.privileged) out.push("container is --privileged");
  if (info.pidMode === "host") out.push("container shares the host pid namespace (--pid=host)");
  if (info.pidMode.startsWith("container:")) out.push(`container shares a pid namespace (${info.pidMode})`);
  if (info.networkMode === `container:${observerContainer}`) out.push("container shares kw-tetragon's network namespace");
  const caps = info.capAdd.map((c) => c.toUpperCase().replace(/^CAP_/, ""));
  for (const c of ["ALL", "SYS_ADMIN", "BPF", "PERFMON", "SYS_PTRACE", "SYS_MODULE"]) if (caps.includes(c)) out.push(`container has CAP_${c}`);
  const norm = (p: string) => p.replace(/^\/host_mnt(?=\/)/, "").replace(/\/+$/, "") || "/";
  const data = norm(observerDataDir);
  for (const m of info.mountSources) {
    const src = norm(m.source);
    if (/docker\.sock$/.test(src) || /docker\.sock$/.test(m.destination)) out.push(`docker socket mounted (${m.source} -> ${m.destination})`);
    if (m.type !== "bind" || !src.startsWith("/")) continue;
    if (src === data || data.startsWith(src === "/" ? "/" : src + "/") || src.startsWith(data + "/")) {
      out.push(`mount ${m.source} -> ${m.destination} exposes the observer evidence directory ${observerDataDir}`);
    }
  }
  return out;
}
