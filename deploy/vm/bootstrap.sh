#!/usr/bin/env bash
#
# One-time setup of the AgencyBoost VM, which serves staging and production both (P18.7-T3, ADR-0152,
# ADR-0155). Ubuntu 24.04 or 26.04, or Debian 12. Idempotent: run again, it repairs what is missing and
# leaves alone what is already right. It never formats a disk that has anything on it.
#
# From a checkout of this repository, after deploy/gcp/provision.sh has adopted the VM:
#
#   gcloud compute scp --recurse --tunnel-through-iap --zone=asia-southeast2-b \
#     deploy agencyboost-backend:agencyboost-bootstrap
#   gcloud compute ssh agencyboost-backend --tunnel-through-iap --zone=asia-southeast2-b \
#     --command='sudo bash agencyboost-bootstrap/vm/bootstrap.sh && rm -rf agencyboost-bootstrap'
#
# What it reads from the instance metadata provision.sh wrote, unless an option says otherwise:
#
#   --deployer-staging sa_<id>  agencyboost-deployer-staging: gh-deployer-staging's OS Login username
#   --deployer-prod sa_<id>     agencyboost-deployer-prod: gh-deployer-prod's OS Login username
#   --image-registry <host/p>   asia-southeast2-docker.pkg.dev/<this VM's project>; each environment's
#                               images come from <that>/agencyboost-<env> and nowhere else
#   --api-host-staging <host>   default staging-api.agencyboost.id
#   --api-host-prod <host>      default api.agencyboost.id
#   --data-device <path>        default /dev/disk/by-id/google-mongodb (the disk's device name, mongodb)
#   --swap <size>               default 2G (an e2-small has 2 GB for two APIs and Mongo); 0 for none
#
# What it does:
#   1. Docker with compose 2.30 or later (from Docker's apt repository when it publishes this release,
#      else Ubuntu's own packages), the Cloud CLI, unattended security upgrades, and the Ops Agent where
#      it is supported (best-effort: without it the logs stay on this VM, and the backup alert is blind)
#   2. Docker's own log rotation, and live-restore so a daemon upgrade does not stop Mongo
#   3. a swapfile
#   4. the data disk: formatted XFS only if it is blank, reused as it is if it holds a filesystem,
#      refused if it holds a partition table; mounted by UUID with nofail at /mnt/mongo-data, db/ owned by
#      Mongo's uid 999, and the sentinel file
#   5. /opt/agencyboost/{bin,env,state}, the files from deploy/, and env/compose.env
#   6. Docker credentials for Artifact Registry, through the VM's own service account
#   7. the systemd units: the stack enabled for boot, the nightly backup timer started
#   8. the deployers' sudoers rules: gh-deployer-staging may run `deploy.sh staging …` and
#      `seed.sh staging …`, gh-deployer-prod `deploy.sh prod …`, and nothing else
#
# It starts no container. The first deploy does, once Secret Manager holds the env files.
set -euo pipefail
shopt -s nullglob
umask 022

src=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
# shellcheck source=../bin/lib.sh
. "$src/bin/lib.sh"

readonly REGISTRY_HOST=asia-southeast2-docker.pkg.dev
# What deploy/compose.yml needs: env_file `format: raw` arrived in Compose 2.30.0 (2.29.7 refuses it).
readonly COMPOSE_MIN=2.30.0

metadata() {
  curl -fsS -H 'Metadata-Flavor: Google' \
    "http://metadata.google.internal/computeMetadata/v1/$1" 2>/dev/null || true
}
warn() { log "WARNING: $*"; }

# --- arguments -------------------------------------------------------------------------------------

deployer_staging="" deployer_prod="" image_registry=""
api_host_staging=staging-api.agencyboost.id api_host_prod=api.agencyboost.id
data_device=/dev/disk/by-id/google-mongodb swap_size=2G
while (($#)); do
  case $1 in
    --deployer-staging) deployer_staging=${2:?}; shift 2 ;;
    --deployer-prod) deployer_prod=${2:?}; shift 2 ;;
    --image-registry) image_registry=${2:?}; shift 2 ;;
    --api-host-staging) api_host_staging=${2:?}; shift 2 ;;
    --api-host-prod) api_host_prod=${2:?}; shift 2 ;;
    --data-device) data_device=${2:?}; shift 2 ;;
    --swap) swap_size=${2:?}; shift 2 ;;
    -h | --help) sed -n '2,40p' "$0"; exit 0 ;;
    *) die "unknown argument: $1 (see --help)" ;;
  esac
done

require_root
# shellcheck source=/dev/null
. /etc/os-release
case ${ID:-}:${VERSION_ID:-} in
  ubuntu:24.04 | ubuntu:26.04 | debian:12) ;;
  *) die "this is ${PRETTY_NAME:-an unknown system}; bootstrap.sh supports Ubuntu 24.04 and 26.04, and Debian 12" ;;
esac

deployer_staging=${deployer_staging:-$(metadata instance/attributes/agencyboost-deployer-staging)}
deployer_prod=${deployer_prod:-$(metadata instance/attributes/agencyboost-deployer-prod)}
if [[ -z $image_registry ]]; then
  project_id=$(metadata project/project-id)
  [[ -n $project_id ]] || die "cannot read this VM's project from the metadata server: pass --image-registry"
  image_registry=$REGISTRY_HOST/$project_id
fi
# An OS Login username for a service account is sa_ followed by its numeric unique id.
for pair in "staging:$deployer_staging" "prod:$deployer_prod"; do
  [[ ${pair#*:} =~ ^sa_[0-9]+$ ]] \
    || die "the ${pair%%:*} deployer is '${pair#*:}': pass --deployer-${pair%%:*} sa_<gh-deployer-${pair%%:*}'s uniqueId>, or set the metadata agencyboost-deployer-${pair%%:*} (provision.sh does)"
done
[[ $deployer_staging != "$deployer_prod" ]] || die "the staging and production deployers must be two accounts"

log "bootstrapping $PRETTY_NAME for staging ($api_host_staging) and production ($api_host_prod), images from $image_registry"

# --- 1. packages -----------------------------------------------------------------------------------

export DEBIAN_FRONTEND=noninteractive
apt-get update -q
apt-get install -y -q ca-certificates curl gnupg sudo util-linux xfsprogs unattended-upgrades apt-listchanges

compose_version() { docker compose version --short 2>/dev/null | sed 's/^v//'; }

if ! docker compose version >/dev/null 2>&1; then
  # Docker's own repository when it publishes this release; a new Ubuntu can arrive before it does.
  if curl -fsSI "https://download.docker.com/linux/$ID/dists/$VERSION_CODENAME/Release" >/dev/null 2>&1; then
    log "installing Docker CE and the compose plugin from download.docker.com ($ID $VERSION_CODENAME)"
    install -m 0755 -d /etc/apt/keyrings
    curl -fsSL "https://download.docker.com/linux/$ID/gpg" -o /etc/apt/keyrings/docker.asc
    chmod a+r /etc/apt/keyrings/docker.asc
    printf 'deb [arch=%s signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/%s %s stable\n' \
      "$(dpkg --print-architecture)" "$ID" "$VERSION_CODENAME" >/etc/apt/sources.list.d/docker.list
    apt-get update -q
    apt-get install -y -q docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
  elif [[ $ID == ubuntu ]]; then
    log "download.docker.com has no $VERSION_CODENAME yet: installing Ubuntu's docker.io and docker-compose-v2"
    apt-get install -y -q docker.io docker-compose-v2
  else
    die "download.docker.com publishes nothing for $ID $VERSION_CODENAME, and this system has no fallback"
  fi
fi
have=$(compose_version)
[[ -n $have && $(printf '%s\n%s\n' "$COMPOSE_MIN" "$have" | sort -V | head -n 1) == "$COMPOSE_MIN" ]] \
  || die "docker compose is ${have:-missing}; deploy/compose.yml needs $COMPOSE_MIN or later (env_file format: raw). Install a newer docker-compose-plugin and run this again"
log "docker compose $have"

# The Cloud CLI from Google's repository unless the system's is there: deploy.sh reads Secret Manager
# with it, backup.sh writes to Cloud Storage, and Docker signs in to Artifact Registry through its
# credential helper. A snap gcloud (Ubuntu's images) has no helper Docker can find.
if [[ ! -x /usr/bin/gcloud ]]; then
  log "installing google-cloud-cli from packages.cloud.google.com"
  curl -fsSL https://packages.cloud.google.com/apt/doc/apt-key.gpg | gpg --dearmor --yes -o /usr/share/keyrings/cloud.google.gpg
  echo 'deb [signed-by=/usr/share/keyrings/cloud.google.gpg] https://packages.cloud.google.com/apt cloud-sdk main' \
    >/etc/apt/sources.list.d/google-cloud-sdk.list
  apt-get update -q
  apt-get install -y -q google-cloud-cli
fi

# Security updates only, which is the distribution's default origin list. No automatic reboot: a
# kernel update waits for a person, because a reboot restarts Mongo, and on this VM both environments.
cat >/etc/apt/apt.conf.d/20auto-upgrades <<'EOF'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
EOF

# The Ops Agent, where Google supports this release. Without it nothing on this VM reaches Cloud
# Logging: the logs stay in the journal and the containers' files, and the backup-failure alert
# (provision.sh --alert-email) never fires, because the line it waits for never arrives.
if ! dpkg -s google-cloud-ops-agent >/dev/null 2>&1; then
  log "installing the Ops Agent"
  if ! { curl -fsSL https://dl.google.com/cloudagents/add-google-cloud-ops-agent-repo.sh -o /tmp/add-ops-agent-repo.sh \
    && bash /tmp/add-ops-agent-repo.sh --also-install; }; then
    warn "the Ops Agent did not install on $PRETTY_NAME. Logs stay on this VM, and a failed backup alerts nobody: check journalctl -t agencyboost-backup -p err by hand, or install the agent once Google supports this release, then run bootstrap.sh again"
  fi
  rm -f /tmp/add-ops-agent-repo.sh
fi

# The agent ships syslog files and host metrics by default. This adds two sources. The journal is where
# deploy.sh, seed.sh and backup.sh log, and where a failed backup's AGENCYBOOST_BACKUP_FAILED line is
# written; a minimal image has no syslog file, and the backup alert reads this line (M1). The
# containers' own output is the other: Docker keeps it as JSON lines under /var/lib/docker/containers.
if [[ -d /etc/google-cloud-ops-agent ]]; then
  ops_config=$(cat <<'EOF'
# Written by deploy/vm/bootstrap.sh (P18.7-T3). The defaults (syslog, host metrics) still apply.
logging:
  receivers:
    agencyboost_journal:
      type: systemd_journald
    agencyboost_containers:
      type: files
      include_paths:
        - /var/lib/docker/containers/*/*-json.log
  processors:
    agencyboost_docker_json:
      type: parse_json
  service:
    pipelines:
      agencyboost_journal:
        receivers: [agencyboost_journal]
      agencyboost_containers:
        receivers: [agencyboost_containers]
        processors: [agencyboost_docker_json]
EOF
  )
  if [[ $(cat /etc/google-cloud-ops-agent/config.yaml 2>/dev/null) != "$ops_config" ]]; then
    printf '%s\n' "$ops_config" >/etc/google-cloud-ops-agent/config.yaml
    systemctl restart google-cloud-ops-agent || warn "the Ops Agent did not restart with the new configuration"
  fi
fi

# --- 2. the Docker daemon --------------------------------------------------------------------------

daemon_json=$(cat <<'EOF'
{
  "log-driver": "json-file",
  "log-opts": { "max-size": "10m", "max-file": "5" },
  "live-restore": true
}
EOF
)
install -d -m 0755 /etc/docker
if [[ $(cat /etc/docker/daemon.json 2>/dev/null) != "$daemon_json" ]]; then
  log "writing /etc/docker/daemon.json"
  printf '%s\n' "$daemon_json" >/etc/docker/daemon.json
  systemctl restart docker
fi
systemctl enable --now docker >/dev/null

# --- 3. swap ---------------------------------------------------------------------------------------

# Two APIs, Mongo and Caddy fill most of an e2-small's 2 GB (compose.yml). Swap is what lets a
# migration or a seed run beside them without the kernel killing one (ADR-0155).
if [[ $swap_size != 0 ]] && ! swapon --show=NAME --noheadings | grep -qx /swapfile; then
  log "adding a $swap_size swapfile"
  if [[ ! -f /swapfile ]]; then
    fallocate -l "$swap_size" /swapfile
    chmod 0600 /swapfile
    mkswap /swapfile >/dev/null
  fi
  swapon /swapfile
  grep -q '^/swapfile[[:space:]]' /etc/fstab || echo '/swapfile none swap sw 0 0' >>/etc/fstab
  install -d -m 0755 /etc/sysctl.d
  echo 'vm.swappiness = 10' >/etc/sysctl.d/90-agencyboost-swap.conf
  sysctl --quiet --load /etc/sysctl.d/90-agencyboost-swap.conf
fi

# --- 4. the data disk ------------------------------------------------------------------------------

[[ -b $data_device ]] \
  || die "$data_device is missing: the data disk is not attached, or not under that device name (the VM's is mongodb)"

# blkid -p probes the device itself and finds a filesystem or a partition table alike. Only a disk on
# which it finds nothing at all is formatted: a disk restored from a snapshot, one formatted by hand,
# or a re-run of this script, must never be.
if ! blkid -p "$data_device" >/dev/null 2>&1; then
  log "the data disk is blank: formatting it XFS (MongoDB's recommended filesystem for WiredTiger)"
  mkfs.xfs -q -L mongo-data "$data_device"
fi
fstype=$(blkid -o value -s TYPE "$data_device" || true)
uuid=$(blkid -o value -s UUID "$data_device" || true)
if [[ -z $fstype || -z $uuid ]]; then
  pttype=$(blkid -p -o value -s PTTYPE "$data_device" 2>/dev/null || true)
  die "$data_device holds ${pttype:+a $pttype partition table and }no filesystem of its own. Not touching it. If it is meant to be empty, check what is on it (lsblk -f $data_device) and clear it yourself (wipefs --all $data_device), then run this again"
fi
[[ $fstype == xfs ]] || log "the data disk already holds $fstype: reusing it as it is"

install -d -m 0755 "$AB_DATA"
# By UUID, so a device renamed after a reattach still mounts; nofail, so a VM booted without the disk
# still boots far enough to be reached and fixed, while agencyboost.service refuses to start.
fstab_line="UUID=$uuid $AB_DATA $fstype defaults,noatime,discard,nofail 0 0"
if ! grep -qE "^[^#]*[[:space:]]${AB_DATA}[[:space:]]" /etc/fstab; then
  echo "$fstab_line" >>/etc/fstab
  systemctl daemon-reload
elif ! grep -qxF "$fstab_line" /etc/fstab; then
  warn "/etc/fstab already mounts $AB_DATA differently; leaving it. Expected: $fstab_line"
fi
mountpoint -q "$AB_DATA" || mount "$AB_DATA"
mountpoint -q "$AB_DATA" || die "$AB_DATA did not mount"

# Reused as it is, but said aloud when it holds something this script did not put there.
unexpected=$(find "$AB_DATA" -mindepth 1 -maxdepth 1 ! -name lost+found ! -name db ! -name "${AB_SENTINEL##*/}" -printf '%f ' 2>/dev/null)
[[ -z $unexpected ]] || warn "$AB_DATA already holds: $unexpected. Left as it is; Mongo uses $AB_DATA/db only"

# Mongo's container runs as uid 999. Only the directory itself is chowned: a restored disk already
# carries the right owner on every file, and a recursive chown of a large database is minutes of IO.
install -d -m 0700 -o 999 -g 999 "$AB_DATA/db"
chown 999:999 "$AB_DATA/db"
if [[ ! -f $AB_SENTINEL ]]; then
  printf 'The AgencyBoost data disk, for staging and production both, set up by deploy/vm/bootstrap.sh.\nagencyboost.service and bin/deploy.sh refuse to start Mongo when this file is absent.\n' \
    >"$AB_SENTINEL"
fi

# --- 5. /opt/agencyboost ---------------------------------------------------------------------------

install -d -m 0755 "$AB_HOME" "$AB_HOME/bin" "$AB_HOME/mongo" "$AB_HOME/mongo/init"
install -d -m 0700 "$AB_HOME/env" "$AB_HOME/state" "$AB_HOME/state/staging" "$AB_HOME/state/prod"

install -m 0644 "$src/compose.yml" "$AB_HOME/compose.yml"
# In place, as deploy.sh does: Caddy bind-mounts this file by inode.
if ! cmp -s "$src/Caddyfile" "$AB_HOME/Caddyfile"; then
  cat "$src/Caddyfile" >"$AB_HOME/Caddyfile"
  chmod 0644 "$AB_HOME/Caddyfile"
fi
for f in "$AB_HOME"/mongo/init/*; do [[ -e $src/mongo/init/${f##*/} ]] || rm -f "$f"; done
for f in "$src"/mongo/init/*.js; do install -m 0644 "$f" "$AB_HOME/mongo/init/"; done
for f in "$src"/bin/*.sh; do install -m 0755 "$f" "$AB_HOME/bin/"; done

# What every compose invocation reads (bin/lib.sh). Written once; a re-run adds a key that is missing
# and changes none that is there, so an operator's edit survives.
compose_env=$AB_HOME/env/compose.env
[[ -f $compose_env ]] || printf '# Written by deploy/vm/bootstrap.sh. Read by every compose invocation (bin/lib.sh).\n' >"$compose_env"
chmod 0600 "$compose_env"
for kv in \
  "API_HOST_PROD=$api_host_prod" \
  "API_HOST_STAGING=$api_host_staging" \
  "IMAGE_REGISTRY=$image_registry" \
  "MONGO_CACHE_GB=0.25" \
  "MONGO_MEM_LIMIT=700m" \
  "API_MEM_LIMIT=512m" \
  "CADDY_MEM_LIMIT=128m"; do
  grep -q "^${kv%%=*}=" "$compose_env" || echo "$kv" >>"$compose_env"
done
touch "$AB_HOME/state/images.env"
chmod 0600 "$AB_HOME/state/images.env"

# --- 6. registry credentials -----------------------------------------------------------------------

# Through the VM's service account (api-runtime, artifactregistry.reader on both repositories): no
# key on disk.
gcloud auth configure-docker "$REGISTRY_HOST" --quiet >/dev/null 2>&1 \
  || warn "gcloud auth configure-docker failed; deploys cannot pull until it works"

# --- 7. systemd ------------------------------------------------------------------------------------

for f in "$src"/systemd/agencyboost*; do install -m 0644 "$f" /etc/systemd/system/; done
systemctl daemon-reload
# Enabled for boot, not started: it waits for a first deploy (ConditionPathExistsGlob=state/*/current).
systemctl enable agencyboost.service >/dev/null
systemctl enable --now agencyboost-backup.timer >/dev/null

# --- 8. the deployers' one privilege each ----------------------------------------------------------

# The environment is deploy.sh's first argument so these rules can pin it: sudo matches the rule's
# arguments against the whole command line, and "staging *" matches only a line that begins with the
# word staging. deploy.sh and seed.sh then refuse any first word but an exact staging or prod. The
# seed is staging's alone: production is never seeded (D11).
sudoers_tmp=$(mktemp)
cat >"$sudoers_tmp" <<EOF
# Written by deploy/vm/bootstrap.sh (P18.7-T3, ADR-0155). The GitHub deployers, over IAP SSH.
$deployer_staging ALL=(root) NOPASSWD: $AB_HOME/bin/deploy.sh staging *, $AB_HOME/bin/seed.sh staging *
$deployer_prod ALL=(root) NOPASSWD: $AB_HOME/bin/deploy.sh prod *
EOF
visudo -cqf "$sudoers_tmp" || { rm -f "$sudoers_tmp"; die "the sudoers rules did not validate"; }
install -m 0440 -o root -g root "$sudoers_tmp" /etc/sudoers.d/agencyboost-deployer
rm -f "$sudoers_tmp"

log "bootstrap complete. Next: give api-env-staging, api-env-prod and mongo-root a version in Secret Manager, then deploy"
