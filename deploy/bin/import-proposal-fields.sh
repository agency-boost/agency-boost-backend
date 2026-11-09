#!/usr/bin/env bash
#
# Import the Prudential proposal fields draft of 3 November 2026 into one company's catalogue (P19.7-T1 AC-4,
# ADR-0225 §10). Run it by hand, over IAP SSH, once the company exists:
#
#   sudo /opt/agencyboost/bin/import-proposal-fields.sh prod <company id or slug>
#
# It runs `node dist/cli/import-proposal-fields.js` inside that environment's running API container, with the API's
# own database settings. Matched by product code; a product whose fields the Super Admin has edited is skipped, never
# overwritten; a code the company lacks is reported; running it twice changes nothing. It prints what it wrote,
# left unchanged, skipped and could not find. Exit 0 when it ran, 1 when it failed, 2 on a usage error.
set -euo pipefail

here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=lib.sh
. "$here/lib.sh"

if [[ $# -ne 2 ]]; then
  echo 'usage: import-proposal-fields.sh <staging|prod> <company id or slug>' >&2
  exit 64
fi
env=$1
shift
require_env "$env"
require_root
service=api-$env
id=$(container_of "$service")
[[ -n $id && $(docker inspect --format '{{.State.Status}}' "$id") == running ]] \
  || die "$service is not running: deploy $env first"

dc exec -T "$service" node dist/cli/import-proposal-fields.js "$@"
