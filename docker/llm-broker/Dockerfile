# Underwatch LLM credential broker (TRUSTED zone). See broker.mjs.
# Same pinned base as docker/agent (node:22-bookworm-slim multi-arch index digest).
# Contains NO credentials: the real Claude token and the per-run placeholder are
# bind-mounted read-only at runtime into THIS container only (never into the agent).
FROM node:22-bookworm-slim@sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392
LABEL kw-dev="1" org.opencontainers.image.title="kw-llm-broker"
RUN mkdir -p /opt/kw-broker && chmod 0755 /opt/kw-broker
COPY --chmod=0444 broker.mjs /opt/kw-broker/broker.mjs
ENV NODE_ENV=production
USER node
EXPOSE 8080
ENTRYPOINT ["node", "/opt/kw-broker/broker.mjs"]
