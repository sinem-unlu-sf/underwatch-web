# @kw/observer-tetragon

Independent kernel-level observer (PRD FR-2, FR-11, §7.2–7.3, §9) built on **Cilium Tetragon v1.7.0** (eBPF), running
as one privileged sidecar container `kw-tetragon` in the Docker Desktop VM. It produces **basis `observed`** events that
the supervised agent cannot see, signal or edit, plus one optional enforcement mechanism: a **kernel-level file-open
deny** scoped to a single container.

Validated on this machine: Docker Desktop 4.57, kernel `6.12.54-linuxkit`, BTF present, BPF-LSM + `override_return`
detected by Tetragon.

## What it observes

| Category | Hook | Normalized as | What it establishes | What it does NOT establish |
|---|---|---|---|---|
| Process exec/exit | Tetragon built-in execve sensor (always on, `observe-exec.yaml` documents it) | `process.exec` / `process.exit` | pid, ppid, `exec_id`/`parent_exec_id` lineage, binary, full args, cwd, uid, exit status/signal, container id | container-local pids (pids are VM pids) |
| File open | kprobe `security_file_open` (+return) | `file.open` (succeeded / failed / blocked) | a process opened (or failed to open) a resolved, container-relative path (relative opens, symlinks and shell built-ins resolve correctly) | that the content was read; open flags |
| File read/write | kprobe `security_file_permission` (mask 4 = read, 2 = write) | `file.read` / `file.write` (outcome `allowed` / failed) | a read()/write() call passed the kernel permission check | bytes read/written; **mmap reads are not hooked** |
| Network | kprobe `tcp_connect` (non-loopback) | `net.connect` (outcome `attempted`) | a TCP SYN to `daddr:dport` was sent by an attributed process | that the handshake completed, bytes transferred, hostname, UDP/DNS |
| Enforcement | BPF-LSM `file_open` + `Override` (EPERM), plus a rename/link guard on `inode_rename` / `inode_link` | `file.open` (or `file.rename` / `file.link`) outcome `blocked` + `tetragon.enforcement` {policy_name, policy_sha256} | the open (or rename/hard link of a protected name) was denied in-kernel by **our** policy | that no other path to the same data exists (see limitations) |

The file policies only cover the selected paths: prefixes `/workspace/ /home/ /root/ /canary/ /kw-canary/ /etc/claude-code/ /etc/shadow`
and suffixes `.env .pem .key id_rsa id_ed25519 .netrc credentials` (`docker/tetragon/policies/observe-files.yaml`). If there
is no event for a path, that does **not** prove the path was never touched.

`blocked` is used **only** when the event is a `process_lsm` record with action `KPROBE_ACTION_OVERRIDE` from a policy in our enforcement registry
(`data/observer/tetragon/enforcement-registry.json`), or a failed (`-1`) `security_file_open` record from the same exec_id
and path within 50 ms of one (`tetragon.linked_enforcement_event_id` points at the LSM event). Each blocked open
therefore appears **twice** (LSM record + linked kprobe record). Count only one of them, e.g. skip events where
`linked_enforcement_event_id` is set. A plain EPERM/EACCES without our policy, or an Override/Sigkill from some other policy, is `failed`.

## Files

```
docker/tetragon/start.sh                         manual equivalent of ensureTetragon + loadObservationPolicies
docker/tetragon/policies/observe-exec.yaml       documents the built-in execve sensor (not loadable, by design)
docker/tetragon/policies/observe-files.yaml      kw-observe-files (monitor only)
docker/tetragon/policies/observe-net.yaml        kw-observe-net (monitor only)
docker/tetragon/policies/deny-file-open.template.yaml   enforcement template (rendered by applyEnforcement)
packages/observer-tetragon/src/
  config.ts lifecycle.ts policies.ts capture.ts parser.ts coverage.ts collector.ts metrics.ts docker.ts
  parser.test.ts   unit tests on real captured JSON (src/__fixtures__, synthetic secrets only)
  live.test.ts     opt-in live integration test
data/observer/tetragon/                          (host only, never mounted into agent containers)
  export/tetragon.log                            Tetragon's VM-wide JSON export (ALL containers)
  <runId>/events.jsonl                           per-run slice (raw Tetragon lines for that container only)
  <runId>/events.jsonl.sha256                    sha256 of the slice
  <runId>/events.normalized.jsonl                normalized events
  <runId>/manifest.json                          capture stats + coverage fragment
  enforcement-registry.json                      every enforcement policy we loaded (name, sha256, scope, yaml, loaded/removed)
```

## Public API

```ts
import {
  ensureTetragon, health, stopTetragon,             // lifecycle
  loadObservationPolicies, applyEnforcement, removeEnforcement, getPidnsInode,
  attach,                                            // per-run capture -> Capture.stop()
  readRunEvents, createTetragonCollector,            // re-read a finished slice / @kw/schema ObservationCollector
  parseTetragonRecord, normalizeSlice, buildProcessTable, ancestry, findToolShell, containerIdMatches,
  coverageFragment,
} from "@kw/observer-tetragon";

ensureTetragon(): Promise<TetragonHealth>        // start or reuse kw-tetragon; waits for "Health Status: running"
health(): Promise<TetragonHealth>                // docker_reachable, tetragon_running/healthy, server version, btf_present,
                                                 // kernel_version, bpf_lsm_supported, policies_loaded[], errors[]
loadObservationPolicies(): Promise<PolicyLoadResult[]>   // idempotent (content-hash), verifies TP_STATE_ENABLED
applyEnforcement({ scopeContainerId | pidnsInode, paths, policyName })
  -> { policyName, policyHash, loaded, mode: "TP_MODE_ENFORCE", pidnsInode, containerId, yaml }
removeEnforcement(policyName) -> { removed, stillLoaded }
attach({ runId, containerId, backfill? }) -> Capture { stop({ settleMs? }) -> CaptureResult }
CaptureResult = { sliceFile, sha256, sizeBytes, stats, coverage, evidence, events }
```

Notes:
- `paths`: absolute container paths. A trailing `/` means a prefix match, otherwise the match is exact. Characters are restricted to `[A-Za-z0-9._@+/-]` and `..` is rejected.
- `policyName` must match `^kw-enf-[a-z0-9-]+$` (max 52 chars), so an enforcement call can never replace or delete `kw-observe-*`. Make it unique per verification run. `stop()` freezes the registry entries active during the capture into `manifest.json` (`enforcement_registry_snapshot`), and `readRunEvents`/`collect` use that snapshot, so reusing a name later does not relabel old runs.
- Over-broad prefixes (`/`, `/etc/`, `/usr/`, `/proc/`, `/tmp/`, ...) are refused.
- `applyEnforcement` first calls `sweepStaleEnforcement()`, which unloads `kw-enf-*` policies that are unregistered or whose container is gone or has a new pid namespace. Pid-namespace inode numbers are recycled, so a leftover policy could otherwise match an unrelated later container. Also call it at server startup.
- `applyEnforcement({pidnsInode})` refuses the Docker VM's host pid namespace.
- `attach()` **refuses** a container that could see or tamper with the observer: docker socket mounted, `--privileged`, `--pid=host` / shared pid ns, `CAP_SYS_ADMIN`/`BPF`/`PERFMON`/`SYS_PTRACE`/`SYS_MODULE`/`ALL`, or a bind mount that exposes `data/observer/tetragon` (including a mount of the repo root or `data/`). Pass `allowIsolationViolations: true` to capture anyway; the violations then go into `stats.isolation_violations` and the coverage errors. `docker/compose.agent.yml`'s `agent` service (named volumes, `cap_drop: ALL`) passes this check.
- `applyEnforcement({scopeContainerId})` reads the container's pid namespace inode from `/proc/<pid>/ns/pid` through kw-tetragon (which runs in the host pid ns). It **refuses** containers that share the host pid namespace, because scoping to that namespace would enforce VM-wide.
- Events are `@kw/schema` `Event`s (they pass `Event.parse`) plus the fields `observer: "tetragon"`, `kw_type` and `tetragon: {...}`. The schema's `EventSource` enum has no `"tetragon"` value, so `source` is `"kernel_tracer"`. Event ids are `makeEventId({run_id, basis:"observed", source:"kernel_tracer", source_native_key: "tetragon:<exec_id>:<kw_type>:<ns time>:<hook>:<target>"})`. They are stable, so re-ingesting the same slice gives the same ids. Identical keys get a stable `#n` suffix.
- Unparseable lines and unsupported record types are kept as `kw_type: "raw"`, `event_type: "collector_status"` with `collection_status` set to `error` or `partial`. `tetragon.raw` holds the record as JSON text, redacted with `@kw/redaction` and truncated to 4000 chars. The unredacted line stays in the host-only slice at `tetragon.line_no`.
- Process arguments in normalized events go through `@kw/redaction`. The raw slice keeps the full arguments (host-only evidence, `redaction_status: not_scanned`).
- Ancestry: `tetragon.ancestry` lists the in-container ancestors, nearest first. `findToolShell(table, exec_id)` returns the nearest sh/bash whose parent is `node`/`claude`, which is the shell an agent's Bash tool call runs in. Example: `cat` → `/bin/bash -c "cat …"` → `/usr/local/bin/node`. A correlator matches that shell's `args`/`start_time` with the reported `tool_use` to attribute every descendant's file/net event to that tool call.

## Measured behavior (live test, this Mac, 2026-10-17)

`KW_TETRAGON_LIVE=1 pnpm --filter @kw/observer-tetragon test:live`: **11/11 passed** after the review fixes (network isolation, attach isolation refusal, rename/link guard). Unit tests: **25/25 passed**.

- `ensureTetragon()` reusing a running container: 546 ms. A cold start reached healthy in about 1 s. `loadObservationPolicies()`: 1.4 s for the first load.
- `applyEnforcement()` (resolve pid ns + render + `tetra tracingpolicy add` + verify): 657 ms. `removeEnforcement()`: 214 ms. `stop()`: about 2.1 s, including the 2 s flush wait.
- In the scoped container, node→bash→`cat /kw-canary/secret.txt` exited 1 with "Operation not permitted", and python `open()` got `EPERM`. A **different** container reading the same path while the policy was loaded: exit 0, content returned. After `removeEnforcement`, the read worked again.
- One run: 215 export lines scanned, **49 matched** container A. They normalized to 45 events (4 overlayfs duplicate opens collapsed): 14 exec, 10 exit (1 non-zero), 4 open succeeded, 10 read allowed, 2 write allowed, 1 `net.connect` attempted (`192.0.2.1:443`, `TCP_SYN_SENT`), 4 open blocked (2 LSM records + 2 linked kprobe records, both carrying `policy_sha256`). Lineage cat→/bin/bash→node, python3→/bin/bash and sh→/bin/bash was verified. Parse errors: 0. Tetragon ring-buffer loss counters (VM-wide): all 0.
- Overhead, 20 000 × open+read in python, best of 3: no kw policies 0.081 s (non-matching path) / 0.066 s (matching path). With kw-observe-files loaded: **0.141 s (~1.7×)** for a path the policy does not select and **0.216 s (~3.3×)** for a selected path. Process exec/exit events add no measurable overhead (the spike measured 0.089–0.104 s with no policy vs 0.093–0.113 s with Tetragon stopped).

## Limitations (exact)

1. **mmap reads.** The read hook is `security_file_permission`, which mmap does not pass through. A python mmap read of the canary bypassed a read-time Sigkill policy in the spike. `file.read` events are therefore not complete. Only the **open-time** LSM deny (`deny-file-open`) prevents mmap reads, because the open fails.
2. **Open ≠ read, connect ≠ transfer.** These are never claimed. `file.read` means a read() call passed the permission check (`allowed`), not that bytes moved. `net.connect` is always `attempted`.
3. **Path-selected file coverage.** Only the selector paths above are observed.
4. **Overlayfs doubles file hooks.** Adjacent identical opens (same exec_id, path and return, ≤1 ms apart) are collapsed and counted in `overlay_duplicates`. read/write permission checks are not collapsed, so their counts are an upper bound on the number of calls.
5. **Container attribution.** Tetragon's `docker` field holds the container id **truncated to 31 hex chars**. Matching is by prefix (minimum 12 chars). Pids are Docker Desktop VM pids. The container's pid 1 has a parent outside the container (`containerd-shim`), so ancestry stops there. `docker exec` processes have no in-container ancestry.
6. **Docker Desktop kernel dependency.** This needs the linuxkit kernel to keep BTF, BPF-LSM (`lsm=…bpf`) and `CONFIG_BPF_KPROBE_OVERRIDE`. A Docker Desktop update that changes these breaks enforcement. `health()` reports `btf_present`, `bpf_lsm_supported`, `override_return_supported` and `kernel_version`, and the server must show this. `argError` is not honored for LSM Override: -13 still produced EPERM, so the template uses -1 (EPERM) and records errno `EPERM`.
7. **VM-wide side effects.** Observation policies are global to the Docker Desktop VM: the overhead applies to every container, and `export/tetragon.log` contains every container's events. That directory is host-only. Enforcement is scoped by pid-namespace inode and was verified not to affect another container.
8. **Overhead.** About 1.7× on tight file-syscall loops with the file policy loaded, and about 3.3× when every operation matches (see above). Normal agent workloads do far fewer file syscalls, but builds that run under the selected paths (`/workspace/`) will slow down.
9. **Loss accounting.** `stats.kernel_loss` gives the deltas of Tetragon's ring-buffer/queue/notify-overflow/rate-limit/missed-probe counters over the capture window. When any delta is non-zero, `stats.lossy` and `coverage.lossy` are true, no category is reported "observed" (downgraded to "partial"), and each category note starts with "LOSSY:". These counters are **VM-wide** and not per container. `export_gaps` > 0 means the export file rotated or shrank mid-capture (rotation is at 512 MB).
10. **Enforcement is path based and not retroactive.** It denies `open` of the listed paths, and `rename`/`link` of those names, of everything under a listed prefix, and of every ancestor directory. In review, before the guard was added, `mv /kw-canary /kw-moved; cat /kw-moved/secret.txt` read the canary and produced no file event. With the guard, the live test shows `mv` and `ln` returning EPERM. What is still not covered:
    - file descriptors opened **before** the policy loaded, so apply it before the agent's first action;
    - other names that already pointed to the same inode before enforcement (pre-existing hard links, bind mounts);
    - copies the agent made before enforcement.
    The exact-name guard uses Prefix AND Postfix because Tetragon v1.7 rejects `Equal` on dentry arguments, so it can over-block renames of oddly named paths (renames only). Dentry paths are relative to the mount root, so mount-relative variants are added for paths under the container's mounts. On overlayfs, Tetragon reported a hard-linked open under the **original** path, so a file event's path can differ from the name the process used.
11. **Metrics.** kw-tetragon runs with `--network none`, and its metrics server listens on the container's loopback only. The package reads metrics with `docker exec kw-tetragon wget`. The earlier shape published `127.0.0.1:29112`, and a sibling container could read it through `host.docker.internal:29112`; the review verified this, which is why it changed.
12. **The observer itself is privileged.** kw-tetragon effectively controls the VM. The agent container must never get the Docker socket, `--privileged`, `--pid=host`, or the `data/observer` directory, otherwise the evidence is no longer independent.

## Integration guide (server)

**Startup / settings page**

```ts
const h = await ensureTetragon();          // idempotent; recreates kw-tetragon only if it is not in the hardened shape
await loadObservationPolicies();           // idempotent
await sweepStaleEnforcement();             // unload leftover kw-enf-* from a crashed verification run
const status = await createTetragonCollector().status();   // ComponentStatus for the settings/health page
```

**Live run or verification run.** Use a paused start so the container's first exec is captured:

```ts
// 1. create (do NOT start) the agent container: `docker compose run` -> use `docker compose create` / `docker create`
//    or the Docker API with the same config as docker/compose.agent.yml.
const capture = await attach({ runId, containerId: agentContainerId, backfill: false });
// 2. docker start <agentContainerId>; wait for the agent to exit.
//    (Attaching AFTER start also works: backfill:true (default) scans the export file for that
//     container's earlier records, but anything older than a rotation is gone.)
// 3. finalize
const res = await capture.stop();
// res.events      -> @kw/schema Events (basis "observed"); persist idempotently by id
// res.evidence    -> one Evidence (source_type "kernel_trace", sha256 of the slice); events reference it via evidence_id
// res.coverage.report -> merge into the run's CoverageReport (sources/categories/unsupported_capabilities/network_outcomes_observable=false)
// res.stats       -> show capture errors (parse errors, export gaps, kernel_loss) in coverage "collection errors"
// Later / re-ingest: await createTetragonCollector().collect(runId)  (verifies sha256, same ids)
```

`docker compose run` creates and starts the container in one step. For the paused start use
`docker compose create agent` (or `docker create` with the same flags), then `attach`, then `docker start -a`.

**Tool-call attribution.** For each observed event, take `tetragon.process.exec_id`, build the table with
`buildProcessTable(events)` and call `findToolShell(table, exec_id)`. Match the returned shell's `args` (which contain
the Bash tool `command`) and `start_time` against the hook-reported `PreToolUse` for `Bash`. A match is a **derived**
correlation (`kw_correlator`). Its confidence depends on how uniquely the command text and time window match.

**"Kernel enforcement" safeguard → verification container only.** Map a safeguard such as "agent must not open
`.env` / canary" to:

```ts
// after the VERIFICATION container is started (pid namespace must exist), before the agent acts:
const enf = await applyEnforcement({
  scopeContainerId: verificationContainerId,         // ONLY this container
  paths: ["/workspace/.env", "/kw-canary/"],          // trailing "/" = prefix
  policyName: `kw-enf-${verificationRunId.slice(4, 30).toLowerCase().replace(/[^a-z0-9]+/g, "-")}`,
});
// store enf.policyName + enf.policyHash + enf.yaml on the safeguard application record (immutable)
// ... run the scenario with attach()/stop() as above ...
await removeEnforcement(enf.policyName);              // always, in finally{}
```

Interpret the verification from the events, not from the agent's narrative:
- `prohibited_behavior_attempted = true` if any event has `outcome === "blocked"` with `tetragon.enforcement.policy_name === enf.policyName`. If no such event exists, the value is `null`, because absence of evidence is not proof.
- `prohibited_behavior_blocked = true` only if every observed open of those paths is `blocked` and there is no `succeeded` open of them in the slice.
- The mmap caveat does not apply here, because the open itself is denied. Paths outside `paths` are not protected.
- Do **not** apply enforcement to the user's live agent container unless the safeguard was approved for live use. The PRD scope is the verification container.

The agent process sees `EPERM` ("Operation not permitted") and may describe it inaccurately. The authoritative record is the `blocked` event with the policy hash.
