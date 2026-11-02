#!/usr/bin/env bash
#
# Empty staging's demo data and seed it again (P18.7-T3, ADR-0152, ADR-0155). **Staging only**:
# production starts dark and is never seeded (plan decision D11).
#
#   sudo /opt/agencyboost/bin/seed.sh staging <registry>/agencyboost-staging/tools@sha256:<digest>
#
# The seed-staging workflow builds the tools image (the build stage: dev dependencies and the
# TypeScript source, which the seed runs from) and calls this over IAP SSH. Like deploy.sh, the work
# runs as a systemd unit of its own (agencyboost-seed-<time>-<pid>), so a dropped session does not
# leave a seed half-written (P18.7 review, M2).
#
# **Production's database is out of its reach, and that is checked, not assumed.** Staging and
# production share one MongoDB on this VM (ADR-0155). The seed runs as tools-staging, with staging's
# env file, so it connects as staging's database user. Before it runs, `assert_db_scope staging` asks
# Mongo for that user's roles and refuses anything but readWrite on agencyboost_staging alone. A
# `--reset` with that user cannot drop, empty or write a collection in agencyboost. The env file must
# also name agencyboost_staging, and src/seed/demo.ts refuses production a further time.
set -euo pipefail
umask 077

here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=lib.sh
. "$here/lib.sh"

if [[ $# -ne 2 ]]; then
  echo "usage: seed.sh staging <registry>/agencyboost-staging/tools@sha256:<digest>" >&2
  exit 64
fi
[[ $1 == staging ]] || die "the seed runs on staging only, never on '$1' (D11)"
readonly env=staging
tools_image=$2

require_root
require_own_image "$tools_image" "$env" tools

if [[ ${AB_IN_UNIT:-} != 1 ]]; then
  status=0
  run_detached seed "$AB_HOME/bin/seed.sh" "$env" "$tools_image" || status=$?
  exit "$status"
fi

# The same lock as deploy.sh and backup.sh: one Mongo, one of them at a time.
take_lock
require_data_disk

for line in NODE_ENV=staging MONGODB_DB_NAME=agencyboost_staging; do
  grep -qx "$line" "$AB_HOME/env/api-staging.env" \
    || die "$AB_HOME/env/api-staging.env does not say $line. Refusing to seed."
done
[[ -n $(container_of api-staging) ]] || die "staging has never been deployed on this VM: deploy it first"
assert_db_scope staging

export TOOLS_IMAGE=$tools_image
log "pulling $tools_image"
dc --profile tools pull --quiet tools-staging

# --no-deps: `run` would otherwise bring mongo's container in line with compose.yml, and a seed does
# not restart the database any more than a deploy does.
log "seeding staging (agencyboost_staging, --reset)"
dc --profile tools run --rm --no-deps -T tools-staging pnpm seed:demo --reset

# Recorded so the prune keeps this image and the one before it, and removes the rest.
state_dir=$(state_of "$env")
install -d -m 0700 "$state_dir"
current=$(cat "$state_dir/tools-current" 2>/dev/null || true)
if [[ -n $current && $current != "$tools_image" ]]; then
  printf '%s\n' "$current" >"$state_dir/tools-previous"
fi
printf '%s\n' "$tools_image" >"$state_dir/tools-current"
prune_images

log "staging seeded"
