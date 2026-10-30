#!/usr/bin/env bash
#
# Boot the all-in-one image and wait for TrailBase to start listening.
#
# A `docker build` alone cannot catch runtime failures: the image runs as the
# base image's unprivileged `trailbase` user, and TrailBase writes into
# /app/traildepot on first start, so a depot copied in as root fails with
# `PermissionDenied` and a crash loop (issue #105). This script would have
# caught that in CI.
#
# Usage: scripts/trailbase/smoke-image.sh <image> [timeout-seconds]

set -euo pipefail

image="${1:?usage: $0 <image> [timeout-seconds]}"
timeout="${2:-90}"
name="virgulas-smoke-$$"

cleanup() {
  docker rm --force "$name" >/dev/null 2>&1 || true
}
trap cleanup EXIT

docker run --detach --name "$name" "$image" >/dev/null

deadline=$((SECONDS + timeout))
while :; do
  logs="$(docker logs "$name" 2>&1 || true)"
  if printf '%s\n' "$logs" | grep -q 'Listening on http'; then
    printf '%s\n' "$logs"
    echo "OK: the image boots as its own user and starts serving."
    exit 0
  fi

  if [ "$(docker inspect --format '{{.State.Running}}' "$name" 2>/dev/null || echo false)" != "true" ]; then
    echo "FAIL: the container exited before TrailBase started listening." >&2
    printf '%s\n' "$logs" >&2
    exit 1
  fi

  if [ "$SECONDS" -ge "$deadline" ]; then
    echo "FAIL: TrailBase did not start listening within ${timeout}s." >&2
    printf '%s\n' "$logs" >&2
    exit 1
  fi

  sleep 1
done
