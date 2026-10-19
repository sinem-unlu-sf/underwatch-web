# EXPERIMENTAL generic CLI agent: OpenAI Codex CLI headless (UNTRUSTED zone). No credentials in the image.
# The agent talks only to the per-run Underwatch credential broker (openai-responses profile), which holds the
# real ai& key; the agent gets a worthless per-run placeholder in AIAND_API_KEY.
FROM node:22-bookworm-slim@sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392
ARG CODEX_VERSION=0.163.0
LABEL kw-dev="1" org.opencontainers.image.title="kw-agent-codex" kw.experimental="generic-cli-agent" kw.codex.version="${CODEX_VERSION}"
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates curl ripgrep procps \
 && rm -rf /var/lib/apt/lists/*
RUN npm install -g --no-fund --no-audit "@openai/codex@${CODEX_VERSION}" && npm cache clean --force && codex --version
RUN userdel -r node \
 && groupadd -g 1000 agent && useradd -m -u 1000 -g 1000 -s /bin/bash agent \
 && mkdir -p /workspace /opt/kw && chown agent:agent /workspace && chmod 0755 /opt/kw
# Same path as kw-agent so observers/tetragon-run.ts GATE_COMMAND (exec /usr/local/bin/kw-agent-entrypoint) works unchanged.
COPY --chmod=0755 entrypoint.sh /usr/local/bin/kw-agent-entrypoint
ENV CODEX_HOME=/home/agent/.codex KW_MODEL=deepseek-ai/deepseek-v4-flash
USER agent
WORKDIR /workspace
ENTRYPOINT ["/usr/local/bin/kw-agent-entrypoint"]
