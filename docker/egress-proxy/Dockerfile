# Underwatch egress proxy (TRUSTED zone). Attached to the agent's internal-only
# network and to an egress bridge; it is the agent's only route out.
# Default-deny domain allowlist (tinyproxy ERE filter). Every request line and every
# allow/deny decision is logged to stderr, which the HOST streams with `docker logs`
# into its own evidence directory (the agent cannot reach that log).
# Approach empirically validated in research/observation-spike/log.md Step2e.
FROM alpine:3@sha256:294b683cb724975bec92580e1e685676bd4b50bda910ddb8c51d4cabeaec77e6
RUN apk add --no-cache tinyproxy \
 && tinyproxy -v
LABEL kw-dev="1" org.opencontainers.image.title="kw-egress-proxy"
COPY tinyproxy.conf.template /etc/kw-egress/tinyproxy.conf.template
COPY --chmod=0755 start.sh /usr/local/bin/kw-egress-start
COPY allowlist.ere /etc/kw-egress/allowlist.ere
EXPOSE 8888
ENTRYPOINT ["/usr/local/bin/kw-egress-start"]
