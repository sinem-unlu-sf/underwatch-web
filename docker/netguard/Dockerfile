# kw-netguard: short-lived helper that joins the AGENT container's network namespace (--network container:<agent>)
# with CAP_NET_ADMIN only, installs an egress allowlist (loopback + egress proxy + credential broker; everything
# else, including the internal-network gateway, is dropped) and exits. The agent itself never gets NET_ADMIN.
FROM alpine:3
RUN apk add --no-cache iptables ip6tables
ENTRYPOINT ["/bin/sh"]
