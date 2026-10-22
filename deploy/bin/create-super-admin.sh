#!/usr/bin/env bash
#
# Create an environment's first Super Admin, on a database that has none (P18.7-T1/T3, ADR-0152,
# ADR-0155). Production starts dark (plan decision D11), and this is the one way in. Run it once, by
# hand, over IAP SSH:
#
#   sudo /opt/agencyboost/bin/create-super-admin.sh prod <email> [--name "<full name>"]
#
# The password is read from standard input, never from an argument: at a terminal the CLI asks for it
# twice without echoing it; piped in, the first line is the password. It refuses when a Super Admin
# already exists; after the first, the console is how anybody else becomes one. (Staging's seed makes
# its own operators, so on staging this refuses.)
#
# It runs `node dist/cli/create-super-admin.js` inside that environment's running API container, so it
# uses that API's own database user, which reaches that environment's database alone, and the image
# that is deployed there.
set -euo pipefail

here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=lib.sh
. "$here/lib.sh"

if [[ $# -lt 2 ]]; then
  echo 'usage: create-super-admin.sh <staging|prod> <email> [--name "<full name>"]   (the password on standard input)' >&2
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

if [[ -t 0 ]]; then
  # A terminal: give the CLI one too, so its prompt can turn echo off.
  dc exec "$service" node dist/cli/create-super-admin.js "$@"
else
  dc exec -T "$service" node dist/cli/create-super-admin.js "$@"
fi
