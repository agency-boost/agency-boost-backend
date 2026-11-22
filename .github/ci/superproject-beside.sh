#!/usr/bin/env bash
#
# Puts the superproject's docs/ and prototype/ beside this checkout, at ../docs and ../prototype, where a
# laptop has them (ADR-0009: this repository is a submodule of it).
#
# The parity specs read them there: the metric registry, the permission matrix and the prototype's own
# lists, each pinned against the code so that neither can drift (docs-and-tests-required.md). A CI
# checkout of this repository alone has neither, and the backend's first run on GitHub failed nine suites
# on ENOENT (2026-10-23).
#
# Read-only, over SSH, with a deploy key of the superproject: GITHUB_TOKEN reads this repository and
# nothing else. github.com's host keys come from api.github.com/meta, over TLS, rather than from a first
# connection's say-so. The key is written to a file only for the clone and removed with it.
#
# Which branch: a pull request's own branch where the superproject has one — a release PR's development,
# a companion PR's branch — and otherwise the branch it merges into; a push, the branch it was pushed to.
#
#   SUPERPROJECT_DEPLOY_KEY   the deploy key's private half (a repository secret, and a Dependabot one)
#   SUPERPROJECT_REPOSITORY   owner/name of the superproject
#   HEAD_REF                  a pull request's branch; empty for a push
#   BASE_REF                  the branch a pull request merges into, or the branch pushed to
#
#   .github/ci/superproject-beside.sh
set -euo pipefail

# On a laptop ../docs is the superproject's own, and this would put a clone in its way.
if [ "${GITHUB_ACTIONS:-}" != true ]; then
  echo "superproject-beside.sh runs in GitHub Actions only: here ../docs is already the superproject's." >&2
  exit 1
fi
: "${SUPERPROJECT_REPOSITORY:?owner/name of the superproject}"
: "${BASE_REF:?the branch this run is for}"
if [ -z "${SUPERPROJECT_DEPLOY_KEY:-}" ]; then
  echo "::error::SUPERPROJECT_DEPLOY_KEY is not set. The parity specs read the superproject's docs and" \
    "prototype, and this key is how CI reads them: README.md, CI/CD, says how to make one."
  exit 1
fi

work=${RUNNER_TEMP:-$(mktemp -d)}/superproject-access
rm -rf "$work"
mkdir -m 700 "$work"
trap 'rm -rf "$work"' EXIT

printf '%s\n' "$SUPERPROJECT_DEPLOY_KEY" >"$work/key"
chmod 600 "$work/key"
# github.com's SSH host keys, **asked with this job's own token** (2026-11-17): an anonymous call to api.github.com is
# limited per address, a hosted runner shares its address with other repositories' jobs, and a spent limit answers 403,
# which `curl --retry` alone does not retry — the backend's coverage job failed so, on a JSON decode of nothing. With the
# token the limit is this repository's own; 403 and 429 are retried as well, should a limit be met anyway.
auth=()
if [ -n "${GITHUB_TOKEN:-}" ]; then auth=(-H "Authorization: Bearer $GITHUB_TOKEN"); fi
if ! meta=$(curl -fsS --retry 5 --retry-all-errors --retry-delay 10 ${auth[@]+"${auth[@]}"} https://api.github.com/meta); then
  echo "::error::Could not read github.com's SSH host keys from api.github.com/meta (a rate limit or an outage). Re-run the job."
  exit 1
fi
python3 -c 'import json, sys; [print("github.com", k) for k in json.load(sys.stdin)["ssh_keys"]]' <<<"$meta" >"$work/known_hosts"
export GIT_SSH_COMMAND="ssh -i $work/key -o IdentitiesOnly=yes -o UserKnownHostsFile=$work/known_hosts -o StrictHostKeyChecking=yes"

url="git@github.com:${SUPERPROJECT_REPOSITORY}.git"
ref=$BASE_REF
if [ -n "${HEAD_REF:-}" ] && git ls-remote --exit-code --heads "$url" "$HEAD_REF" >/dev/null; then
  ref=$HEAD_REF
fi

checkout=$(cd .. && pwd)/.superproject
rm -rf "$checkout"
git clone --quiet --depth 1 --filter=blob:none --sparse --branch "$ref" "$url" "$checkout"
git -C "$checkout" sparse-checkout set docs prototype

for dir in docs prototype; do
  ln -sfn "$checkout/$dir" "../$dir"
done
echo "../docs and ../prototype: ${SUPERPROJECT_REPOSITORY}@${ref} ($(git -C "$checkout" rev-parse --short HEAD))"
