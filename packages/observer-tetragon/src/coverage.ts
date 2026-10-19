import type { CoverageCategoryEntry, CoverageReport, CoverageSourceEntry } from "@kw/schema";

export interface TetragonCoverageFragment {
  /** Schema-shaped fragment (merge into the run's CoverageReport). */
  report: Partial<CoverageReport> & { sources: CoverageSourceEntry[]; categories: CoverageCategoryEntry[] };
  observed: string[];
  not_established: string[];
  attribution: { available: boolean; fields: string[]; note: string };
  enforcement: { active_policies: string[]; mechanism: string; note: string };
  /** Tetragon loss counters rose during the capture window: events may be missing from this slice. */
  lossy: boolean;
}

export function coverageFragment(input: {
  active: boolean;
  errors: string[];
  observationPolicies: string[];
  enforcementPolicies: string[];
  counts?: Partial<Record<"process" | "file" | "net", number>>;
  /** Per-run delta of the Tetragon loss counters (null = not measured). */
  loss?: Record<string, number> | null;
}): TetragonCoverageFragment {
  const lossy = !!input.loss && Object.values(input.loss).some((v) => v !== 0);
  const lossNote = lossy
    ? `LOSSY: Tetragon loss counters rose during this capture (VM-wide, may include other containers): ${Object.entries(input.loss!)
        .filter(([, v]) => v !== 0)
        .map(([k, v]) => `${k.replace(/^tetragon_/, "")} +${v}`)
        .join(", ")}. Events may be missing; absence of an event proves nothing. `
    : "";
  const filesOn = input.observationPolicies.includes("kw-observe-files");
  const netOn = input.observationPolicies.includes("kw-observe-net");
  const n = (k: "process" | "file" | "net") => (input.counts?.[k] !== undefined ? ` ${input.counts[k]} events captured.` : "");
  const categories: CoverageCategoryEntry[] = [
    {
      category: "process_execution",
      status: input.active ? "observed" : "unavailable",
      note: `Tetragon execve sensor: exec/exit with pid, ppid, exec_id/parent_exec_id lineage, binary, args, cwd, uid, container id.${n("process")}`,
    },
    {
      category: "file_access",
      status: input.active && filesOn ? "partial" : "unavailable",
      note: filesOn
        ? `File opens and read() permission checks for policy-selected paths only (/workspace/, /home/, /root/, canary dirs, *.env, *.pem, *.key, ssh keys...). Open succeeded does not prove content was read; mmap reads are not observed by the read hook.${n("file")}`
        : "kw-observe-files is not loaded.",
    },
    {
      category: "file_modification",
      status: input.active && filesOn ? "partial" : "unavailable",
      note: filesOn ? "write() permission checks on selected paths only; resulting file content/changes are not established (use the repository diff observer)." : "kw-observe-files is not loaded.",
    },
    {
      category: "network",
      status: input.active && netOn ? "partial" : "unavailable",
      note: netOn
        ? `TCP connect attempts (SYN sent) with destination IP:port, non-loopback.${n("net")} Handshake result, bytes transferred, hostnames, UDP/DNS are not observed.`
        : "kw-observe-net is not loaded.",
    },
  ];
  if (lossy)
    for (const c of categories) {
      if (c.status === "observed") c.status = "partial";
      if (c.status !== "unavailable") c.note = lossNote + (c.note ?? "");
    }
  const sources: CoverageSourceEntry[] = [
    {
      source: "kernel_tracer",
      active: input.active,
      categories: categories.filter((c) => c.status !== "unavailable").map((c) => c.category),
      attribution_available: input.active,
      errors: input.errors,
    },
  ];
  return {
    report: {
      sources,
      categories,
      unsupported_capabilities: [
        "File content actually read (only open / read-permission checks are observed)",
        "Bytes transferred over the network (only connect attempts)",
        "mmap() reads (not hooked)",
        "Activity outside the attached container (other containers, the Docker VM, the macOS host)",
        "File paths outside the kw-observe-files selectors",
        "UDP / DNS queries",
      ],
      network_outcomes_observable: false,
    },
    observed: [
      "process exec/exit with lineage (exec_id, parent_exec_id, pid, ppid, binary, args, cwd, uid)",
      ...(filesOn ? ["file access attempts with resolved container paths (open, read()/write() permission checks)"] : []),
      ...(netOn ? ["network connect attempts (tcp_connect daddr:dport)"] : []),
      ...(input.enforcementPolicies.length ? ["file opens, and renames/hard links of protected names, denied by Underwatch enforcement policies (labeled blocked)"] : []),
    ],
    not_established: [
      "content actually read from a file",
      "bytes transferred on a connection, or that the connection completed",
      "mmap reads unless hooked",
      "activity outside the container",
      "events lost in the kernel ring buffer are counted VM-wide only (see stats.kernel_loss)",
      "a missing event is not proof the action did not happen",
      ...(lossy ? ["completeness of this capture: Tetragon reported lost/overflowed events during the window"] : []),
    ],
    attribution: {
      available: input.active,
      fields: ["pid", "ppid", "exec_id", "parent_exec_id", "binary", "args", "cwd", "uid", "container id (31-char prefix)"],
      note: "Pids are Docker Desktop VM pids, not container-local pids. Tool-call attribution is derived by walking exec ancestry to the agent's tool shell.",
    },
    lossy,
    enforcement: {
      active_policies: input.enforcementPolicies,
      mechanism: "Tetragon BPF-LSM file_open + inode_rename + inode_link Override (EPERM), scoped by pid-namespace inode",
      note: "Blocked = a process_lsm Override event emitted by one of these policies. Plain EPERM/EACCES without our policy is reported as failed. Path-based: file descriptors opened before the policy loaded are not revoked, and paths not listed are not protected.",
    },
  };
}
