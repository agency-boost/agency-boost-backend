# shellcheck shell=bash
#
# Shared by every script in /opt/agencyboost/bin (P18.4-T3, ADR-0152, ADR-0155). Sourced, never run.
#
# One VM serves both environments (ADR-0155). The layout, which deploy/ in the repository mirrors:
#
#   /opt/agencyboost/compose.yml, Caddyfile, mongo/init/   installed from deploy/ by deploy.sh
#   /opt/agencyboost/bin/                                   these scripts
#   /opt/agencyboost/env/                                   0700: api-staging.env and api-prod.env and
#                                                           mongo.env (rendered from Secret Manager),
#                                                           compose.env (bootstrap.sh)
#   /opt/agencyboost/state/                                 0700: images.env, the lock, and per
#                                                           environment staging/ and prod/: the current
#                                                           and previous digests
#   /mnt/mongo-data/                                        the separate data disk
#
# An environment is `staging` or `prod`. Its API is the compose service api-<env>, in the profile <env>.

readonly AB_HOME=/opt/agencyboost
readonly AB_DATA=/mnt/mongo-data
readonly AB_SENTINEL=$AB_DATA/.agencyboost-data-disk
readonly AB_LOCK=$AB_HOME/state/deploy.lock
readonly AB_ENVS=(staging prod)

# gcloud from Ubuntu's snap lives in /snap/bin, which a systemd unit's PATH may not include.
export PATH=$PATH:/snap/bin

log() {
  printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >&2
  # And to the journal, so the Ops Agent carries it to Cloud Logging, unless stderr is the journal
  # already: systemd sets JOURNAL_STREAM for a unit whose output it collects (run_detached's).
  if [[ -z ${JOURNAL_STREAM:-} ]]; then
    logger --tag agencyboost -- "$*" 2>/dev/null || true
  fi
}

die() {
  log "error: $*"
  exit 1
}

require_root() {
  [[ $EUID -eq 0 ]] || die "run this as root (sudo $0)"
}

# One value from env/compose.env, which bootstrap.sh wrote: API_HOST_PROD, IMAGE_REGISTRY, ...
setting() {
  local value
  value=$(sed -n "s/^$1=//p" "$AB_HOME/env/compose.env" 2>/dev/null | tail -n 1)
  [[ -n $value ]] || die "$1 is not set in $AB_HOME/env/compose.env (run vm/bootstrap.sh)"
  printf '%s\n' "$value"
}

# --- environments ----------------------------------------------------------------------------------

# **The functions here prefix their locals with _ wherever a caller's global might share the name.**
# deploy.sh and seed.sh hold `env` and `image` in readonly globals, and a `local env` in a function they
# call cannot shadow a readonly variable: bash refuses, and the function dies on its first line.

require_env() {
  case ${1:-} in
    staging | prod) ;;
    *) die "the environment is staging or prod, not '${1:-}'" ;;
  esac
}
node_env_of() { if [[ $1 == prod ]]; then echo production; else echo staging; fi; }
db_of() { if [[ $1 == prod ]]; then echo agencyboost; else echo agencyboost_staging; fi; }
image_var_of() { if [[ $1 == prod ]]; then echo API_IMAGE_PROD; else echo API_IMAGE_STAGING; fi; }
state_of() { echo "$AB_HOME/state/$1"; }

# The environments that have a deployed image, comma-separated: the compose profiles to activate.
deployed_profiles() {
  local _e out=""
  for _e in "${AB_ENVS[@]}"; do
    if [[ -s $AB_HOME/state/$_e/current ]]; then out+="${out:+,}$_e"; fi
  done
  printf '%s\n' "$out"
}

# Record <env>'s image in state/images.env, keeping the other environment's line as it is.
set_image() {
  local var file=$AB_HOME/state/images.env
  var=$(image_var_of "$1")
  touch "$file"
  { grep -v "^$var=" "$file" || true; printf '%s=%s\n' "$var" "$2"; } >"$file.new"
  mv -f "$file.new" "$file"
}

# --- compose ---------------------------------------------------------------------------------------

# Every compose invocation goes through here, so the project name, the file and the two variable
# files are spelled once. A shell-exported API_IMAGE_<ENV> overrides state/images.env, which is how
# deploy.sh runs a new image before it records it. The profiles are the deployed environments, so
# `up` at boot starts only those; a service named on the command line is started whatever its profile.
dc() {
  COMPOSE_PROFILES=${COMPOSE_PROFILES-$(deployed_profiles)} docker compose \
    --project-name agencyboost \
    --project-directory "$AB_HOME" \
    --file "$AB_HOME/compose.yml" \
    --env-file "$AB_HOME/env/compose.env" \
    --env-file "$AB_HOME/state/images.env" \
    "$@"
}

# The id of a service's own container, running or not, or nothing. By compose's labels rather than
# `compose ps`: a one-off container (`compose run`, the migrations, the seed) carries the same service
# name, and is not the service (P18.4 review, L4).
container_of() {
  docker ps --all --quiet \
    --filter "label=com.docker.compose.project=agencyboost" \
    --filter "label=com.docker.compose.service=$1" \
    --filter "label=com.docker.compose.oneoff=False"
}

# --- guards ----------------------------------------------------------------------------------------

# **Mongo never runs on the boot disk.** /mnt/mongo-data is an empty directory on the boot disk
# whenever the data disk is not mounted, and a Mongo started there would initialise a new, empty
# database and serve it. Two checks, because either alone can be fooled: the mount point proves
# something is mounted, the sentinel (written by bootstrap.sh onto the data disk) proves it is ours.
require_data_disk() {
  mountpoint -q "$AB_DATA" \
    || die "$AB_DATA is not a mount point: the data disk is detached or failed to mount. Refusing to continue."
  [[ -f $AB_SENTINEL ]] \
    || die "$AB_SENTINEL is missing: what is mounted at $AB_DATA is not the AgencyBoost data disk. Refusing to continue."
}

# One deploy, seed or backup at a time, across both environments: they share one Mongo (ADR-0155).
# The lock is held on fd 9 until the process exits, and survives exec.
take_lock() {
  exec 9>"$AB_LOCK"
  flock --wait "${1:-600}" 9 || die "another deploy, seed or backup holds $AB_LOCK"
}

# An image this VM may run for <env>: by digest, never by tag, and from that environment's own
# repository, <IMAGE_REGISTRY>/agencyboost-<env> (provision.sh). The whole reference is matched,
# anchored at both ends (P18.4 review, L3), so a staging image cannot be deployed as production's.
require_own_image() {
  local _ref=$1 _env=$2 _name=$3 _repository _pattern
  _repository=$(setting IMAGE_REGISTRY)/agencyboost-$_env/$_name
  _pattern="^${_repository//./\\.}@sha256:[0-9a-f]{64}\$"
  [[ $_ref =~ $_pattern ]] \
    || die "expected $_repository@sha256:<64 hex>, $_env's own image by digest; got: $_ref"
}

# The keys of an env file whose value is still a template's <placeholder>, one per line.
unfilled_keys() {
  sed -n 's/^\([A-Za-z_][A-Za-z0-9_]*\)=<.*/\1/p' "$1"
}

# The keys mongo/init/01-app-users.js and the image's entrypoint need, missing or unfilled in $1, one per
# line (P18.4 review, L9). An empty data directory is initialised with whatever this file says, once.
missing_mongo_keys() {
  local key value
  for key in MONGO_INITDB_ROOT_USERNAME MONGO_INITDB_ROOT_PASSWORD \
    MONGO_PROD_USERNAME MONGO_PROD_PASSWORD MONGO_STAGING_USERNAME MONGO_STAGING_PASSWORD; do
    value=$(sed -n "s/^$key=//p" "$1" | tail -n 1)
    if [[ -z $value || $value == \<* ]]; then printf '%s\n' "$key"; fi
  done
}

# **<env>'s API reaches its own database and nothing else** (ADR-0155). Connects with the MONGODB_URI
# in env/api-<env>.env, as that API will, and asks Mongo which user that is and which roles it holds.
# Anything but exactly one user in <env>'s database, with readWrite on <env>'s database alone, stops the
# caller. It writes nothing. The URI travels by environment variable into the mongo container, never
# on a command line.
assert_db_scope() {
  local _env=$1 _db _uri _report _want_users _want_roles
  _db=$(db_of "$_env")
  _uri=$(sed -n 's/^MONGODB_URI=//p' "$AB_HOME/env/api-$_env.env" | tail -n 1)
  [[ -n $_uri ]] || die "env/api-$_env.env has no MONGODB_URI"
  # shellcheck disable=SC2016
  _report=$(CHECK_URI=$_uri docker exec -e CHECK_URI "$(container_of mongo)" mongosh --nodb --quiet --norc --eval '
    const s = connect(process.env.CHECK_URI).runCommand({ connectionStatus: 1 });
    print(JSON.stringify({
      users: s.authInfo.authenticatedUsers.map((u) => u.db),
      roles: s.authInfo.authenticatedUserRoles.map((r) => r.role + "@" + r.db),
    }));
  ' 2>&1) || die "could not connect with $_env's MONGODB_URI: $(tail -n 1 <<<"$_report")"
  _want_users="\"users\":[\"$_db\"]"
  _want_roles="\"roles\":[\"readWrite@$_db\"]"
  [[ $_report == *"$_want_users"* && $_report == *"$_want_roles"* ]] \
    || die "$_env's database user is not confined to $_db (Mongo reports $_report). Refusing: on this shared VM that user's roles are the only thing between $_env and the other environment's data"
  log "$_env's database user holds readWrite on $_db and nothing else"
}

# --- images ----------------------------------------------------------------------------------------

# Old api and tools images, except the current and previous of each environment, which a rollback or
# the next seed would need (P18.4 review, L2). Named by state/, not guessed by age; an image a container
# still uses is refused by docker and kept.
prune_images() {
  local registry _e name file ref id keep=""
  registry=$(setting IMAGE_REGISTRY)
  for _e in "${AB_ENVS[@]}"; do
    for file in current previous tools-current tools-previous; do
      ref=$(cat "$AB_HOME/state/$_e/$file" 2>/dev/null || true)
      [[ -n $ref ]] || continue
      id=$(docker image inspect --format '{{.Id}}' "$ref" 2>/dev/null || true)
      keep+=" $id "
    done
  done
  for _e in "${AB_ENVS[@]}"; do
    for name in api tools; do
      while read -r id; do
        [[ -n $id && $keep != *" $id "* ]] || continue
        if docker rmi "$id" >/dev/null 2>&1; then log "removed an old $_e $name image, $id"; fi
      done < <(docker images --no-trunc --quiet "$registry/agencyboost-$_e/$name" | sort -u)
    done
  done
}

# --- running detached ------------------------------------------------------------------------------

# Run "$@" as a transient systemd unit and follow its journal here; return the unit's exit status
# (P18.4 review, M2). Run as a child of an SSH session, a deploy dies with the session: sshd hangs up
# the shell when the connection drops, and a deploy killed between the migrations and the switch, or a
# seed killed halfway, leaves the VM in a state nobody chose. As a unit it belongs to systemd. A
# dropped client stops only the following, and the work runs to the end, lock and all.
run_detached() {
  local kind=$1 unit follower status=0
  shift
  unit=agencyboost-$kind-$(date -u +%Y%m%dT%H%M%SZ)-$$
  log "running as $unit.service: a dropped connection no longer stops it. To follow it: sudo journalctl -fu $unit"
  journalctl --follow --no-tail --output=cat --unit="$unit.service" &
  follower=$!
  systemd-run --unit="$unit" --collect --wait --quiet \
    --property=SyslogIdentifier="agencyboost-$kind" \
    --property=RuntimeMaxSec=3600 \
    --setenv=HOME=/root \
    --setenv=AB_IN_UNIT=1 \
    -- "$@" || status=$?
  # The journal reaches its readers a moment after its writers; let the last lines arrive.
  sleep 2
  kill "$follower" 2>/dev/null || true
  wait "$follower" 2>/dev/null || true
  return "$status"
}
