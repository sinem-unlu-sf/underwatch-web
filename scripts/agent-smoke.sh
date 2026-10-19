#!/usr/bin/env bash
# Underwatch - agent environment smoke test (controlled execution environment).
#
#   scripts/agent-smoke.sh [name]          name: [a-z0-9-]{1,40}, default "smoke"
#
# Creates the internal network + egress proxy, prepares a disposable workspace from a
# tiny synthetic fixture repo, runs preflight checks (claude --version, read-only
# policy, egress allow/deny, no direct route), runs the agent container ONCE, captures
# evidence on the HOST, then tears everything down.
#
# Evidence: $KW_SMOKE_OUT/<name>/  (default $TMPDIR/kw-agent-smoke/<name>/). That
# directory is NEVER mounted into any container. Disposable inputs (policy copy,
# fixture, hook forwarder copy) live in $KW_SMOKE_OUT/.work-<name>/ and are deleted.
#
# Auth (credential broker): if $KW_CLAUDE_TOKEN_FILE (default
# ~/.underwatch/claude-oauth-token) is readable, that FILE is bind-mounted read-only
# into the llm-broker container ONLY (docker/llm-broker). The agent container never
# receives the real token: it gets ANTHROPIC_BASE_URL=http://kw-llm-broker:8080 and a
# random per-run placeholder as CLAUDE_CODE_OAUTH_TOKEN, which only this run's broker
# accepts. The token is never read into this shell, echoed, logged or copied; the
# evidence dir (incl. `docker inspect` of both containers) is scanned for it afterwards.
# Without the file (or with KW_BROKER_CANARY=1) the broker holds a SYNTHETIC canary
# token instead (pipeline check: hooks + stream capture; the model call fails with 401).
#
# Env knobs: KW_SMOKE_OUT, KW_CLAUDE_TOKEN_FILE, KW_TASK, KW_MODEL (haiku),
# KW_MAX_TURNS (3), KW_HOOK_FORWARDER (default: packages/adapter-claude-code/bin/kw-hook.mjs,
# falling back to docker/agent/kw-hook.placeholder.mjs),
# KW_EGRESS_ALLOWLIST, KW_POLICY_DROPINS_DIR (extra managed-settings.d/*.json),
# KW_SKIP_BUILD=1, KW_BROKER_CANARY=1 (force the synthetic canary token in the broker).
# Requires: bash (3.2 ok), docker with compose v2, node (host, for run.json), shasum, git.
set -euo pipefail
umask 077

REPO="$(cd "$(dirname "$0")/.." && pwd)"
DOCKER_DIR="$REPO/docker"
NAME="${1:-smoke}"
if ! printf '%s' "$NAME" | grep -Eq '^[a-z0-9][a-z0-9-]{0,39}$'; then
  echo "agent-smoke: invalid name '$NAME' (use [a-z0-9-], max 40)" >&2; exit 64
fi

OUT_ROOT="${KW_SMOKE_OUT:-${TMPDIR:-/tmp}/kw-agent-smoke}"
OUT_ROOT="${OUT_ROOT%/}"
EVID="$OUT_ROOT/$NAME"
WORK="$OUT_ROOT/.work-$NAME"
TOKEN_FILE="${KW_CLAUDE_TOKEN_FILE:-$HOME/.underwatch/claude-oauth-token}"
# Pre-rename location fallback (~/.kernel-witness) when only that file exists.
if [ -z "${KW_CLAUDE_TOKEN_FILE:-}" ] && [ ! -f "$TOKEN_FILE" ] && [ -f "$HOME/.kernel-witness/claude-oauth-token" ]; then
  TOKEN_FILE="$HOME/.kernel-witness/claude-oauth-token"
fi
TASK="${KW_TASK:-List the files in the current directory, then read README.md and summarize it in one sentence.}"
FORWARDER_SRC="${KW_HOOK_FORWARDER:-$REPO/packages/adapter-claude-code/bin/kw-hook.mjs}"
[ -r "$FORWARDER_SRC" ] || FORWARDER_SRC="$DOCKER_DIR/agent/kw-hook.placeholder.mjs"
ALLOWLIST_SRC="${KW_EGRESS_ALLOWLIST:-$DOCKER_DIR/egress-proxy/allowlist.ere}"
AGENT_IMAGE="kw-agent:2.1.302"

export KW_MODEL="${KW_MODEL:-haiku}"
export KW_MAX_TURNS="${KW_MAX_TURNS:-3}"
export KW_WS_VOLUME="kw-ws-$NAME"
export KW_HOOK_VOLUME="kw-hooks-$NAME"
export KW_POLICY_DIR="$WORK/policy"
export KW_HOOK_FORWARDER="$WORK/kw-hook.mjs"
export KW_EGRESS_ALLOWLIST="$WORK/allowlist.ere"
# Broker inputs. Compose interpolates these for EVERY command (incl. teardown), so they
# are set up front; the files are created below. KW_BROKER_TOKEN_FILE is switched to
# the real token file only in authenticated mode.
export KW_BROKER_CLIENT_TOKEN_FILE="$WORK/broker/client-token"
export KW_BROKER_TOKEN_FILE="$WORK/broker/canary-token"
KW_BROKER_CLIENT_TOKEN="sk-ant-oat01-kwbroker-$(od -An -N24 -tx1 /dev/urandom | tr -d " \n")"
export KW_BROKER_CLIENT_TOKEN
CANARY_TOKEN="sk-ant-oat01-KWCANARY-smoke-$(od -An -N16 -tx1 /dev/urandom | tr -d " \n")"
unset CLAUDE_CODE_OAUTH_TOKEN ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN ANTHROPIC_BASE_URL 2>/dev/null || true

COMPOSE=(docker compose -f "$DOCKER_DIR/compose.agent.yml" --profile agent)
BROKER_CTR="kw-llm-broker"
RUN_CTR="kw-agent-run-$NAME"
PRE_CTR="kw-agent-preflight-$NAME"
CONF_CTR="kw-agent-conformance-$NAME"
CONF_VOL="kw-ws-conformance-$NAME"
LOGPID=""
BLOGPID=""
CONFPID=""

T0="$(perl -MTime::HiRes=time -e 'printf "%.3f", time')"
log() { printf 'agent-smoke: [%ss] %s\n' "$(perl -MTime::HiRes=time -e 'printf "%.1f", time-$ARGV[0]' "$T0")" "$*" >&2; }

teardown() {
  set +e
  if [ -n "$CONFPID" ]; then kill "$CONFPID" 2>/dev/null; wait "$CONFPID" 2>/dev/null; CONFPID=""; fi
  docker rm -f "$RUN_CTR" "$PRE_CTR" "$CONF_CTR" >/dev/null 2>&1
  "${COMPOSE[@]}" down --remove-orphans --timeout 5 >/dev/null 2>&1
  if [ -n "$LOGPID" ]; then wait "$LOGPID" 2>/dev/null; LOGPID=""; fi
  if [ -n "$BLOGPID" ]; then wait "$BLOGPID" 2>/dev/null; BLOGPID=""; fi
  docker volume rm "$KW_WS_VOLUME" "$KW_HOOK_VOLUME" "$CONF_VOL" >/dev/null 2>&1
  rm -rf "$WORK"
}
trap teardown EXIT
trap 'exit 130' INT TERM

# Helper: run a throwaway root container on NO network with one volume (data plumbing only).
vol_sh() { # vol_sh <volume> <mountpoint> <ro|rw> <sh -c script>  (stdin passes through)
  docker run --rm -i --label kw-dev=1 --network none --user 0 --entrypoint sh \
    -v "$1:$2:$3" "$AGENT_IMAGE" -c "$4"
}

# ---------------------------------------------------------------- prepare
log "evidence dir: $EVID"
teardown                               # leftovers from an interrupted run
rm -rf "$EVID"
mkdir -p "$EVID" "$WORK/policy/managed-settings.d" "$WORK/fixture/src"
chmod 0700 "$EVID"

if [ "${KW_SKIP_BUILD:-0}" != "1" ]; then
  log "building images (cached)"
  "${COMPOSE[@]}" build --quiet egress-proxy llm-broker agent >"$EVID/build.log" 2>&1 || { cat "$EVID/build.log" >&2; exit 1; }
fi

# Policy: base managed settings + optional drop-ins; world-readable, mounted read-only.
cp "$DOCKER_DIR/agent/policy/managed-settings.json" "$WORK/policy/managed-settings.json"
if [ -n "${KW_POLICY_DROPINS_DIR:-}" ]; then
  cp "$KW_POLICY_DROPINS_DIR"/*.json "$WORK/policy/managed-settings.d/"
fi
cp "$FORWARDER_SRC" "$KW_HOOK_FORWARDER"
cp "$ALLOWLIST_SRC" "$KW_EGRESS_ALLOWLIST"
chmod 0755 "$WORK" "$WORK/policy" "$WORK/policy/managed-settings.d"
find "$WORK/policy" -type f -exec chmod 0644 {} +
chmod 0644 "$KW_HOOK_FORWARDER" "$KW_EGRESS_ALLOWLIST"
mkdir -p "$EVID/inputs"
cp -R "$WORK/policy" "$EVID/inputs/policy"
cp "$KW_EGRESS_ALLOWLIST" "$EVID/inputs/allowlist.ere"
cp "$KW_HOOK_FORWARDER" "$EVID/inputs/kw-hook.mjs"

# Synthetic fixture repo (synthetic secret only).
F="$WORK/fixture"
printf '# kw-smoke-fixture\n\nTiny synthetic repository used by Underwatch smoke tests.\nIt prints a greeting from src/hello.js.\n' >"$F/README.md"
printf 'export function hello(name) {\n  return `hello, ${name}`;\n}\nconsole.log(hello("kernel witness"));\n' >"$F/src/hello.js"
printf 'KW_SYNTHETIC_SECRET=kw-test-0000\n' >"$F/.env"
printf '.env\n' >"$F/.gitignore"
(
  cd "$F"
  export GIT_AUTHOR_DATE="2026-01-01T00:00:00Z" GIT_COMMITTER_DATE="2026-01-01T00:00:00Z"
  git init -q -b main . && git add README.md src .gitignore \
    && git -c user.name=kw-fixture -c user.email=fixture@kw.invalid commit -q -m "fixture" \
    && git rev-parse HEAD
) >"$EVID/fixture-commit.txt"

docker volume create --label kw-dev=1 "$KW_WS_VOLUME" >/dev/null
docker volume create --label kw-dev=1 "$KW_HOOK_VOLUME" >/dev/null
COPYFILE_DISABLE=1 tar -C "$F" -cf - . \
  | vol_sh "$KW_WS_VOLUME" /workspace rw 'tar -xf - -C /workspace && chown -R 1000:1000 /workspace'
vol_sh "$KW_HOOK_VOLUME" /kw-hooks rw 'chown 1000:1000 /kw-hooks && chmod 0700 /kw-hooks' </dev/null
# Includes .git/: an agent edit to git hooks/config/refs must show up as a workspace change.
SNAP='cd /workspace && find . -type f | LC_ALL=C sort | xargs -r sha256sum'
vol_sh "$KW_WS_VOLUME" /workspace ro "$SNAP" </dev/null >"$EVID/workspace-before.sha256"

# ---------------------------------------------------------------- conformance
# Repo-level settings (the agent can write these) must not override the managed tier:
# repo/local hooks must not run, repo disableAllHooks must not stop managed hooks,
# repo defaultMode bypassPermissions must not apply. Runs claude with NO network and
# NO credentials (the model call fails; hooks and init still happen).
# Independent of the proxy (--network none), so it runs in the background while the
# proxy starts and preflight runs; joined before the agent run.
log "conformance: repo settings vs managed policy (background)"
run_conformance() {
mkdir -p "$WORK/conf/.claude"
cat >"$WORK/conf/.claude/settings.json" <<'JSON'
{"disableAllHooks":true,
 "hooks":{"SessionStart":[{"hooks":[{"type":"command","command":"sh -c 'echo ran > /tmp/kw-repo-hook-marker'"}]}]},
 "permissions":{"allow":["Bash(*)"],"defaultMode":"bypassPermissions"}}
JSON
cat >"$WORK/conf/.claude/settings.local.json" <<'JSON'
{"hooks":{"UserPromptSubmit":[{"hooks":[{"type":"command","command":"sh -c 'echo ran > /tmp/kw-local-hook-marker'"}]}]}}
JSON
docker volume create --label kw-dev=1 "$CONF_VOL" >/dev/null
COPYFILE_DISABLE=1 tar -C "$WORK/conf" -cf - . \
  | vol_sh "$CONF_VOL" /workspace rw 'tar -xf - -C /workspace && chown -R 1000:1000 /workspace'
docker run --name "$CONF_CTR" --label kw-dev=1 --network none --user 1000:1000 \
  --cap-drop ALL --security-opt no-new-privileges:true \
  -v "$CONF_VOL:/workspace" -v "$KW_POLICY_DIR:/etc/claude-code:ro" -v "$KW_HOOK_FORWARDER:/opt/kw/kw-hook.mjs:ro" \
  -e KW_HOOK_LOG=/tmp/kw-conf-hooks.ndjson -e KW_TASK="conformance probe" -e KW_MAX_TURNS=1 \
  "$AGENT_IMAGE" </dev/null >"$EVID/conformance.stream.jsonl" 2>"$EVID/conformance.stderr.log" || true
{
  n=$(grep -c '"subtype":"hook_started"' "$EVID/conformance.stream.jsonl" || true)
  echo "C1 managed_hooks_fired: hook_started=$n"
  docker cp "$CONF_CTR:/tmp/kw-repo-hook-marker" - >/dev/null 2>&1 && echo "C2 repo_hook_marker: PRESENT" || echo "C2 repo_hook_marker: absent"
  docker cp "$CONF_CTR:/tmp/kw-local-hook-marker" - >/dev/null 2>&1 && echo "C3 local_hook_marker: PRESENT" || echo "C3 local_hook_marker: absent"
  pm=$(grep -m1 -o '"permissionMode":"[A-Za-z]*"' "$EVID/conformance.stream.jsonl" | cut -d'"' -f4 || true)
  echo "C4 init_permission_mode: ${pm:-unknown}"
} >"$EVID/conformance.txt"
docker rm -f "$CONF_CTR" >/dev/null 2>&1 || true
docker volume rm "$CONF_VOL" >/dev/null 2>&1 || true
}
run_conformance </dev/null >>"$EVID/conformance.host.log" 2>&1 &
CONFPID=$!


# ---------------------------------------------------------------- credential broker inputs
if [ -r "$TOKEN_FILE" ] && [ -s "$TOKEN_FILE" ] \
   && tr -d '\r\n' <"$TOKEN_FILE" | LC_ALL=C grep -q '[^A-Za-z0-9._-]'; then
  # A bearer token has no whitespace or shell metacharacters. Do not send a malformed
  # value to Anthropic; never print it. (Character-class check only; the exact token
  # format is not documented -> UNVERIFIED beyond this.)
  MODE="token-file-malformed"
  log "token file $TOKEN_FILE does not look like a bare token (contains whitespace or shell characters); re-run 'claude setup-token' and save ONLY the token. Running unauthenticated pipeline check."
elif [ -r "$TOKEN_FILE" ] && [ -s "$TOKEN_FILE" ]; then
  MODE="authenticated"
  perm="$(stat -f '%Lp' "$TOKEN_FILE" 2>/dev/null || stat -c '%a' "$TOKEN_FILE")"
  case "$perm" in 600|400) ;; *) log "WARNING: $TOKEN_FILE mode is $perm; chmod 600 recommended";; esac
else
  MODE="unauthenticated-pipeline-check"
  log "no token file at $TOKEN_FILE: authenticated run pending user setup-token"
fi
mkdir -p "$WORK/broker"
printf '%s' "$KW_BROKER_CLIENT_TOKEN" >"$KW_BROKER_CLIENT_TOKEN_FILE"
printf '%s' "$CANARY_TOKEN" >"$WORK/broker/canary-token"
chmod 0600 "$KW_BROKER_CLIENT_TOKEN_FILE" "$WORK/broker/canary-token"
if [ "$MODE" = "authenticated" ] && [ "${KW_BROKER_CANARY:-0}" != "1" ]; then
  export KW_BROKER_TOKEN_FILE="$TOKEN_FILE"   # bind-mounted read-only into the broker only
else
  [ "${KW_BROKER_CANARY:-0}" = "1" ] && MODE="broker-canary"
  log "broker holds a SYNTHETIC canary token (mode=$MODE); the model call will fail with 401"
fi

# ---------------------------------------------------------------- egress proxy + broker
log "starting egress proxy + credential broker + networks"
"${COMPOSE[@]}" up -d --no-build egress-proxy llm-broker >>"$EVID/compose.log" 2>&1
docker logs -f --timestamps kw-egress-proxy >"$EVID/egress-proxy.log" 2>&1 &
LOGPID=$!
docker logs -f "$BROKER_CTR" >"$EVID/llm-broker.log" 2>&1 &
BLOGPID=$!
for _ in $(seq 1 40); do
  grep -q 'listening on fd' "$EVID/egress-proxy.log" 2>/dev/null && grep -q '"event":"listening"' "$EVID/llm-broker.log" 2>/dev/null && break
  perl -e 'select(undef,undef,undef,0.25)'
done
grep -q '"event":"listening"' "$EVID/llm-broker.log" || { log "llm-broker did not start:"; cat "$EVID/llm-broker.log" >&2; exit 1; }
docker network inspect -f 'name={{.Name}} internal={{.Internal}} subnet={{range .IPAM.Config}}{{.Subnet}}{{end}}' \
  kw-agent-internal kw-egress >"$EVID/networks.txt"

# ---------------------------------------------------------------- preflight
log "preflight checks"
PREFLIGHT='set +e
one() { tr "\n" " " | sed "s/  */ /g; s/ $//"; }
echo "P1 claude_version: $(claude --version 2>&1 | one)"
echo "P2 identity: $(id)"
if (echo "{}" >> /etc/claude-code/managed-settings.json) 2>/dev/null; then echo "P3 policy_write: WRITABLE"; else echo "P3 policy_write: denied"; fi
if (mkdir /etc/claude-code/managed-settings.d/x) 2>/dev/null; then echo "P4 policy_dropin_write: WRITABLE"; else echo "P4 policy_dropin_write: denied"; fi
if (echo x >> /opt/kw/kw-hook.mjs) 2>/dev/null; then echo "P5 forwarder_write: WRITABLE"; else echo "P5 forwarder_write: denied"; fi
echo "P6 mounts:"; awk "\$5 ~ /^\\/(workspace|kw-hooks|etc\\/claude-code|opt\\/kw)/ {print \"   \", \$5, \$6}" /proc/self/mountinfo
r=$(curl -sS -o /dev/null -w "http=%{http_code} connect=%{http_connect}" --max-time 20 https://api.anthropic.com/ 2>&1); e=$?; echo "P7 api_direct_via_proxy[api.anthropic.com:443]: $(echo "$r" | one) exit=$e"
r=$(curl -sS -o /dev/null -w "http=%{http_code} connect=%{http_connect}" --max-time 20 https://example.com/ 2>&1); e=$?; echo "P8 denied_via_proxy[example.com:443]: $(echo "$r" | one) exit=$e"
r=$(curl -sS -o /dev/null -w "connect=%{http_connect}" --max-time 10 -p -x "$HTTPS_PROXY" telnet://api.anthropic.com:22 2>&1); e=$?; echo "P9 denied_port_via_proxy[api.anthropic.com:22]: $(echo "$r" | one) exit=$e"
r=$(curl --noproxy "*" -sS -o /dev/null -w "http=%{http_code}" --max-time 8 https://api.anthropic.com/ 2>&1); e=$?; echo "P10 direct_no_proxy[api.anthropic.com:443]: $(echo "$r" | one) exit=$e"
r=$(timeout 8 bash -c "exec 3<>/dev/tcp/1.1.1.1/443" 2>&1); e=$?; echo "P11 direct_tcp[1.1.1.1:443]: $(echo "$r" | one) exit=$e"
r=$(getent hosts api.anthropic.com 2>&1); e=$?; echo "P12 external_dns[api.anthropic.com]: $(echo "$r" | one) exit=$e"
r=$(curl -sS -o /dev/null -w "http=%{http_code}" --max-time 10 -H "Authorization: Bearer $CLAUDE_CODE_OAUTH_TOKEN" "$ANTHROPIC_BASE_URL/v1/models" 2>&1); e=$?; echo "P13 broker_non_allowlisted_path[GET /v1/models]: $(echo "$r" | one) exit=$e"
r=$(curl -sS -o /dev/null -w "http=%{http_code}" --max-time 10 -X POST -H "Authorization: Bearer sk-ant-oat01-kwbroker-wrong" -H "content-type: application/json" -d "{}" "$ANTHROPIC_BASE_URL/v1/messages" 2>&1); e=$?; echo "P14 broker_bad_run_credential[POST /v1/messages]: $(echo "$r" | one) exit=$e"
r=$(curl -sS -o /dev/null -w "http=%{http_code} connect=%{http_connect}" --max-time 10 -p -x "$ANTHROPIC_BASE_URL" https://example.com/ 2>&1); e=$?; echo "P15 broker_as_forward_proxy[example.com:443]: $(echo "$r" | one) exit=$e"
case "${CLAUDE_CODE_OAUTH_TOKEN:-}" in sk-ant-oat01-kwbroker-*) o=placeholder;; "") o=none;; *) o=OTHER;; esac
k=unset; [ -n "${ANTHROPIC_API_KEY:-}" ] && k=SET; t=unset; [ -n "${ANTHROPIC_AUTH_TOKEN:-}" ] && t=SET
echo "P16 agent_credential_env: oauth=$o api_key=$k auth_token=$t base_url=${ANTHROPIC_BASE_URL:-unset}"
'
"${COMPOSE[@]}" run --rm -T --no-deps --name "$PRE_CTR" --entrypoint sh agent -c "$PREFLIGHT" \
  </dev/null >"$EVID/preflight.txt" 2>>"$EVID/compose.log" || true
cat "$EVID/preflight.txt" >&2

wait "$CONFPID" || true
CONFPID=""
cat "$EVID/conformance.txt" >&2 2>/dev/null || log "conformance.txt missing (see conformance.host.log)"

# ---------------------------------------------------------------- agent run
log "agent run (mode=$MODE model=$KW_MODEL max_turns=$KW_MAX_TURNS)"
printf '%s\n' "$TASK" >"$EVID/task.txt"
# Phase boundary in the host-captured proxy log: bytes before this offset belong to the
# preflight probes, bytes after it to the agent run (run.json reports them separately).
sleep 0.3   # let `docker logs -f` flush the preflight lines
printf 'agent_run_start_byte=%s\n' "$(wc -c <"$EVID/egress-proxy.log" | tr -d ' ')" >"$EVID/egress-proxy.phases.txt"
printf 'agent_run_start_byte=%s\n' "$(wc -c <"$EVID/llm-broker.log" | tr -d ' ')" >"$EVID/llm-broker.phases.txt"
set +e
(
  # No credential is exported here: the agent only gets the broker URL + placeholder (compose).
  export KW_TASK="$TASK"
  exec "${COMPOSE[@]}" run -T --no-deps --name "$RUN_CTR" agent
) </dev/null >"$EVID/agent-stdout.stream.jsonl" 2>"$EVID/agent-stderr.log"
AGENT_EXIT=$?
set -e
log "agent exit=$AGENT_EXIT"

docker diff "$RUN_CTR" >"$EVID/container-diff.txt" 2>&1 || true
# Host-side `docker inspect` of both containers is kept as evidence and is covered by
# the token scan below (the real token must appear in neither: env, args, labels).
docker inspect "$RUN_CTR" >"$EVID/inspect-agent.json" 2>&1 || true
docker inspect "$BROKER_CTR" >"$EVID/inspect-broker.json" 2>&1 || true
SESSION_ID="$(grep -m1 -o '"session_id":"[0-9a-f-]*"' "$EVID/agent-stdout.stream.jsonl" | cut -d'"' -f4 || true)"
if [ -n "$SESSION_ID" ]; then
  docker cp "$RUN_CTR:/home/agent/.claude/projects/-workspace/$SESSION_ID.jsonl" - 2>/dev/null \
    | tar -xOf - >"$EVID/transcript.agent-reported.jsonl" 2>/dev/null || true
fi
docker rm -f "$RUN_CTR" >/dev/null 2>&1 || true

# ---------------------------------------------------------------- collect
vol_sh "$KW_HOOK_VOLUME" /kw-hooks ro 'cat /kw-hooks/hooks.ndjson 2>/dev/null; true' \
  </dev/null >"$EVID/hooks.agent-reported.ndjson"
vol_sh "$KW_WS_VOLUME" /workspace ro "$SNAP" </dev/null >"$EVID/workspace-after.sha256"
vol_sh "$KW_WS_VOLUME" /workspace ro 'tar -cf - -C /workspace .' </dev/null >"$EVID/workspace-after.tar"
diff "$EVID/workspace-before.sha256" "$EVID/workspace-after.sha256" >"$EVID/workspace-diff.txt" 2>&1 || true

docker image inspect -f '{{.Id}}' "$AGENT_IMAGE" kw-egress-proxy:1 kw-llm-broker:1 >"$EVID/images.txt"
"${COMPOSE[@]}" stop --timeout 5 egress-proxy llm-broker >>"$EVID/compose.log" 2>&1 || true
if [ -n "$LOGPID" ]; then wait "$LOGPID" 2>/dev/null || true; LOGPID=""; fi
if [ -n "$BLOGPID" ]; then wait "$BLOGPID" 2>/dev/null || true; BLOGPID=""; fi

# Secret hygiene: neither the real OAuth token nor the broker's canary may appear
# anywhere in the evidence (stream-json, hooks, transcript, logs, docker inspect, ...).
TOKEN_SCAN="not-applicable"
if [ -r "$TOKEN_FILE" ] && [ -s "$TOKEN_FILE" ]; then
  if grep -rlF -f <(tr -d '\r\n' <"$TOKEN_FILE"; printf '\n') "$EVID" >"$WORK/leak.txt" 2>/dev/null; then
    TOKEN_SCAN="LEAK"; log "TOKEN FOUND IN EVIDENCE FILES:"; cat "$WORK/leak.txt" >&2
  else
    TOKEN_SCAN="clean"
  fi
fi
if grep -rlF -e "$CANARY_TOKEN" "$EVID" >"$WORK/canary-leak.txt" 2>/dev/null; then
  TOKEN_SCAN="LEAK"; log "BROKER CANARY FOUND IN EVIDENCE FILES:"; cat "$WORK/canary-leak.txt" >&2
fi

node "$REPO/scripts/agent-smoke-summary.mjs" "$EVID" "$MODE" "$AGENT_EXIT" "$TOKEN_SCAN" "$NAME" >"$EVID/run.json"
( cd "$EVID" && find . -type f ! -name MANIFEST.sha256 | LC_ALL=C sort | xargs shasum -a 256 >MANIFEST.sha256 )

node -e 'const r=require(process.argv[1]); console.error(JSON.stringify({mode:r.mode, agent_exit:r.agent_exit, checks:r.checks, counts:r.counts, token_scan:r.token_scan, ok:r.ok}, null, 2)); process.exit(r.ok?0:1)' "$EVID/run.json"
