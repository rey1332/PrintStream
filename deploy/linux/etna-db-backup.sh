#!/bin/sh
# Daily backup of one ETNA database (the Linux counterpart of
# scripts/server/etna-db-backup.cmd). Run by etna-db-backup.timer as the
# postgres system user on the database server:
#
#   etna-db-backup.sh <database> <folder>
#   etna-db-backup.sh etna /var/backups/etna
#
# Connects through the local socket (peer authentication; PGHOST, PGPORT and
# PGUSER may point elsewhere). Keeps 14 daily dumps plus the dump of the 1st
# of each month for a year. Copy the folder to another machine as well.
set -eu

DB=${1:-}
DIR=${2:-}
if [ -z "$DB" ] || [ -z "$DIR" ]; then
  echo "Usage: etna-db-backup.sh database folder" >&2
  exit 2
fi

umask 077
mkdir -p "$DIR/monthly"
STAMP=$(date +%Y%m%d-%H%M%S)
FILE="$DIR/$DB-$STAMP.dump"

if ! pg_dump -w -d "$DB" -Fc -f "$FILE"; then
  echo "[$(date -Is)] FAILED $DB" >>"$DIR/backup.log"
  rm -f "$FILE"
  exit 1
fi
echo "[$(date -Is)] ok $DB-$STAMP.dump" >>"$DIR/backup.log"

if [ "$(date +%d)" = "01" ]; then cp "$FILE" "$DIR/monthly/"; fi
find "$DIR" -maxdepth 1 -name "$DB-*.dump" -type f -mtime +14 -delete
find "$DIR/monthly" -maxdepth 1 -name "$DB-*.dump" -type f -mtime +366 -delete
