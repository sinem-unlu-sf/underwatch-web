# Underwatch base managed policy (agent container)

`managed-settings.json` is the base Claude Code **managed** policy. At run time the host
copies this directory into a per-run policy dir, adds an (optional) `managed-settings.d/`
with per-run / per-safeguard drop-ins (e.g. `50-kw-sg_<id>.json`), and bind-mounts the
whole dir **read-only** at `/etc/claude-code/` in the agent container.

- Path: `/etc/claude-code/managed-settings.json` + `managed-settings.d/*.json` on Linux
  (docs/managed-settings.md, fetched 2026-10-17). Empirically confirmed for 2.1.302 in
  `kw-agent`: a malformed file produces
  `/etc/claude-code/managed-settings.json: Managed settings document could not be parsed...`,
  and a managed `SessionStart` hook fired in `-p` mode.
- `allowManagedHooksOnly` / `allowManagedPermissionRulesOnly` make this the only source
  of hooks and permission rules, so repo `.claude/settings.json` edits cannot remove KW
  hooks (DOC-VERIFIED; agent-side tamper attempt not yet exercised with an authenticated run).
- Every hook runs `node /opt/kw/kw-hook.mjs` (the forwarder is mounted read-only).
- `permissions.blockReadsOutsideWorkingDirectories` (v2.1.257+, docs/settings-reference.md) plus
  `deny` rules `Read(//proc/**)` / `Edit(//proc/**)` (only Read/Edit path rules are consulted; docs/permissions.md): the OAuth token is in the claude process environment, and an
  unrestricted `Read` allow would let the agent read `/proc/<pid>/environ`. DOC-VERIFIED only:
  the policy parses and the pipeline runs with it (unauthenticated smoke), but an agent attempt
  to read `/proc/self/environ` has not been exercised in an authenticated run.
- Not usable here: `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1` (needs bubblewrap + user namespaces;
  claude 2.1.302 refuses to start without them in this container). Bash/hook subprocesses can
  therefore still see the token if a Bash rule ever allows `env`/`cat /proc/...`.
- UNVERIFIED in-container: drop-in merge from `managed-settings.d/`.
- Do not put non-JSON files in `managed-settings.d/`.
