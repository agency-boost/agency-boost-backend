#!/usr/bin/env bash
#
# A logical backup of each environment's database into the backups bucket (P18.4-T3, ADR-0152,
# ADR-0155, plan decision D4). agencyboost-backup.timer runs it nightly; it is also safe by hand:
#
#   sudo /opt/agencyboost/bin/backup.sh
#
# One MongoDB holds both environments on this VM (ADR-0155), so one run dumps each deployed
# environment's database on its own (--db), each to its own prefix of the one bucket:
#
#   gs://agencyboost-backups/prod/<UTC time>.archive.gz      agencyboost            kept 30 days
#   gs://agencyboost-backups/staging/<UTC time>.archive.gz   agencyboost_staging    kept 7 days
#
# The bucket's lifecycle deletes by prefix (provision.sh). A restore takes one database without the
# other.
#
# This is the second line of defence. The first is the data disk's snapshot schedule (every 4 hours,
# kept 14 days) plus the snapshot every production deploy takes first; one disk holds both databases, so
# each snapshot covers both. A dump survives what a snapshot does not: the disk and its snapshots
# deleted, a disk whose data was already wrong when snapshotted, or a restore that needs one database or
# one collection rather than a whole disk. It does **not** survive the project being deleted, because
# the bucket is in the same project (P18.4 review, L7). A backups bucket in a separate project, or a
# locked retention policy, is a P20-T6 option.
#
# A failure is reported: agencyboost-backup.service's OnFailure= logs AGENCYBOOST_BACKUP_FAILED,
# which the alert provision.sh --alert-email creates mails to the operators (P18.4 review, M1). One
# database failing does not stop the other's backup; the run fails at the end if either did.
#
# **Dumped to a file first, then uploaded, rather than streamed into the bucket.** The VM's account
# holds a custom role on the backups bucket: create objects, list and read them, never delete or overwrite
# (ADR-0152; provision.sh, agencyboostBackupWriter). A streamed upload whose dump failed halfway would
# leave a truncated archive under a good name, which nothing on this VM could remove and the next
# restore drill would find first. A file is checked before it leaves, and the upload of a file either
# completes or creates nothing.
set -euo pipefail
umask 077

here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=lib.sh
. "$here/lib.sh"

readonly BUCKET=gs://agencyboost-backups

require_root
# The VM-wide lock: never in the middle of a deploy's migrations or a seed's --reset.
take_lock 1800
require_data_disk

mongo=$(container_of mongo)
[[ -n $mongo && $(docker inspect --format '{{.State.Status}}' "$mongo") == running ]] \
  || die "mongo is not running: nothing to back up"

work=$(mktemp -d /var/tmp/agencyboost-backup.XXXXXX)
trap 'rm -rf "$work"' EXIT
stamp=$(date -u +%Y-%m-%dT%H%M%SZ)

# One database, dumped, checked and uploaded. 0 when it all worked.
backup_one() {
  local env=$1 db archive object
  db=$(db_of "$env")
  archive=$work/$env-$stamp.archive.gz
  object=$BUCKET/$env/$stamp.archive.gz

  log "dumping $db ($env) to $archive"
  # The root password goes to mongodump as a config file on its standard input, so it never appears in
  # a process listing, on this VM or in the container. Both variables are the container's own, from
  # env/mongo.env; the single quotes keep this shell from expanding them. The database name is passed
  # in by environment variable for the same reason it is quoted: nothing here is re-parsed.
  # shellcheck disable=SC2016
  if ! DUMP_DB=$db docker exec -i -e DUMP_DB "$mongo" sh -c '
    printf "password: %s\n" "$MONGO_INITDB_ROOT_PASSWORD" | mongodump \
      --quiet \
      --config=/dev/stdin \
      --username="$MONGO_INITDB_ROOT_USERNAME" \
      --authenticationDatabase=admin \
      --db="$DUMP_DB" \
      --archive \
      --gzip
  ' >"$archive"; then
    log "mongodump of $db failed"
    return 1
  fi
  [[ -s $archive ]] || { log "mongodump produced an empty archive for $db"; return 1; }
  gzip --test "$archive" || { log "mongodump produced an archive for $db that is not valid gzip"; return 1; }

  log "uploading $(du -h "$archive" | cut -f1) to $object"
  # One object, never a parallel composite: that uploads parts and deletes them afterwards, and this
  # account may not delete. --no-clobber reads the destination first, which is what objects.get is for;
  # the name is unique to the second, so it only ever matters when a run is repeated by hand.
  if ! CLOUDSDK_STORAGE_PARALLEL_COMPOSITE_UPLOAD_ENABLED=False \
    gcloud storage cp --quiet --no-clobber "$archive" "$object"; then
    log "the upload of $object failed"
    return 1
  fi
  log "backup $object written"
}

failed=""
backed_up=0
for env in "${AB_ENVS[@]}"; do
  # An environment never deployed here has no database to dump.
  [[ -s $(state_of "$env")/current ]] || continue
  backed_up=$((backed_up + 1))
  backup_one "$env" || failed+=" $env"
done

((backed_up)) || die "neither environment has been deployed on this VM: nothing to back up"
[[ -z $failed ]] || die "the backup failed for:$failed"
log "backed up $backed_up database(s)"
