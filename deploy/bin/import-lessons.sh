#!/usr/bin/env bash
#
# Attach the owner's 23 lessons to one company's template modules (P19.6-T3; the 11-03 handover's §B6 "Then upload
# the HTML"; ADR-0208, ADR-0217). Run it by hand, over IAP SSH, once per company, after copying the delivered folder
# (revisions/2026-11-03/files/training-modules in the superproject) to the VM:
#
#   sudo /opt/agencyboost/bin/import-lessons.sh prod <company id or slug> <folder> --from-kpm <KPM id> --dry-run
#   sudo /opt/agencyboost/bin/import-lessons.sh prod <company id or slug> <folder> --from-kpm <KPM id>
#
# The lessons are never part of the image. The folder is copied into that environment's running API container for the
# run, and removed after it; `node dist/cli/import-lessons.js` runs there with the API's own database and storage
# settings. --from-kpm names the KPM whose own lesson PDFs give each module its lesson (production's KaiZen); --dry-run
# writes and sends nothing and prints the table by module code; --template <id> limits it to one template. Running it
# twice changes nothing: its last line then counts no module attached, no version published, no file sent. Exit 0
# when it ran, 1 when it failed, 2 on a usage error.
set -euo pipefail

here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=lib.sh
. "$here/lib.sh"

if [[ $# -lt 3 ]]; then
  echo 'usage: import-lessons.sh <staging|prod> <company id or slug> <lessons folder> [--from-kpm <KPM id or code>] [--template <template id>] [--dry-run]' >&2
  exit 64
fi
env=$1
company=$2
folder=$3
shift 3
require_env "$env"
require_root
[[ -f $folder/index.html ]] \
  || die "$folder holds no index.html: give the lessons' folder (revisions/2026-11-03/files/training-modules, copied to this VM)"
service=api-$env
id=$(container_of "$service")
[[ -n $id && $(docker inspect --format '{{.State.Status}}' "$id") == running ]] \
  || die "$service is not running: deploy $env first"

inside=/tmp/agencyboost-lessons-$$
cleanup() { docker exec -u root "$id" rm -rf "$inside" >/dev/null 2>&1 || true; }
trap cleanup EXIT
# "<folder>/." copies the folder's contents into $inside, which docker creates.
docker cp "$folder/." "$id:$inside" >/dev/null
docker exec -u root "$id" chmod -R a+rX "$inside"

dc exec -T "$service" node dist/cli/import-lessons.js "$company" "$inside" "$@"
