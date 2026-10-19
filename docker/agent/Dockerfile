# Underwatch - disposable agent image (UNTRUSTED zone).
# Runs Claude Code headless as non-root "agent" (uid 1000) in /workspace.
# Contains NO credentials. Policy (/etc/claude-code), the hook forwarder
# (/opt/kw/kw-hook.mjs) and the workspace are provided at runtime, read-only
# where they enforce or observe the agent.
#
# Base pinned by its multi-arch index digest (node:22-bookworm-slim, pulled 2026-10-17;
# verified with `docker buildx imagetools inspect`: OCI index incl. linux/amd64 + linux/arm64).
FROM node:22-bookworm-slim@sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392

# Exact Claude Code version. 2.1.302 == host `claude --version` and npm dist-tag
# "latest" on 2026-10-17 (dist-tag "stable" was 2.1.292). npm global install with a
# pinned version is the documented way to pin (docs/devcontainer.md, fetched 2026-10-17).
ARG CLAUDE_CODE_VERSION=2.1.302

LABEL kw-dev="1" \
      org.opencontainers.image.title="kw-agent" \
      kw.claude-code.version="${CLAUDE_CODE_VERSION}"

# Minimal tools for fixture repos + egress self-tests (curl).
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates curl ripgrep procps \
 && rm -rf /var/lib/apt/lists/*

RUN npm install -g --no-fund --no-audit "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" \
 && npm cache clean --force \
 && claude --version

# Replace the base image's uid-1000 "node" user with "agent" (uid/gid 1000).
RUN userdel -r node \
 && groupadd -g 1000 agent \
 && useradd -m -u 1000 -g 1000 -s /bin/bash agent \
 && mkdir -p /workspace /etc/claude-code /opt/kw \
 && chown agent:agent /workspace \
 && chmod 0755 /etc/claude-code /opt/kw

COPY --chmod=0755 entrypoint.sh /usr/local/bin/kw-agent-entrypoint

# Documented env vars (docs/env-vars.md, docs/devcontainer.md, fetched 2026-10-17):
# no auto-update / no self-update, no nonessential traffic (telemetry, error reports,
# feature flags), no claude.ai MCP connectors.
# NOT set: CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1. Tested 2026-10-17 with 2.1.302 in this
# image: claude exits at startup with "bubblewrap is required for subprocess env
# scrubbing and isolation", and bwrap needs user namespaces that Docker's default
# seccomp + cap_drop ALL deny. So Bash/hook subprocesses can read the whole environment;
# therefore the REAL Claude token is never put in this container: since 2026-10-17 the
# agent gets only ANTHROPIC_BASE_URL -> docker/llm-broker and a per-run placeholder.
ENV DISABLE_AUTOUPDATER=1 \
    DISABLE_UPDATES=1 \
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 \
    DISABLE_TELEMETRY=1 \
    DISABLE_ERROR_REPORTING=1 \
    ENABLE_CLAUDEAI_MCP_SERVERS=false \
    KW_MODEL=haiku \
    KW_MAX_TURNS=3

USER agent
WORKDIR /workspace
ENTRYPOINT ["/usr/local/bin/kw-agent-entrypoint"]
