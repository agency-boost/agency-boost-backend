#!/usr/bin/env bash
#
# `docker compose` for this VM, with the project, the file, the variable files and the deployed
# environments' profiles already given (P18.4-T3, ADR-0155). The systemd unit starts the stack through
# it, and an operator reads it through it:
#
#   sudo /opt/agencyboost/bin/compose.sh ps
#   sudo /opt/agencyboost/bin/compose.sh logs --tail 100 api-prod
#
# **Do not use it to restart mongo, or to `down` the stack.** Both environments run on this one Mongo.
# A deploy touches one API only (bin/deploy.sh); mongo is stopped or recreated deliberately, by a
# person, with a reason.
set -euo pipefail

here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=lib.sh
. "$here/lib.sh"

require_root
dc "$@"
