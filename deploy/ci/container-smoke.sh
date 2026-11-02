#!/usr/bin/env bash
#
# The runtime image starts, and its readiness tells the truth about the database (P18.7-T3/T1):
#
#   1. beside a running mongo:7.0, /api/health/ready answers 200 and the container turns healthy
#   2. with mongo stopped, it answers 503 and the container turns unhealthy, which is what makes
#      bin/deploy.sh roll back an image that cannot reach its database
#   3. with mongo started again, it answers 200 again, without the API being restarted
#
# It also checks what the image itself promises: it runs as a non-root user, and argon2's prebuilt
# glibc binary loads (the image is bookworm, not alpine, for exactly that).
#
#   deploy/ci/container-smoke.sh agencyboost-api:ci
#
# Everything runs on a private docker network with no published port, so nothing it starts can collide
# with a server already on this machine. Every container, volume and the network go when it exits.
set -euo pipefail

image=${1:?usage: container-smoke.sh <image>}
mongo_image=${MONGO_IMAGE:-mongo:7.0}
name=agencyboost-smoke-$$
net=$name

cleanup() {
  docker rm --force --volumes "$name-api" "$name-mongo" >/dev/null 2>&1 || true
  docker network rm "$net" >/dev/null 2>&1 || true
}
trap cleanup EXIT

fail() {
  echo "::error::$*" >&2
  echo "--- api logs" >&2
  docker logs --tail 80 "$name-api" >&2 2>&1 || true
  exit 1
}

# The status /api/health/ready answers, from inside the container: there is no published port.
ready_status() {
  docker exec "$name-api" node -e \
    "fetch('http://127.0.0.1:3001/api/health/ready').then(r=>console.log(r.status),()=>console.log(0))" \
    2>/dev/null || echo 0
}

health() {
  docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$name-api"
}

# Polls until $1 prints $2, for at most $3 seconds.
wait_for() {
  local probe=$1 want=$2 seconds=$3 got=""
  for ((i = 0; i < seconds; i += 2)); do
    got=$($probe)
    [[ $got == "$want" ]] && return 0
    sleep 2
  done
  echo "$probe: wanted $want, still $got after ${seconds}s" >&2
  return 1
}

docker network create "$net" >/dev/null

docker run --detach --name "$name-mongo" --network "$net" --network-alias mongo "$mongo_image" >/dev/null
mongo_up() {
  if docker exec "$name-mongo" mongosh --quiet --norc --eval 'quit(db.adminCommand({ ping: 1 }).ok ? 0 : 1)' >/dev/null 2>&1; then
    echo up
  else
    echo down
  fi
}
wait_for mongo_up up 60 || fail "mongo did not start"

# Staging, because it is the strictest configuration that needs no real SMTP relay: it requires a
# bucket and a storage prefix, like production, and accepts the log mail transport, unlike production.
# Every value is fake. Nothing here reaches Cloud Storage or a mail server: neither is dialled at boot.
# The healthcheck is the image's own command, run faster than its defaults so this takes seconds.
docker run --detach --name "$name-api" --network "$net" \
  --health-interval 2s --health-timeout 3s --health-retries 2 --health-start-period 60s \
  -e NODE_ENV=staging \
  -e LOG_LEVEL=warn \
  -e MONGODB_URI=mongodb://mongo:27017 \
  -e MONGODB_DB_NAME=agencyboost_smoke \
  -e JWT_ACCESS_SECRET=smoke-access-secret-0123456789abcdef0123456789 \
  -e JWT_REFRESH_SECRET=smoke-refresh-secret-0123456789abcdef012345678 \
  -e GCS_BUCKET=agencyboost-smoke-assets \
  -e STORAGE_KEY_PREFIX=staging \
  -e SMTP_HOST=smtp.invalid \
  -e MAIL_FROM='AgencyBoost <no-reply@agencyboost.invalid>' \
  -e MAIL_TRANSPORT=log \
  -e APP_BASE_URL=https://staging.agencyboost.invalid \
  -e APP_ORIGIN=https://staging.agencyboost.invalid \
  -e CORS_ORIGINS=https://staging.agencyboost.invalid \
  -e TRUST_PROXY=1 \
  "$image" >/dev/null

uid=$(docker exec "$name-api" id -u)
[[ $uid != 0 ]] || fail "the API runs as root"
echo "ok   runs as uid $uid"

docker exec "$name-api" node -e "require('argon2').hash('smoke').then(()=>process.exit(0),(e)=>{console.error(e);process.exit(1)})" \
  || fail "argon2 does not load in the runtime image"
echo "ok   argon2 loads and hashes"

wait_for ready_status 200 90 || fail "ready did not answer 200 with the database up"
echo "ok   ready 200 with the database up"
wait_for health healthy 60 || fail "the container did not turn healthy"
echo "ok   container healthy"

docker stop "$name-mongo" >/dev/null
wait_for ready_status 503 60 || fail "ready did not answer 503 with the database stopped"
echo "ok   ready 503 with the database stopped"
wait_for health unhealthy 60 || fail "the container did not turn unhealthy with the database stopped"
echo "ok   container unhealthy"

docker start "$name-mongo" >/dev/null
wait_for ready_status 200 90 || fail "ready did not recover to 200 once the database was back"
echo "ok   ready 200 again once the database is back"

echo "container smoke passed: $image"
