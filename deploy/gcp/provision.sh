#!/usr/bin/env bash
#
# Provision the one GCP project AgencyBoost's staging and production share, around the VM that is
# already running there (P18.7-T3, ADR-0152, ADR-0153, ADR-0155).
#
#   deploy/gcp/provision.sh --project <id> --github-owner-id <n> --github-repo-id <n> [options]
#
# It adopts the existing VM (default agencyboost-backend in asia-southeast2-b) rather than creating
# one. It does not stop it: the one change that needs a stop is printed, or made with --apply-vm-identity.
#
# The two numeric ids pin Workload Identity Federation to this repository: a name can be renamed and
# then reused by somebody else, an id cannot. To read them:
#
#   gh api repos/agency-boost/agency-boost-backend --jq '"--github-owner-id \(.owner.id) --github-repo-id \(.id)"'
#
# Options:
#   --project <id>            the project (required)
#   --instance <name>         the VM to adopt (default agencyboost-backend)
#   --zone <zone>             its zone (default asia-southeast2-b)
#   --data-disk <name>        its data disk (default mongodb)
#   --alert-email <address>   mail this address when a nightly backup fails: an email notification
#                             channel and a log-based alert policy on AGENCYBOOST_BACKUP_FAILED
#   --apply-vm-identity       also stop the VM, give it api-runtime with scope cloud-platform, and start
#                             it again: a minute or so of downtime for both environments
#   --dry-run                 print every command that would change something, and change nothing
#
# Idempotent where gcloud allows: a resource that exists is left as it is and reported, and the IAM
# bindings, CORS and lifecycle rules are applied again, which changes nothing when nothing changed. A
# snapshot schedule cannot be edited once created; to change one, detach, delete and run this again.
#
# Run it as a person with Owner on the project. It ends by printing the GitHub variables, the DNS
# records, and the commands it deliberately leaves to a person.
set -euo pipefail
export CLOUDSDK_CORE_DISABLE_PROMPTS=1

usage() { sed -n '3,32p' "$0" | sed 's/^# \{0,1\}//'; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }
say() { printf '\n== %s\n' "$*" >&2; }
note() { printf '   %s\n' "$*" >&2; }

dry_run=0
# Everything that changes something goes through here, so --dry-run is exact.
run() {
  printf '+ %s\n' "$*" >&2
  if ((dry_run)); then return 0; fi
  "$@"
}
exists() { "$@" >/dev/null 2>&1; }

# --- arguments -------------------------------------------------------------------------------------

project="" instance=agencyboost-backend zone=asia-southeast2-b data_disk=mongodb
owner_id="" repo_id="" alert_email="" apply_identity=0
while (($#)); do
  case $1 in
    --project) project=${2:?}; shift 2 ;;
    --instance) instance=${2:?}; shift 2 ;;
    --zone) zone=${2:?}; shift 2 ;;
    --data-disk) data_disk=${2:?}; shift 2 ;;
    --github-owner-id) owner_id=${2:?}; shift 2 ;;
    --github-repo-id) repo_id=${2:?}; shift 2 ;;
    --alert-email) alert_email=${2:?}; shift 2 ;;
    --apply-vm-identity) apply_identity=1; shift ;;
    --dry-run) dry_run=1; shift ;;
    -h | --help) usage; exit 0 ;;
    *) usage >&2; die "unknown argument: $1" ;;
  esac
done
[[ -n $project ]] || die "--project is required (see --help)"
[[ $owner_id =~ ^[0-9]+$ && $repo_id =~ ^[0-9]+$ ]] \
  || die "--github-owner-id and --github-repo-id are required, and numeric (see --help)"
[[ -z $alert_email || $alert_email =~ ^[^@\"[:space:]]+@[^@\"[:space:]]+$ ]] \
  || die "--alert-email '$alert_email' is not an email address"

readonly region=${zone%-*}
readonly envs=(staging prod)
readonly runtime_sa=api-runtime@$project.iam.gserviceaccount.com
readonly backups=agencyboost-backups
readonly snapshot_policy=agencyboost-$data_disk
readonly address=$instance-ip
readonly tag=agencyboost-backend
readonly secrets=(api-env-staging api-env-prod mongo-root)

gh_env() { if [[ $1 == prod ]]; then echo production; else echo staging; fi; }
gh_branch() { if [[ $1 == prod ]]; then echo main; else echo development; fi; }
builder_sa() { echo "gh-builder-$1@$project.iam.gserviceaccount.com"; }
deployer_sa() { echo "gh-deployer-$1@$project.iam.gserviceaccount.com"; }
app_origin() { if [[ $1 == prod ]]; then echo https://agencyboost.id; else echo https://staging.agencyboost.id; fi; }
api_host() { if [[ $1 == prod ]]; then echo api.agencyboost.id; else echo staging-api.agencyboost.id; fi; }

here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
for env in "${envs[@]}"; do [[ -f $here/cors.$env.json ]] || die "$here/cors.$env.json is missing"; done
command -v gcloud >/dev/null || die "gcloud is not installed"

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

project_number=$(gcloud projects describe "$project" --format='value(projectNumber)' 2>/dev/null) \
  || die "project $project does not exist, or you cannot see it (gcloud auth login?)"
if ((dry_run)); then say "DRY RUN: nothing below is executed"; fi

describe_vm() { gcloud compute instances describe "$instance" --project="$project" --zone="$zone" --format="value($1)" 2>/dev/null; }
exists gcloud compute instances describe "$instance" --project="$project" --zone="$zone" \
  || die "no VM $instance in $zone. This script adopts a VM that already exists (made in the console) and creates none. Creating one comes back with ADR-0155's exit, production on its own VM"
vm_ip=$(describe_vm 'networkInterfaces[0].accessConfigs[0].natIP')
vm_network=$(describe_vm 'networkInterfaces[0].network.basename()')
vm_sa=$(describe_vm 'serviceAccounts[0].email')
vm_scopes=$(describe_vm 'serviceAccounts[0].scopes')
exists gcloud compute disks describe "$data_disk" --project="$project" --zone="$zone" \
  || die "no disk $data_disk in $zone (--data-disk)"
say "adopting $instance in $project ($project_number), $zone: network $vm_network, address ${vm_ip:-none}, identity ${vm_sa:-none}"

# --- APIs ------------------------------------------------------------------------------------------

say "APIs"
run gcloud services enable --project="$project" \
  compute.googleapis.com artifactregistry.googleapis.com secretmanager.googleapis.com \
  iam.googleapis.com iamcredentials.googleapis.com sts.googleapis.com iap.googleapis.com \
  oslogin.googleapis.com storage.googleapis.com logging.googleapis.com monitoring.googleapis.com

# --- service accounts ------------------------------------------------------------------------------

say "service accounts"
ensure_sa() {
  if exists gcloud iam service-accounts describe "$1" --project="$project"; then
    note "$1 exists"
  else
    run gcloud iam service-accounts create "${1%%@*}" --project="$project" --display-name="$2"
  fi
}
# The VM's own identity, replacing the default compute account, which usually holds project Editor and
# must never be given cloud-platform. Both APIs run as it (ADR-0155: an accepted risk while dark).
ensure_sa "$runtime_sa" "AgencyBoost APIs on the VM (staging and production)"
for env in "${envs[@]}"; do
  # Per environment, and split by job (P18.7 review, M6): the builder may push that environment's images
  # and nothing else; the deployer may SSH in and run that environment's deploy, and push nothing.
  ensure_sa "$(builder_sa "$env")" "GitHub Actions builder, $env: push images"
  ensure_sa "$(deployer_sa "$env")" "GitHub Actions deployer, $env: SSH to the VM"
done

bind_project() {
  run gcloud projects add-iam-policy-binding "$project" \
    --member="serviceAccount:$1" --role="$2" --condition=None >/dev/null
}
# A project-level custom role, created or brought up to date: ensure_role <id> <title> <permissions>.
ensure_role() {
  if exists gcloud iam roles describe "$1" --project="$project"; then
    run gcloud iam roles update "$1" --project="$project" --permissions="$3" >/dev/null
  else
    run gcloud iam roles create "$1" --project="$project" --stage=GA \
      --title="$2" --description="$2 (P18.7, ADR-0152)" --permissions="$3" >/dev/null
  fi
}

say "roles: api-runtime (the VM)"
bind_project "$runtime_sa" roles/logging.logWriter
bind_project "$runtime_sa" roles/monitoring.metricWriter
# signBlob on itself, through the IAM credentials API: how a VM with no key file signs the upload
# policies and read URLs (ADR-0153).
run gcloud iam service-accounts add-iam-policy-binding "$runtime_sa" --project="$project" \
  --member="serviceAccount:$runtime_sa" --role=roles/iam.serviceAccountTokenCreator >/dev/null

say "roles: the deployers"
for env in "${envs[@]}"; do
  sa=$(deployer_sa "$env")
  bind_project "$sa" roles/iap.tunnelResourceAccessor
  bind_project "$sa" roles/compute.osLogin
  bind_project "$sa" roles/compute.viewer
  # SSH to a VM that runs as a service account requires acting as that account.
  run gcloud iam service-accounts add-iam-policy-binding "$runtime_sa" --project="$project" \
    --member="serviceAccount:$sa" --role=roles/iam.serviceAccountUser >/dev/null
done
# The snapshot every production deploy takes first (D4), and nothing more: no delete, no restore.
ensure_role agencyboostPredeploySnapshot "AgencyBoost pre-deploy snapshot" \
  compute.disks.createSnapshot,compute.snapshots.create,compute.snapshots.get,compute.snapshots.setLabels,compute.globalOperations.get,compute.zoneOperations.get
bind_project "$(deployer_sa prod)" "projects/$project/roles/agencyboostPredeploySnapshot"

# --- buckets ---------------------------------------------------------------------------------------

say "buckets"
ensure_bucket() {
  local bucket=gs://$1
  if exists gcloud storage buckets describe "$bucket" --project="$project"; then
    note "$bucket exists"
  else
    run gcloud storage buckets create "$bucket" --project="$project" \
      --location="$region" --default-storage-class=STANDARD \
      --uniform-bucket-level-access --public-access-prevention
  fi
  # Applied to an existing bucket too: none may ever serve an object to the public.
  run gcloud storage buckets update "$bucket" --uniform-bucket-level-access --public-access-prevention
}
bind_bucket() {
  run gcloud storage buckets add-iam-policy-binding "gs://$1" \
    --member="serviceAccount:$2" --role="$3" >/dev/null
}

for env in "${envs[@]}"; do
  bucket=agencyboost-$env-assets
  ensure_bucket "$bucket"
  # The browser posts uploads straight to the bucket from that environment's app (ADR-0153).
  run gcloud storage buckets update "gs://$bucket" --cors-file="$here/cors.$env.json"
  # Create and read, never delete: a replayed upload form cannot overwrite what it already wrote, and
  # erasure (P19-T1) gets a signer of its own.
  bind_bucket "$bucket" "$runtime_sa" roles/storage.objectCreator
  bind_bucket "$bucket" "$runtime_sa" roles/storage.objectViewer
done

# One bucket of backups, a prefix per environment, each prefix with its own lifetime (D4).
ensure_bucket "$backups"
cat >"$work/lifecycle.json" <<'EOF'
{
  "rule": [
    { "action": { "type": "Delete" }, "condition": { "age": 30, "matchesPrefix": ["prod/"] } },
    { "action": { "type": "Delete" }, "condition": { "age": 7, "matchesPrefix": ["staging/"] } }
  ]
}
EOF
run gcloud storage buckets update "gs://$backups" --lifecycle-file="$work/lifecycle.json"
# Versioning stays off, so a name can be written once and nothing replaces what is under it.
run gcloud storage buckets update "gs://$backups" --no-versioning
# Create and read, never delete (P18.7 review, M1). `gcloud storage cp` reads the destination before it
# writes, which objectCreator alone does not allow. Overwriting needs delete, so this role cannot
# replace a backup either: a VM that is compromised can add a backup and never remove one.
ensure_role agencyboostBackupWriter "AgencyBoost backup writer" \
  storage.objects.create,storage.objects.get,storage.multipartUploads.create,storage.multipartUploads.abort,storage.multipartUploads.listParts
bind_bucket "$backups" "$runtime_sa" "projects/$project/roles/agencyboostBackupWriter"

# --- Artifact Registry -----------------------------------------------------------------------------

# A repository per environment (P18.7 review). Only that environment's gh-builder may push to it, so
# no staging identity can put an image where production pulls from; the VM reads both. Tags are
# immutable: once pushed, a tag names one digest for good.
cat >"$work/cleanup.json" <<'EOF'
[
  { "name": "keep-recent", "action": { "type": "Keep" }, "mostRecentVersions": { "keepCount": 40 } },
  { "name": "delete-old", "action": { "type": "Delete" }, "condition": { "tagState": "any", "olderThan": "90d" } }
]
EOF
for env in "${envs[@]}"; do
  repository=agencyboost-$env
  say "Artifact Registry: $region-docker.pkg.dev/$project/$repository (immutable tags)"
  if exists gcloud artifacts repositories describe "$repository" --project="$project" --location="$region"; then
    note "the repository exists; making sure its tags are immutable"
    run gcloud artifacts repositories update "$repository" --project="$project" --location="$region" \
      --immutable-tags >/dev/null
  else
    run gcloud artifacts repositories create "$repository" --project="$project" \
      --location="$region" --repository-format=docker --immutable-tags \
      --description="AgencyBoost api and tools images, $env (ADR-0152, ADR-0155)"
  fi
  # The newest 40 versions of each image stay whatever their age; anything else goes at 90 days. The VM
  # keeps each environment's current and previous images locally, so a rollback never depends on this.
  run gcloud artifacts repositories set-cleanup-policies "$repository" --project="$project" \
    --location="$region" --policy="$work/cleanup.json" --no-dry-run >/dev/null
  run gcloud artifacts repositories add-iam-policy-binding "$repository" --project="$project" \
    --location="$region" --member="serviceAccount:$(builder_sa "$env")" --role=roles/artifactregistry.writer >/dev/null
  run gcloud artifacts repositories add-iam-policy-binding "$repository" --project="$project" \
    --location="$region" --member="serviceAccount:$runtime_sa" --role=roles/artifactregistry.reader >/dev/null
done

# --- secrets ---------------------------------------------------------------------------------------

say "secrets (created empty: the runbook says what goes in them)"
for secret in "${secrets[@]}"; do
  if exists gcloud secrets describe "$secret" --project="$project"; then
    note "secret $secret exists"
  else
    # Replicated in Jakarta only: the API's credentials stay in the region its data does (UU 27/2022).
    run gcloud secrets create "$secret" --project="$project" \
      --replication-policy=user-managed --locations="$region" --labels=app=agencyboost
  fi
  run gcloud secrets add-iam-policy-binding "$secret" --project="$project" \
    --member="serviceAccount:$runtime_sa" --role=roles/secretmanager.secretAccessor >/dev/null
done

# --- the VM: what changes without a stop -----------------------------------------------------------

say "the VM's network: firewall, static address"
run gcloud compute instances add-tags "$instance" --project="$project" --zone="$zone" --tags="$tag"
ensure_firewall() {
  local name=$1
  shift
  if exists gcloud compute firewall-rules describe "$name" --project="$project"; then
    note "firewall rule $name exists"
  else
    run gcloud compute firewall-rules create "$name" --project="$project" --network="$vm_network" \
      --direction=INGRESS --action=allow --target-tags="$tag" "$@"
  fi
}
ensure_firewall agencyboost-allow-web --rules=tcp:80,tcp:443 --source-ranges=0.0.0.0/0
# SSH from Identity-Aware Proxy's range: every SSH, the deploys' included, goes through IAP.
ensure_firewall agencyboost-allow-iap-ssh --rules=tcp:22 --source-ranges=35.235.240.0/20

# The VM's ephemeral address, kept: promoted to a static one, so a stop (the identity change below)
# does not change the address both DNS records point at.
if exists gcloud compute addresses describe "$address" --project="$project" --region="$region"; then
  note "address $address exists"
elif [[ -n $vm_ip ]]; then
  run gcloud compute addresses create "$address" --project="$project" --region="$region" --addresses="$vm_ip"
else
  die "$instance has no external address to promote"
fi
static_ip=$(gcloud compute addresses describe "$address" --project="$project" --region="$region" \
  --format='value(address)' 2>/dev/null || echo "$vm_ip")

say "the data disk's snapshots: every 4 hours, kept 14 days (D4, production's rule; one disk, both databases)"
if exists gcloud compute resource-policies describe "$snapshot_policy" --project="$project" --region="$region"; then
  note "snapshot schedule $snapshot_policy exists (a schedule cannot be edited; see --help)"
else
  run gcloud compute resource-policies create snapshot-schedule "$snapshot_policy" \
    --project="$project" --region="$region" --storage-location="$region" \
    --hourly-schedule=4 --start-time=00:00 --max-retention-days=14 \
    --on-source-disk-delete=keep-auto-snapshots \
    --description="AgencyBoost Mongo data (staging and production), every 4 h, 14 days (D4)"
fi
if ! gcloud compute disks describe "$data_disk" --project="$project" --zone="$zone" \
  --format='value(resourcePolicies)' 2>/dev/null | grep -q "/$snapshot_policy"; then
  run gcloud compute disks add-resource-policies "$data_disk" --project="$project" --zone="$zone" \
    --resource-policies="$snapshot_policy"
fi

say "the VM: OS Login, the deployers bootstrap.sh reads, deletion protection"
uid_of() {
  gcloud iam service-accounts describe "$1" --project="$project" --format='value(uniqueId)' 2>/dev/null || echo '<uniqueId>'
}
run gcloud compute instances add-metadata "$instance" --project="$project" --zone="$zone" \
  --metadata="enable-oslogin=TRUE,agencyboost-deployer-staging=sa_$(uid_of "$(deployer_sa staging)"),agencyboost-deployer-prod=sa_$(uid_of "$(deployer_sa prod)")"
run gcloud compute instances update "$instance" --project="$project" --zone="$zone" --deletion-protection

# --- Workload Identity Federation ------------------------------------------------------------------

say "Workload Identity Federation: pool github, provider github-oidc"
if exists gcloud iam workload-identity-pools describe github --project="$project" --location=global; then
  note "pool github exists"
else
  run gcloud iam workload-identity-pools create github --project="$project" --location=global \
    --display-name="GitHub Actions"
fi
mapping="google.subject=assertion.sub,attribute.repository=assertion.repository,attribute.repository_id=assertion.repository_id,attribute.repository_owner_id=assertion.repository_owner_id,attribute.environment=assertion.environment,attribute.ref=assertion.ref,attribute.workflow_ref=assertion.workflow_ref"
# A token is exchanged at all only when everything about it matches one environment (P18.7 review, M6):
# this repository and its owner, by numeric id; then either staging, from development, through
# deploy.yml or seed-staging.yml, or production, from main, through deploy.yml. workflow_ref is
# `<owner>/<repo>/.github/workflows/<file>@<ref>`; it is matched by its end, so a rename of the
# repository changes nothing here while the ids still pin which repository it is.
wf() { echo "assertion.workflow_ref.endsWith('/.github/workflows/$1@refs/heads/$2')"; }
condition="assertion.repository_owner_id == '$owner_id' && assertion.repository_id == '$repo_id' && ("
condition+="(assertion.environment == 'staging' && assertion.ref == 'refs/heads/development' && ($(wf deploy.yml development) || $(wf seed-staging.yml development)))"
condition+=" || (assertion.environment == 'production' && assertion.ref == 'refs/heads/main' && $(wf deploy.yml main))"
condition+=")"
note "attribute condition: $condition"
if exists gcloud iam workload-identity-pools providers describe github-oidc --project="$project" \
  --location=global --workload-identity-pool=github; then
  run gcloud iam workload-identity-pools providers update-oidc github-oidc --project="$project" \
    --location=global --workload-identity-pool=github \
    --attribute-mapping="$mapping" --attribute-condition="$condition"
else
  run gcloud iam workload-identity-pools providers create-oidc github-oidc --project="$project" \
    --location=global --workload-identity-pool=github \
    --display-name="GitHub OIDC" \
    --issuer-uri=https://token.actions.githubusercontent.com \
    --attribute-mapping="$mapping" --attribute-condition="$condition"
fi
# Only jobs running in an environment may become that environment's accounts, and production accepts
# deployments from main alone (D5). Which account a job asks for is the workflow's.
for env in "${envs[@]}"; do
  for sa in "$(builder_sa "$env")" "$(deployer_sa "$env")"; do
    run gcloud iam service-accounts add-iam-policy-binding "$sa" --project="$project" \
      --role=roles/iam.workloadIdentityUser \
      --member="principalSet://iam.googleapis.com/projects/$project_number/locations/global/workloadIdentityPools/github/attribute.environment/$(gh_env "$env")" \
      >/dev/null
  done
done

# --- alerting ------------------------------------------------------------------------------------------

# A failed backup logs AGENCYBOOST_BACKUP_FAILED (agencyboost-backup-failed.service), which the Ops
# Agent carries to Cloud Logging. With --alert-email, that line mails the operators (P18.7 review, M1).
# Through the Monitoring REST API with curl, because the gcloud commands for alert policies are alpha.
if [[ -n $alert_email ]]; then
  policy_name="AgencyBoost backup failed"
  say "alerting: '$policy_name' mails $alert_email"
  monitoring=https://monitoring.googleapis.com/v3/projects/$project
  if ((dry_run)); then
    note "would find or create an email channel for $alert_email, and the log-based policy '$policy_name'"
  else
    token=$(gcloud auth print-access-token)
    api() { curl -fsS -H "Authorization: Bearer $token" -H 'Content-Type: application/json' "$@"; }
    resource_name() { sed -n "s/^ *\"name\": \"\(projects\/[^\"]*\/$1\/[^\"\/]*\)\".*/\1/p" | head -n 1; }

    channel=$(api -G --data-urlencode "filter=type=\"email\" AND labels.email_address=\"$alert_email\"" \
      "$monitoring/notificationChannels" | resource_name notificationChannels)
    if [[ -z $channel ]]; then
      channel=$(api -X POST "$monitoring/notificationChannels" --data \
        "{\"type\":\"email\",\"displayName\":\"AgencyBoost operators\",\"labels\":{\"email_address\":\"$alert_email\"}}" \
        | resource_name notificationChannels)
      [[ -n $channel ]] || die "could not create the notification channel for $alert_email"
      note "created notification channel $channel"
    else
      note "notification channel $channel exists"
    fi

    existing=$(api -G --data-urlencode "filter=display_name=\"$policy_name\"" "$monitoring/alertPolicies" \
      | resource_name alertPolicies)
    if [[ -n $existing ]]; then
      note "alert policy $existing exists"
    else
      cat >"$work/policy.json" <<POLICY
{
  "displayName": "$policy_name",
  "combiner": "OR",
  "severity": "ERROR",
  "conditions": [{
    "displayName": "agencyboost-backup.service failed",
    "conditionMatchedLog": {
      "filter": "resource.type=\"gce_instance\" AND \"AGENCYBOOST_BACKUP_FAILED\""
    }
  }],
  "alertStrategy": { "notificationRateLimit": { "period": "3600s" }, "autoClose": "604800s" },
  "notificationChannels": ["$channel"],
  "documentation": {
    "mimeType": "text/markdown",
    "content": "The nightly mongodump on $instance failed, for staging, production or both. On the VM: journalctl -u agencyboost-backup. Runbook: docs/03-engineering/deployment-gcp.md, Backups."
  }
}
POLICY
      api -X POST "$monitoring/alertPolicies" --data @"$work/policy.json" >/dev/null
      note "created the alert policy '$policy_name'"
    fi
  fi
fi

# --- the VM's identity: the one change that needs a stop -------------------------------------------

identity_commands=(
  "gcloud compute instances stop $instance --project=$project --zone=$zone"
  "gcloud compute instances set-service-account $instance --project=$project --zone=$zone --service-account=$runtime_sa --scopes=cloud-platform"
  "gcloud compute instances start $instance --project=$project --zone=$zone"
)
say "the VM's identity: api-runtime with scope cloud-platform"
if [[ $vm_sa == "$runtime_sa" && $vm_scopes == *cloud-platform* ]]; then
  note "$instance already runs as $runtime_sa with cloud-platform"
  identity_pending=0
elif ((apply_identity)); then
  # A stop is a minute or so of downtime for both environments. The address is static by now.
  for command in "${identity_commands[@]}"; do
    read -r -a words <<<"$command"
    run "${words[@]}"
  done
  identity_pending=0
else
  note "$instance runs as ${vm_sa:-nothing} with scopes ${vm_scopes:-none}: it cannot read Secret Manager, sign"
  note "upload URLs or write a backup until this changes. It needs a stop, so it is not done without"
  note "--apply-vm-identity. The commands are printed at the end."
  identity_pending=1
fi

# --- what to do with it ----------------------------------------------------------------------------

cat <<EOF

Done: $project, around $instance.

GitHub, backend repository, Settings > Environments > staging and > production, Environment variables.
The same in both:

  GCP_PROJECT_ID     $project
  GCP_WIF_PROVIDER   projects/$project_number/locations/global/workloadIdentityPools/github/providers/github-oidc
  GCE_INSTANCE       $instance
  GCE_ZONE           $zone

Per environment:

                     staging                                             production
  GCP_BUILD_SA       $(builder_sa staging)   $(builder_sa prod)
  GCP_DEPLOY_SA      $(deployer_sa staging)  $(deployer_sa prod)
  API_HOST           $(api_host staging)                          $(api_host prod)
  APP_ORIGIN         $(app_origin staging)                       $(app_origin prod)

  and restrict each environment's deployment branches: staging to development, production to main.

The registries follow from GCP_PROJECT_ID: $region-docker.pkg.dev/$project/agencyboost-staging and
$region-docker.pkg.dev/$project/agencyboost-prod. There is no variable for them.

DNS: A records for $(api_host prod) and $(api_host staging), both pointing at $static_ip

EOF
if ((identity_pending)); then
  cat <<EOF
The VM's identity (a stop: a minute or so of downtime; or run this script with --apply-vm-identity):

$(printf '  %s\n' "${identity_commands[@]}")

EOF
fi
if exists gcloud compute firewall-rules describe default-allow-ssh --project="$project"; then
  cat <<EOF
The default network's default-allow-ssh opens port 22 to the whole internet, for every VM in the
project. With agencyboost-allow-iap-ssh in place it is no longer needed by this VM. It is not removed
here because it affects every VM in the project; when nothing else depends on it:

  gcloud compute firewall-rules delete default-allow-ssh --project=$project

EOF
fi
cat <<EOF
Then, in order (docs/03-engineering/deployment-gcp.md):
  1. add a version to api-env-staging and api-env-prod (deploy/env/api.env.example) and to mongo-root
     (deploy/env/mongo.env.example)
  2. run deploy/vm/bootstrap.sh on $instance
  3. run the deploy workflow for staging, then for production
EOF
