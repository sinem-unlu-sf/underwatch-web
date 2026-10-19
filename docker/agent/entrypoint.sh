#!/bin/sh
# Underwatch agent entrypoint.
# stdout carries ONLY Claude Code's stream-json; the HOST captures it (the
# authoritative copy lives outside this container). Diagnostics go to stderr.
# Never prints credentials.
set -eu

if [ "${1:-}" != "" ]; then
  # Escape hatch for verification commands (e.g. `claude --version`, curl tests).
  exec "$@"
fi

if [ -z "${KW_TASK:-}" ]; then
  echo "kw-agent: KW_TASK is empty; refusing to start" >&2
  exit 64
fi
case "${KW_MAX_TURNS}" in ''|*[!0-9]*) echo "kw-agent: KW_MAX_TURNS must be an integer" >&2; exit 64;; esac

if [ ! -r /etc/claude-code/managed-settings.json ]; then
  # Without the managed tier, hooks/permissions would be agent-modifiable.
  echo "kw-agent: /etc/claude-code/managed-settings.json missing or unreadable; refusing to start" >&2
  exit 65
fi

echo "kw-agent: claude $(claude --version 2>/dev/null | head -n1) model=${KW_MODEL} max_turns=${KW_MAX_TURNS} auth=$( [ -n "${CLAUDE_CODE_OAUTH_TOKEN:-}" ] && echo oauth-token-present || echo none )" >&2

cd /workspace
exec claude -p "$KW_TASK" \
  --output-format stream-json \
  --verbose \
  --include-hook-events \
  --model "$KW_MODEL" \
  --max-turns "$KW_MAX_TURNS" \
  --strict-mcp-config
