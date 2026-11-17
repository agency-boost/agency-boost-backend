#!/usr/bin/env bash
#
# The daily run (P19.15-T4 AC-4, ADR-0261): the premium table notices, in each deployed environment —
# fifteen days before a premium table ends with nothing scheduled, to the Super Admins; and a version that
# came into force, to its company's KPM Owners. agencyboost-daily.timer runs it at 00:10 in Jakarta; it is
# also safe by hand, and a second run on the same day tells nobody again:
#
#   sudo /opt/agencyboost/bin/daily.sh            # every deployed environment
#   sudo /opt/agencyboost/bin/daily.sh staging    # one
#
# It runs `node dist/cli/daily-notices.js` inside each environment's running API container, with that
# API's own database settings, exactly as import-proposal-fields.sh runs its command. An environment never
# deployed here is skipped; one whose API is not running is a failure, reported after the other has run.
#
# **Nothing depends on it.** A premium table's status is worked out on every read (ADR-0258 §2): a run that
# never happened means nobody was told, never that a price is wrong. A failure is logged as
# AGENCYBOOST_DAILY_FAILED by agencyboost-daily-failed.service. Exit 0 when every environment ran.
set -euo pipefail

here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=lib.sh
. "$here/lib.sh"

require_root

if [[ $# -gt 1 ]]; then
  echo 'usage: daily.sh [staging|prod]' >&2
  exit 64
fi
if [[ $# -eq 1 ]]; then
  require_env "$1"
  envs=("$1")
else
  envs=("${AB_ENVS[@]}")
fi

# The VM-wide lock, as a backup takes it: never in the middle of a deploy's migrations or a seed's --reset.
take_lock 1800

# One environment's run. 0 when it ran.
run_one() {
  local _env=$1 _service _id
  _service=api-$_env
  _id=$(container_of "$_service")
  if [[ -z $_id || $(docker inspect --format '{{.State.Status}}' "$_id") != running ]]; then
    log "$_service is not running: no daily run for $_env"
    return 1
  fi
  log "daily run for $_env"
  dc exec -T "$_service" node dist/cli/daily-notices.js
}

failed=""
ran=0
for env in "${envs[@]}"; do
  # An environment never deployed here has no API to run it in.
  [[ -s $(state_of "$env")/current ]] || continue
  ran=$((ran + 1))
  run_one "$env" || failed+=" $env"
done

((ran)) || die "no environment has been deployed on this VM: nothing to run"
[[ -z $failed ]] || die "the daily run failed for:$failed"
log "daily run done for $ran environment(s)"
