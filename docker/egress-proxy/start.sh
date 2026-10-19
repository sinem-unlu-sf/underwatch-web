#!/bin/sh
set -eu
SUBNET="${KW_ALLOW_SUBNET:-10.231.7.0/24}"
case "$SUBNET" in *[!0-9./]*|'') echo "kw-egress: bad KW_ALLOW_SUBNET" >&2; exit 64;; esac
ALLOW=/etc/kw-egress/allowlist.ere
[ -r "$ALLOW" ] || { echo "kw-egress: allowlist $ALLOW unreadable" >&2; exit 65; }
sed "s#__KW_ALLOW_SUBNET__#${SUBNET}#" /etc/kw-egress/tinyproxy.conf.template > /tmp/tinyproxy.conf
echo "kw-egress: allow_subnet=${SUBNET} allowlist_sha256=$(sha256sum "$ALLOW" | cut -d' ' -f1)" >&2
grep -v '^[[:space:]]*\(#\|$\)' "$ALLOW" | sed 's/^/kw-egress: allow /' >&2
exec tinyproxy -d -c /tmp/tinyproxy.conf
