#!/usr/bin/env bash
# Manual equivalent of @kw/observer-tetragon ensureTetragon() + loadObservationPolicies().
# The server should call the package API instead; this exists for debugging.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
EXPORT="$ROOT/data/observer/tetragon/export"   # host-only; never mount into agent containers
mkdir -p "$EXPORT"
if ! docker inspect kw-tetragon >/dev/null 2>&1; then
  docker run -d --name kw-tetragon --label kw-dev=1 --label kw-role=observer \
    --pid=host --cgroupns=host --privileged \
    --network none \
    -v /sys/kernel/btf/vmlinux:/var/lib/tetragon/btf:ro \
    -v "$EXPORT":/var/log/tetragon \
    quay.io/cilium/tetragon:v1.7.0 \
    --export-filename /var/log/tetragon/tetragon.log \
    --export-file-max-size-mb 512 --export-file-perm 640 \
    --metrics-server 127.0.0.1:2112 --server-address localhost:54321
fi
# metrics (no network, by design): docker exec kw-tetragon wget -qO- http://127.0.0.1:2112/metrics
docker start kw-tetragon >/dev/null
for i in $(seq 1 60); do docker exec kw-tetragon tetra status 2>/dev/null | grep -q running && break; sleep 0.5; done
for p in observe-files observe-net; do
  name="kw-$p"
  docker exec kw-tetragon tetra tracingpolicy list -o json | grep -q "\"name\":\"$name\"" && continue
  docker exec -i kw-tetragon sh -c "mkdir -p /tmp/kw-policies && cat > /tmp/kw-policies/$name.yaml" < "$ROOT/docker/tetragon/policies/$p.yaml"
  docker exec kw-tetragon tetra tracingpolicy add "/tmp/kw-policies/$name.yaml"
done
docker exec kw-tetragon tetra tracingpolicy list
