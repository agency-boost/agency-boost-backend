#!/usr/bin/env bash
#
# Send one test email with an environment's own mail settings (P18.11-T18, ADR-0182). Run it by hand, over IAP SSH,
# after the mail provider changes (a new version of api-env-<env>, then a redeploy):
#
#   sudo /opt/agencyboost/bin/send-test-mail.sh staging <to> [--subject "<subject>"]
#
# It runs `node dist/cli/send-test-mail.js` inside that environment's running API container, so it reads the
# settings that API booted with, from the image deployed there. It prints the provider, the host and the port, then
# the server's answer or its error (with Resend, its id for the message: P19.12-T1, ADR-0244), and never the password
# or RESEND_API_KEY. Exit 0 when the server accepted the message, 1 when it
# did not, 2 on a usage error. Then look for the message in the inbox, and in the spam folder:
# docs/03-engineering/email-delivery.md.
set -euo pipefail

here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=lib.sh
. "$here/lib.sh"

if [[ $# -lt 2 ]]; then
  echo 'usage: send-test-mail.sh <staging|prod> <to> [--subject "<subject>"]' >&2
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

dc exec -T "$service" node dist/cli/send-test-mail.js "$@"
