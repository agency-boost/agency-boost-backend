#!/usr/bin/env bash
#
# Put one environment's API image on this VM, and put its previous one back if it does not come up
# healthy (P18.4-T3, ADR-0152, ADR-0155). GitHub Actions runs it over IAP SSH after every push to
# development (staging) or main (prod).
#
#   sudo /opt/agencyboost/bin/deploy.sh <staging|prod> [--bundle DIR] <registry>/agencyboost-<env>/api@sha256:<digest>
#
# The environment comes first, so each deployer's sudoers rule can allow exactly its own
# (vm/bootstrap.sh). A rollback by hand is the same command with the earlier digest, which is in
# /opt/agencyboost/state/<env>/previous.
#
# **One VM, two environments** (ADR-0155). A deploy replaces api-<env> and nothing else: never mongo,
# never the other environment's API, never Caddy's container.
#
# **The work runs as a systemd unit of its own** (agencyboost-deploy-<time>-<pid>), and this command
# follows its journal and returns its result. A dropped SSH session stops the following, never the
# deploy (P18.4 review, M2). `sudo journalctl -u 'agencyboost-deploy-*'` shows every deploy since boot.
#
# The steps, in order, inside the unit:
#   1. take the VM-wide lock: deploys of both environments, seeds and backups take turns
#   2. the data disk is mounted, and it is ours
#   3. with --bundle: install compose.yml, Caddyfile, mongo/init, bin/ and the systemd units from that
#      copy of the repository's deploy/, then re-exec the installed deploy.sh, so a change to this
#      script takes effect in the deploy that ships it
#   4. render env/api-<env>.env from Secret Manager, refusing an unfilled one and one whose NODE_ENV or
#      MONGODB_DB_NAME is the other environment's (env/mongo.env as well, from `mongo-root`, on the first
#      deploy of either environment only, refusing one without the six keys Mongo initialises with);
#      have Caddy validate a changed Caddyfile; warn when mongo's or caddy's definition has drifted
#   5. prove <env>'s database user holds readWrite on <env>'s database and nothing else
#   6. pull the new image by digest
#   7. run the migrations in a one-off container of the new image, against <env>'s database, while the
#      current API keeps serving
#   8. replace api-<env>, and only that container
#   9. wait for it to be healthy; if it is not, put <env>'s previous image back and fail
#  10. record the digest, reload Caddy if its file changed, remove images older than each
#      environment's previous
#
# Any failure before the switch leaves the VM as it was: the env file and the Caddyfile go back too.
set -euo pipefail
shopt -s nullglob
umask 077

here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=lib.sh
. "$here/lib.sh"

# Long enough for a cold start after a large migration; the API normally answers in a few seconds.
readonly HEALTH_TIMEOUT=180

usage() {
  cat <<'EOF'
usage: deploy.sh <staging|prod> [--bundle DIR] <registry>/agencyboost-<env>/api@sha256:<digest>

  --bundle DIR   a copy of the repository's deploy/ directory to install before deploying
EOF
}

# --- helpers ---------------------------------------------------------------------------------------

# Replace a file by rename, never in place: bash reads a running script as it goes, and a running
# deploy.sh overwritten in place would execute half of the old file and half of the new one.
put() {
  local mode=$1 src=$2 dst=$3
  install -m "$mode" -o root -g root "$src" "$dst.new"
  mv -f "$dst.new" "$dst"
}

caddyfile_changed=0

install_bundle() {
  local src=$1 f units_changed=0
  [[ -d $src && -f $src/compose.yml && -f $src/Caddyfile && -d $src/bin ]] \
    || die "$src does not look like the repository's deploy/ directory"
  # The bundle was written by an unprivileged login and is read here as root. A symbolic link in it
  # could point this copy at any file on the machine.
  [[ -z $(find "$src" -type l -print -quit) ]] \
    || die "$src contains a symbolic link; refusing to install it"

  put 0644 "$src/compose.yml" "$AB_HOME/compose.yml"

  if ! cmp -s "$src/Caddyfile" "$AB_HOME/Caddyfile"; then
    # Kept, so a file this deploy installs can be put back if the deploy fails.
    if [[ -f $AB_HOME/Caddyfile ]]; then cp -p "$AB_HOME/Caddyfile" "$AB_HOME/state/Caddyfile.previous"; fi
    # Written in place, unlike everything else: Caddy's container bind-mounts this one file, which pins
    # its inode. A file replaced by rename would leave the container reading the old one.
    cat "$src/Caddyfile" >"$AB_HOME/Caddyfile"
    chmod 0644 "$AB_HOME/Caddyfile"
    caddyfile_changed=1
  fi

  install -d -m 0755 "$AB_HOME/mongo" "$AB_HOME/mongo/init"
  # The init directory holds exactly what the bundle holds: an old script left beside a new one would
  # run too, the day an empty data directory is initialised.
  for f in "$AB_HOME"/mongo/init/*; do [[ -e $src/mongo/init/${f##*/} ]] || rm -f "$f"; done
  for f in "$src"/mongo/init/*.js; do put 0644 "$f" "$AB_HOME/mongo/init/${f##*/}"; done
  for f in "$src"/bin/*.sh; do put 0755 "$f" "$AB_HOME/bin/${f##*/}"; done
  for f in "$src"/systemd/agencyboost*; do
    if ! cmp -s "$f" "/etc/systemd/system/${f##*/}"; then
      put 0644 "$f" "/etc/systemd/system/${f##*/}"
      units_changed=1
    fi
  done
  # Reload only. The units take effect at the next boot, and a deploy restarts nothing but the API.
  if ((units_changed)); then systemctl daemon-reload; fi

  log "installed the deploy bundle from $src"
}

# A secret's latest version into a new 0600 file beside its destination. Prints the file's path.
fetch_secret() {
  local secret=$1 dest=$2 tmp
  tmp=$(mktemp "$dest.XXXXXX")
  if ! gcloud secrets versions access latest --secret="$secret" --quiet >"$tmp"; then
    rm -f "$tmp"
    die "could not read secret $secret: does it have a version, and may api-runtime access it?"
  fi
  if [[ ! -s $tmp ]]; then
    rm -f "$tmp"
    die "secret $secret is empty: add a version (docs/03-engineering/deployment-gcp.md)"
  fi
  printf '%s\n' "$tmp"
}

# Create a service that has never existed. A stopped mongo is not started: somebody stopped it.
ensure_started() {
  local svc=$1 id state missing
  id=$(container_of "$svc")
  if [[ -z $id ]]; then
    if [[ $svc == mongo ]]; then
      # The one moment env/mongo.env matters: an empty data directory is initialised from it, once.
      missing=$(missing_mongo_keys "$AB_HOME/env/mongo.env")
      [[ -z $missing ]] \
        || abort_before_switch "env/mongo.env lacks a value for: $(echo "$missing" | tr '\n' ' ')- Mongo would initialise without them. Fix the secret mongo-root, delete env/mongo.env and deploy again"
    fi
    log "$svc has never been created on this VM: creating it"
    dc up --detach --no-deps "$svc"
    return
  fi
  state=$(docker inspect --format '{{.State.Status}}' "$id")
  [[ $state == running ]] && return
  if [[ $svc == mongo ]]; then
    abort_before_switch "mongo exists but is $state. A deploy never starts or restarts the database: start it deliberately ($AB_HOME/bin/compose.sh start mongo) and deploy again"
  fi
  log "$svc is $state: starting it"
  dc start "$svc"
}

# A service whose definition in compose.yml is no longer the one its container was created from, so
# that the next `up` of it would recreate it (P18.4 review, M4). For mongo that is a restart nobody
# chose, and on this VM it takes both environments down: a deploy never does it, and boot runs
# `up --no-recreate`. This says, loudly, that one is pending, for a person to make at a quiet time.
#
# compose is asked directly, with a dry run of that `up`, which changes nothing and reports what it would
# do. Comparing the container's config-hash label with `compose config --hash` is not reliable: compose
# 2.40 (Ubuntu's docker-compose-v2) hashes a service with an env_file differently in the two, and
# reported a drift on every deploy.
warn_if_drifted() {
  local svc=$1 plan
  [[ -n $(container_of "$svc") ]] || return 0
  # Captured whole before it is searched: under pipefail, a grep -q that stops reading early can kill
  # compose with SIGPIPE and turn a real drift into silence.
  plan=$(dc --dry-run up --detach --no-deps "$svc" 2>&1 || true)
  grep -Eq "agencyboost-$svc-1[[:space:]]+Recreate" <<<"$plan" || return 0
  log "WARNING: ========================================================================================"
  log "WARNING: $svc's definition in compose.yml has changed since its container was created."
  log "WARNING: It keeps running as it was: a deploy never recreates $svc, and boot uses --no-recreate."
  log "WARNING: Recreate it deliberately, at a quiet time (docs/03-engineering/deployment-gcp.md):"
  log "WARNING:   sudo $AB_HOME/bin/compose.sh up --detach --no-deps --force-recreate $svc"
  log "WARNING: ========================================================================================"
  # The same, as an annotation on the GitHub Actions run, which reads workflow commands from this
  # output when the workflow ran the deploy.
  printf '::warning::%s on the shared VM: its compose definition changed and its container was not recreated (deploy.sh, M4)\n' \
    "$svc" >&2
}

# 0 once the service's container reports healthy. 1 when it reports unhealthy, has exited, has
# restarted at all (a crash loop never reports unhealthy, it only starts again), or the time is up.
wait_healthy() {
  local svc=$1 deadline=$((SECONDS + $2)) id info state health restarts
  while ((SECONDS < deadline)); do
    id=$(container_of "$svc")
    if [[ -n $id ]]; then
      info=$(docker inspect \
        --format '{{.State.Status}} {{.RestartCount}} {{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' \
        "$id" 2>/dev/null || true)
      read -r state restarts health <<<"$info"
      case $state:$health in
        running:healthy) log "$svc is healthy"; return 0 ;;
        *:unhealthy) log "$svc reports unhealthy"; return 1 ;;
        exited:* | dead:*) log "$svc has $state"; return 1 ;;
      esac
      if [[ ${restarts:-0} != 0 ]]; then
        log "$svc has restarted $restarts time(s) since it was created"
        return 1
      fi
    fi
    sleep 2
  done
  log "$svc was not healthy after $2s"
  return 1
}

# The failed container's last lines, into the deploy's own log where the workflow shows them.
show_logs() {
  local id
  id=$(container_of "$1")
  [[ -n $id ]] || return 0
  log "the last lines $1 wrote:"
  docker logs --tail 80 "$id" 2>&1 | sed "s/^/  $1| /" >&2 || true
}

# The Caddyfile this deploy replaced, back in place, when this deploy replaced one: never a stale copy
# from an earlier deploy (P18.4 review, L1). Caddy keeps running whatever it last loaded; this is about
# the file it would start from after a reboot.
restore_caddyfile() {
  if [[ $caddyfile_changed == 1 && -f $AB_HOME/state/Caddyfile.previous ]]; then
    cat "$AB_HOME/state/Caddyfile.previous" >"$AB_HOME/Caddyfile"
    log "put the previous Caddyfile back"
  fi
}

# Before the switch, a failure leaves the VM exactly as it was: the env file the running API would be
# recreated with, and the Caddyfile Caddy would start from.
abort_before_switch() {
  if [[ -f $env_file.previous ]]; then mv -f "$env_file.previous" "$env_file"; fi
  restore_caddyfile
  die "$1. Nothing was switched: $service is as it was"
}

rollback() {
  restore_caddyfile
  [[ -n $previous ]] \
    || die "$image did not become healthy, and $env has no earlier image on this VM to return to. $service is DOWN"
  log "rolling back $service to $previous"
  # The previous image with the environment it last ran with: a key the new code needed and the old
  # code rejects is a reason for exactly this rollback.
  if [[ -f $env_file.previous ]]; then mv -f "$env_file.previous" "$env_file"; fi
  export "$image_var=$previous"
  dc up --detach --no-deps "$service"
  wait_healthy "$service" "$HEALTH_TIMEOUT" \
    || die "the rollback of $service to $previous did not become healthy either. $service is DOWN"
  die "$image failed its health check. $previous is serving $env again; this deploy failed"
}

# --- arguments -------------------------------------------------------------------------------------

[[ ${1:-} == -h || ${1:-} == --help ]] && { usage; exit 0; }
if [[ $# -lt 2 ]]; then usage >&2; exit 64; fi
readonly env=$1
shift
require_env "$env"
bundle=""
while (($#)); do
  case $1 in
    --bundle)
      [[ $# -ge 2 ]] || die "--bundle needs a directory"
      bundle=$2
      shift 2
      ;;
    --) shift; break ;;
    -*) usage >&2; die "unknown option: $1" ;;
    *) break ;;
  esac
done
if [[ $# -ne 1 ]]; then usage >&2; exit 64; fi
readonly image=$1

require_root
# By digest, never by tag, and from this environment's own repository (lib.sh).
require_own_image "$image" "$env" api

# Here, in the caller's session: hand the deploy to systemd and follow it (M2). The unit runs this
# same script, from the same place, with an absolute bundle path: its working directory is /.
if [[ ${AB_IN_UNIT:-} != 1 ]]; then
  unit_args=("$env")
  if [[ -n $bundle ]]; then
    [[ -d $bundle ]] || die "--bundle $bundle is not a directory"
    unit_args+=(--bundle "$(cd "$bundle" && pwd -P)")
  fi
  status=0
  run_detached deploy "$AB_HOME/bin/deploy.sh" "${unit_args[@]}" "$image" || status=$?
  exit "$status"
fi

readonly service=api-$env
readonly env_file=$AB_HOME/env/api-$env.env
image_var=$(image_var_of "$env")
readonly image_var
state_dir=$(state_of "$env")
readonly state_dir

# --- 1, 2, 3 ---------------------------------------------------------------------------------------

# The re-exec below inherits fd 9, and the lock with it.
if [[ ${AB_DEPLOY_REEXEC:-} != 1 ]]; then take_lock; fi
require_data_disk

if [[ -n $bundle && ${AB_DEPLOY_REEXEC:-} != 1 ]]; then
  install_bundle "$bundle"
  AB_DEPLOY_REEXEC=1 AB_CADDYFILE_CHANGED=$caddyfile_changed exec "$AB_HOME/bin/deploy.sh" "$env" "$image"
fi
caddyfile_changed=${AB_CADDYFILE_CHANGED:-$caddyfile_changed}

node_env=$(node_env_of "$env")
db=$(db_of "$env")
install -d -m 0700 "$state_dir"
log "deploying $image to $env ($service)"

# --- 4 ---------------------------------------------------------------------------------------------

# A copy left by an earlier deploy is not this deploy's to restore: an abort before the copy below
# would put back the env file of two deploys ago.
rm -f "$env_file.previous"
next=$(fetch_secret "api-env-$env" "$env_file")
# The other environment's secret in this one's slot stops here, before anything moves. On a shared VM
# the database name matters most: it is the database this API, and its migrations, would write to.
for line in "NODE_ENV=$node_env" "MONGODB_DB_NAME=$db"; do
  if ! grep -qx "$line" "$next"; then
    rm -f "$next"
    abort_before_switch "api-env-$env does not contain the line $line"
  fi
done
# So does a template copied in with a <placeholder> still in it.
unfilled=$(unfilled_keys "$next")
if [[ -n $unfilled ]]; then
  rm -f "$next"
  abort_before_switch "api-env-$env still has a <placeholder> for: $(echo "$unfilled" | tr '\n' ' ')"
fi
if [[ -f $env_file ]]; then cp -p "$env_file" "$env_file.previous"; fi
mv -f "$next" "$env_file"

# Mongo reads its root and app credentials only when it initialises an empty data directory, so this
# file is rendered once, by the first deploy of either environment. Rotating them is a procedure of its
# own (the runbook), not a deploy.
if [[ ! -f $AB_HOME/env/mongo.env ]]; then
  next=$(fetch_secret mongo-root "$AB_HOME/env/mongo.env")
  missing=$(missing_mongo_keys "$next")
  if [[ -n $missing ]]; then
    rm -f "$next"
    abort_before_switch "the secret mongo-root lacks a value for: $(echo "$missing" | tr '\n' ' ')"
  fi
  mv -f "$next" "$AB_HOME/env/mongo.env"
fi

touch "$AB_HOME/state/images.env"
export "$image_var=$image"
previous=$(cat "$state_dir/current" 2>/dev/null || true)

ensure_started mongo
wait_healthy mongo 120 || abort_before_switch "mongo is not healthy"
ensure_started caddy

# A changed Caddyfile is checked by the Caddy that will load it, before the API moves: a file it
# refuses would otherwise surface only at the next reboot, as a VM serving nothing at all.
if [[ $caddyfile_changed == 1 ]] \
  && ! dc exec -T caddy caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null; then
  abort_before_switch "Caddy refused the new Caddyfile"
fi

warn_if_drifted mongo
warn_if_drifted caddy

# --- 5 ---------------------------------------------------------------------------------------------

(assert_db_scope "$env") || abort_before_switch "$env's database user is not confined to $db"

# --- 6, 7 ------------------------------------------------------------------------------------------

log "pulling $image"
dc pull --quiet "$service" || abort_before_switch "could not pull $image"

log "running $env's migrations in a one-off container of the new image"
dc run --rm --no-deps -T "$service" node dist/migrations/run.js \
  || abort_before_switch "the migrations failed"

# --- 8, 9 ------------------------------------------------------------------------------------------

log "switching $service to $image"
dc up --detach --no-deps "$service"
if ! wait_healthy "$service" "$HEALTH_TIMEOUT"; then
  show_logs "$service"
  rollback
fi

# --- 10 --------------------------------------------------------------------------------------------

set_image "$env" "$image"
if [[ -n $previous && $previous != "$image" ]]; then
  printf '%s\n' "$previous" >"$state_dir/previous"
fi
printf '%s\n' "$image" >"$state_dir/current"

# Validated above, so a refusal here is unexpected; it still leaves the previous file and config live.
caddy_refused=0
if [[ $caddyfile_changed == 1 ]]; then
  if dc exec -T caddy caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile; then
    log "reloaded Caddy with the new Caddyfile"
  else
    restore_caddyfile
    caddy_refused=1
  fi
fi

prune_images

log "deployed $image to $env"
if ((caddy_refused)); then
  die "$env is deployed, but Caddy refused to reload and is still running its previous configuration"
fi
