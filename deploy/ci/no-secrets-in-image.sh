#!/usr/bin/env bash
#
# No image carries a credentials file or an env file (P18.7 review, H1).
#
#   deploy/ci/no-secrets-in-image.sh agencyboost-api:ci agencyboost-tools:ci
#
# google-github-actions/auth writes gha-creds-*.json into the workspace when it writes a credentials
# file, and `COPY . .` in the build stage copies the workspace. .dockerignore keeps that file, and any
# .env, out of the build context. CI plants decoys of both before building, and this reads every path
# in each image's filesystem to prove they stayed out.
#
# It inspects the exported filesystem, so it runs nothing from the image itself.
set -euo pipefail

(($#)) || { echo "usage: no-secrets-in-image.sh <image>..." >&2; exit 64; }

status=0
for image in "$@"; do
  container=$(docker create "$image")
  # Every path in the image. A credentials file anywhere, or an env file where the build copies the
  # source (/app), fails it.
  found=$(docker export "$container" | tar -t | grep -E '(^|/)gha-creds[^/]*$|^app/\.env($|\.)' || true)
  docker rm "$container" >/dev/null
  if [[ -n $found ]]; then
    echo "::error::$image carries files that must never be in an image:" >&2
    while read -r path; do printf '  %s\n' "$path"; done <<<"$found" >&2
    status=1
  else
    echo "ok   $image: no gha-creds*, no /app/.env*"
  fi
done
exit "$status"
