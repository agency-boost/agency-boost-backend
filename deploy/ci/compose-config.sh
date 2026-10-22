#!/usr/bin/env bash
#
# deploy/compose.yml resolves, and keeps the properties the shared VM's safety rests on (P18.7-T3,
# ADR-0155):
#
#   - no API publishes a port; only Caddy faces the internet
#   - Mongo publishes 27017 on the loopback only
#   - Mongo's data is a bind of /mnt/mongo-data/db that compose will not create when it is missing
#   - each environment's API reads its own env file, and the staging seed reads staging's: a swapped
#     file would point an environment at the other's database
#   - every service has a memory limit, and both APIs cap their V8 heap: two APIs and Mongo share 2 GB
#   - every service's log is rotated
#
# Runs from the repository root, in CI's `scripts` job and on a laptop alike. It works on a copy of
# deploy/ with throwaway env files, so it never writes into the working tree.
#
#   deploy/ci/compose-config.sh
set -euo pipefail

root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

cp -R "$root/deploy/." "$work/"
# The two env files differ where it matters, so the check below can tell which one a service read.
sed 's/^MONGODB_DB_NAME=.*/MONGODB_DB_NAME=agencyboost_staging/' "$work/env/api.env.example" >"$work/env/api-staging.env"
sed 's/^MONGODB_DB_NAME=.*/MONGODB_DB_NAME=agencyboost/' "$work/env/api.env.example" >"$work/env/api-prod.env"
cp "$work/env/mongo.env.example" "$work/env/mongo.env"
mkdir -p "$work/state"
cat >"$work/env/compose.env" <<'EOF'
API_HOST_PROD=api.example.test
API_HOST_STAGING=staging-api.example.test
IMAGE_REGISTRY=registry.example.test/project
MONGO_CACHE_GB=0.25
MONGO_MEM_LIMIT=700m
API_MEM_LIMIT=512m
CADDY_MEM_LIMIT=128m
EOF
digest=$(printf '0%.0s' {1..64})
cat >"$work/state/images.env" <<EOF
API_IMAGE_STAGING=registry.example.test/project/agencyboost-staging/api@sha256:$digest
API_IMAGE_PROD=registry.example.test/project/agencyboost-prod/api@sha256:$digest
EOF

compose() {
  docker compose --project-name agencyboost --project-directory "$work" --file "$work/compose.yml" \
    --env-file "$work/env/compose.env" --env-file "$work/state/images.env" "$@"
}

compose config --quiet
COMPOSE_PROFILES=staging,prod,tools compose config --quiet
echo "compose.yml resolves (no profile, and every profile)"

COMPOSE_PROFILES=staging,prod,tools compose config --format json >"$work/resolved.json"
python3 - "$work/resolved.json" <<'PY'
import json
import sys

services = json.load(open(sys.argv[1]))["services"]
problems = []

expected = {"caddy", "mongo", "api-staging", "api-prod", "tools-staging"}
if set(services) != expected:
    problems.append("services are %s, not %s" % (sorted(services), sorted(expected)))

for name in ("api-staging", "api-prod", "tools-staging"):
    if services.get(name, {}).get("ports"):
        problems.append("%s publishes a port; only caddy may" % name)

for port in services["mongo"].get("ports", []):
    if port.get("host_ip") != "127.0.0.1":
        problems.append("mongo publishes %s on %s, not 127.0.0.1" % (port.get("published"), port.get("host_ip") or "every interface"))

data = [v for v in services["mongo"].get("volumes", []) if v.get("target") == "/data/db"]
if len(data) != 1 or data[0].get("type") != "bind" or data[0].get("source") != "/mnt/mongo-data/db":
    problems.append("mongo /data/db is not a bind of /mnt/mongo-data/db")
# compose normalises the long syntax's create_host_path: false away (false is its default) and
# writes true out, so absent means "will not create".
elif data[0].get("bind", {}).get("create_host_path"):
    problems.append("the mongo data bind would create /mnt/mongo-data/db on the boot disk when the data disk is missing")

# Each API's environment is its own, and the seed's is staging's: compose folds the env file into the
# service's environment, so the database name each service resolved to says which file it read.
for name, db in (("api-prod", "agencyboost"), ("api-staging", "agencyboost_staging"), ("tools-staging", "agencyboost_staging")):
    got = services[name].get("environment", {}).get("MONGODB_DB_NAME")
    if got != db:
        problems.append("%s resolves MONGODB_DB_NAME=%s, not %s: it reads the wrong env file" % (name, got, db))

for name in ("api-prod", "api-staging", "tools-staging"):
    if "--max-old-space-size=" not in services[name].get("environment", {}).get("NODE_OPTIONS", ""):
        problems.append("%s does not cap its V8 heap (NODE_OPTIONS --max-old-space-size)" % name)

for name, service in sorted(services.items()):
    if not service.get("mem_limit"):
        problems.append("%s has no memory limit" % name)
    logging = service.get("logging", {})
    if logging.get("driver") != "json-file" or "max-size" not in logging.get("options", {}):
        problems.append("%s has no rotated json-file logging" % name)

if services["api-prod"].get("profiles") != ["prod"] or services["api-staging"].get("profiles") != ["staging"]:
    problems.append("each API must be in the profile named after its environment")

if problems:
    print("\n".join("error: " + p for p in problems), file=sys.stderr)
    sys.exit(1)
print("APIs unpublished, mongo on 127.0.0.1 only, data bind never auto-created, each API on its own env file, "
      "every service memory-limited and log-rotated, both heaps capped")
PY
