#!/usr/bin/env bash
# Installs, reinstalls or updates ETNA on a Linux server with systemd
# (docs/teknis/INSTALL-LINUX.md). Run as root from the folder of an ETNA checkout or
# release. Running it again is always safe: it never drops, empties or
# recreates a database, and never replaces existing keys.
#
#   sudo deploy/linux/install.sh                      asks where PostgreSQL is (first install)
#   sudo deploy/linux/install.sh --local-postgres     PostgreSQL 18 on this server (installed when missing)
#   sudo deploy/linux/install.sh --database-url postgres://etna_owner@db.lan:5432/etna?sslmode=verify-full
#                                                     an existing PostgreSQL (the owner's password is asked,
#                                                     or read from PGPASSWORD)
#   sudo deploy/linux/install.sh --settings-from /root/etna.env
#                                                     an existing ETNA database: its etna.env (keys) from
#                                                     the old server or another app server
#   sudo deploy/linux/install.sh                      later: an update (settings are kept)
#
#   sudo deploy/linux/install.sh --database-url <owner url> --settings-from /root/etna.env #        --shared-data 10.0.0.10:/var/lib/etna
#                                                     an extra app server (docs/teknis/CLUSTER.md): the
#                                                     first server's data folder over NFS (psctl cluster share)
#
# Other options: --yes (no questions), --no-backup (no backup before an update).
# MIGRATION_DATABASE_URL + PGPASSWORD in the environment work as --database-url.
#
# What it does, in this order (an update stops before the switch if anything fails):
#   1. checks Node.js (22.18 or newer), npm and systemd;
#   2. creates the system user etna and the folders
#        /opt/etna/releases/<version>  the app versions (the current and the previous one)
#        /opt/etna/current             symlink to the version that runs
#        /etc/etna/etna.env            app settings and keys (root:etna, 0640)
#        /etc/etna/psctl.env           psctl's settings: the owner connection (root, 0600)
#        /etc/etna/owner.pgpass        the owner's password (root, 0600)
#        /var/lib/etna                 ETNA_DATA_ROOT: documents, company folders, cache
#   3. finds the database (and, with --local-postgres, installs PostgreSQL and
#      creates the owner role and database when they do not exist);
#   4. copies the app to a new release folder, installs its packages and builds it;
#   5. the first time: an empty database is prepared and etna.env written with
#      new keys; a database that already holds ETNA needs its etna.env
#      (--settings-from) and is never given new keys. Later: a backup (when set
#      up with psctl backup-setup), then the new migrations;
#   6. switches /opt/etna/current, installs psctl and the systemd units, (re)starts
#      etna and etna-worker and checks /api/health; when the new version does not
#      answer, the previous one is put back.
set -euo pipefail

PREFIX=/opt/etna
CONFIG_DIR=/etc/etna
ENV_FILE=$CONFIG_DIR/etna.env
CTL_FILE=$CONFIG_DIR/psctl.env
OWNER_PGPASS=$CONFIG_DIR/owner.pgpass
DATA_ROOT=/var/lib/etna
UNIT_DIR=/etc/systemd/system
PG_MAJOR=18

say() { printf '\033[1m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[33m%s\033[0m\n' "$*" >&2; }
die() { printf '\033[31mError:\033[0m %s\n' "$*" >&2; exit 1; }

LOCAL_PG=
MODE=
DB_URL=${MIGRATION_DATABASE_URL:-}
SETTINGS_FROM=
YES=
NO_BACKUP=
SHARED_DATA=
while [ $# -gt 0 ]; do
  case "$1" in
    --local-postgres) LOCAL_PG=1 ;;
    --database-url) DB_URL=${2:-}; shift ;;
    --settings-from) SETTINGS_FROM=${2:-}; shift ;;
    --yes) YES=1 ;;
    --no-backup) NO_BACKUP=1 ;;
    --shared-data) SHARED_DATA=${2:-}; shift ;;
    -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
    *) die "unknown option $1 (--help lists them)." ;;
  esac
  shift
done
[ -z "$LOCAL_PG" ] || [ -z "$DB_URL" ] || die "--local-postgres and --database-url are two different choices: give one."
interactive() { [ -z "$YES" ] && [ -t 0 ]; }

SOURCE=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
[ "$(id -u)" -eq 0 ] || die "run as root (sudo $0)."
[ -f "$SOURCE/package.json" ] && [ -d "$SOURCE/src" ] || die "$SOURCE is not an ETNA folder."
command -v systemctl >/dev/null || die "systemd is needed."
[ -z "$SETTINGS_FROM" ] || [ -f "$SETTINGS_FROM" ] || die "$SETTINGS_FROM does not exist."

# ─── 1. Node.js ──────────────────────────────────────────────────────────────
command -v node >/dev/null || die "Node.js is not installed (Node.js 24 LTS is recommended)."
command -v npm >/dev/null || die "npm is not installed."
node -e '
  const [a, b] = process.versions.node.split(".").map(Number);
  process.exit(a > 22 || (a === 22 && b >= 18) ? 0 : 1);
' || die "Node.js $(node -v) is too old: 22.18 or newer is needed (Node.js 24 LTS is recommended)."
NODE=$(command -v node)
say "Node.js $(node -v) ($NODE)"

# ─── 2. User and folders ─────────────────────────────────────────────────────
# Updates of an extra app server remember its shared data folder.
[ -n "$SHARED_DATA" ] || SHARED_DATA=$({ [ -f "$CTL_FILE" ] && tr -d '\r' <"$CTL_FILE" | sed -n 's/^ETNA_SHARED_DATA=//p' | tail -n 1; } || true)
# An extra app server mounts the first server's data folder (NFS), and its
# etna user gets the same uid and gid so the files stay readable everywhere.
if [ -n "$SHARED_DATA" ]; then
  "$NODE" --input-type=module -e "
    import { parseSharedData } from '$SOURCE/scripts/server/lib/psctl-core.mjs';
    try { parseSharedData(process.argv[1]); } catch (e) { console.error(e.message); process.exit(1); }
  " "$SHARED_DATA" || die "--shared-data: give host:/path. Nothing was changed."
  command -v mount.nfs4 >/dev/null || { say "Installing the NFS client"; apt-get install -y nfs-common >/dev/null; }
  install -d -m 0755 "$DATA_ROOT"
  if ! findmnt -n "$DATA_ROOT" >/dev/null; then
    line=$("$NODE" --input-type=module -e "
      import { fstabLine, upsertFstab } from '$SOURCE/scripts/server/lib/psctl-core.mjs';
      import fs from 'node:fs';
      process.stdout.write(upsertFstab(fs.readFileSync('/etc/fstab', 'utf8'), fstabLine(process.argv[1], process.argv[2]), process.argv[2]));
    " "$SHARED_DATA" "$DATA_ROOT")
    cp /etc/fstab /etc/fstab.etna-backup
    printf '%s' "$line" >/etc/fstab
    systemctl daemon-reload
    say "Mounting $SHARED_DATA on $DATA_ROOT"
    mount "$DATA_ROOT" || die "cannot mount $SHARED_DATA (on the first server: psctl cluster share --allow <this network>). /etc/fstab has the line; nothing else was changed."
  fi
  data_uid=$(stat -c %u "$DATA_ROOT")
  data_gid=$(stat -c %g "$DATA_ROOT")
  [ "$data_uid" != 0 ] || die "$SHARED_DATA belongs to root: it is not an ETNA data folder."
  if id etna >/dev/null 2>&1; then
    [ "$(id -u etna)" = "$data_uid" ] && [ "$(id -g etna)" = "$data_gid" ] ||
      die "the user etna here is $(id -u etna):$(id -g etna), the shared data folder belongs to $data_uid:$data_gid. They must be the same (usermod -u / groupmod -g, or a fresh server)."
  else
    say "Creating the system user etna ($data_uid:$data_gid, as on the first server)"
    getent group "$data_gid" >/dev/null && [ "$(getent group "$data_gid" | cut -d: -f1)" != etna ] &&
      die "group id $data_gid is taken here by $(getent group "$data_gid" | cut -d: -f1)."
    getent group etna >/dev/null || groupadd --system --gid "$data_gid" etna
    useradd --system --uid "$data_uid" --gid "$data_gid" --home-dir "$DATA_ROOT" --no-create-home --shell /usr/sbin/nologin etna
  fi
fi
if ! id etna >/dev/null 2>&1; then
  say "Creating the system user etna"
  useradd --system --home-dir "$DATA_ROOT" --no-create-home --shell /usr/sbin/nologin etna
fi
install -d -m 0755 -o root -g root "$PREFIX" "$PREFIX/releases" "$PREFIX/bin"
install -d -m 0750 -o root -g etna "$CONFIG_DIR"
# A shared data folder belongs to the first server (root here cannot change it).
[ -n "$SHARED_DATA" ] || install -d -m 0750 -o etna -g etna "$DATA_ROOT"
umask 077

# ─── 3. The database ─────────────────────────────────────────────────────────
# Reads one KEY=value from a settings file (values are never quoted).
setting() { [ -f "$1" ] && tr -d '\r' <"$1" | sed -n "s/^$2=//p" | tail -n 1 || true; }
# etna (an ETNA database), empty, or foreign (someone else's tables); $1: a folder with node_modules/pg.
db_state() {
  (cd "$1" && "$NODE" -e "
    const pg = require('pg');
    const c = new pg.Client({ connectionString: process.argv[1], application_name: 'etna-install' });
    c.connect().then(async () => {
      const { rows } = await c.query(\`select to_regclass('etna_meta.schema_migrations') is not null as etna,
        (select count(*)::int from pg_class k join pg_namespace n on n.oid = k.relnamespace
          where k.relkind in ('r', 'p') and n.nspname not in ('pg_catalog', 'information_schema')
            and n.nspname not like 'pg_toast%') as tables\`);
      console.log(rows[0].etna ? 'etna' : rows[0].tables > 0 ? 'foreign' : 'empty');
      await c.end();
    }).catch((e) => { console.error(e.message); process.exit(1); });
  " "$DB_URL")
}
# A URL without its password (the password goes to the owner's password file only).
strip_password() { "$NODE" -e 'const u = new URL(process.argv[1]); u.password = ""; console.log(u.toString())' "$1"; }
url_part() { "$NODE" -e 'const u = new URL(process.argv[1]); const v = { host: u.searchParams.get("host") || u.hostname || "localhost", port: u.port || "5432", user: decodeURIComponent(u.username), db: decodeURIComponent(u.pathname.slice(1)), password: decodeURIComponent(u.password) }; console.log(v[process.argv[2]])' "$1" "$2"; }
save_owner_password() { # url password
  local line
  line=$("$NODE" --input-type=module -e "
    import { pgpassLine, upsertPgpassLine } from '$SOURCE/scripts/server/lib/psctl-core.mjs';
    import fs from 'node:fs';
    const [file, url, password] = process.argv.slice(1);
    const before = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
    process.stdout.write(upsertPgpassLine(before, pgpassLine(url, password)));
  " "$OWNER_PGPASS" "$1" "$2")
  printf '%s' "$line" >"$OWNER_PGPASS.new"
  chmod 0600 "$OWNER_PGPASS.new"
  mv -f "$OWNER_PGPASS.new" "$OWNER_PGPASS"
}

ensure_local_postgres() {
  if command -v pg_lsclusters >/dev/null && [ -n "$(pg_lsclusters -h 2>/dev/null)" ]; then
    [ -n "$(pg_lsclusters -h | awk '$4 == "online"')" ] || die "PostgreSQL is installed but no cluster is running (pg_lsclusters). Start it, then run again."
  else
    command -v apt-get >/dev/null || die "--local-postgres installs PostgreSQL with apt (Ubuntu, Debian). Install PostgreSQL $PG_MAJOR yourself, then use --database-url."
    say "Installing PostgreSQL $PG_MAJOR (packages from apt.postgresql.org)"
    apt-get install -y -qq postgresql-common >/dev/null
    /usr/share/postgresql-common/pgdg/apt.postgresql.org.sh -y >/dev/null
    apt-get install -y -qq "postgresql-$PG_MAJOR" >/dev/null
  fi
  local port major
  read -r major port < <(pg_lsclusters -h | awk '$4 == "online" { print $1, $3; exit }')
  [ "$major" -ge 16 ] || die "The running PostgreSQL is $major: ETNA needs 16 or newer ($PG_MAJOR is recommended)."
  say "PostgreSQL $major on port $port"
  local psql=(runuser -u postgres -- psql -p "$port" -v ON_ERROR_STOP=1 -tAq)
  DB_URL="postgres://etna_owner@localhost:$port/etna"
  if [ -z "$("${psql[@]}" -c "select 1 from pg_roles where rolname = 'etna_owner'")" ]; then
    say "Creating the role etna_owner (not a superuser; its password stays in $OWNER_PGPASS)"
    local password
    password=$("$NODE" -e 'console.log(require("crypto").randomBytes(24).toString("base64url"))')
    # On stdin, not the command line (where every user could see it).
    printf "CREATE ROLE etna_owner LOGIN CREATEROLE PASSWORD '%s';\n" "$password" | "${psql[@]}" >/dev/null
    save_owner_password "$DB_URL" "$password"
  elif [ ! -f "$OWNER_PGPASS" ] || ! grep -q ':etna_owner:' "$OWNER_PGPASS"; then
    die "The role etna_owner already exists, and its password is not known here. Run again with --database-url $DB_URL and PGPASSWORD set to its password (or typed when asked)."
  fi
  if [ -z "$("${psql[@]}" -c "select 1 from pg_database where datname = 'etna'")" ]; then
    say "Creating the database etna"
    runuser -u postgres -- createdb -p "$port" --owner etna_owner etna
  fi
  LOCAL_PG=1
}

# The owner's connection: kept from the last run, or chosen now.
KNOWN_URL=$(setting "$CTL_FILE" MIGRATION_DATABASE_URL)
if [ -n "$KNOWN_URL" ] && [ -z "$DB_URL" ] && [ -z "$LOCAL_PG" ]; then
  DB_URL=$KNOWN_URL
  [ "$(setting "$CTL_FILE" ETNA_LOCAL_POSTGRES)" = 1 ] && LOCAL_PG=1
  say "Database (from $CTL_FILE): $DB_URL"
else
  if [ -z "$DB_URL" ] && [ -z "$LOCAL_PG" ]; then
    if [ -f "$ENV_FILE" ]; then
      # Installed before psctl: updates keep working as they did, without migrations.
      warn "No database owner is known yet: no migrations, backups or restores. Run again with --database-url (or --local-postgres) once."
    elif interactive; then
      echo "Where is the PostgreSQL for ETNA?"
      echo "  [1] on this server (PostgreSQL $PG_MAJOR is installed when missing)"
      echo "  [2] on another server, or already set up here (you give its owner connection)"
      read -r -p "Choose 1 or 2: " choice
      case "$choice" in
        1) LOCAL_PG=1 ;;
        2) read -r -p "Owner connection (postgres://etna_owner@host:5432/etna?sslmode=verify-full): " DB_URL ;;
        *) die "nothing chosen. Nothing was changed." ;;
      esac
      [ -n "$LOCAL_PG" ] || [ -n "$DB_URL" ] || die "no connection given. Nothing was changed."
    else
      die "first install: give --local-postgres or --database-url <owner url> (see --help). Nothing was changed."
    fi
  fi
  if [ -n "$LOCAL_PG" ]; then
    ensure_local_postgres
  elif [ -n "$DB_URL" ]; then
    password=$(url_part "$DB_URL" password)
    [ -n "$password" ] || password=${PGPASSWORD:-}
    if [ -z "$password" ] && interactive; then
      read -rs -p "Password of $(url_part "$DB_URL" user): " password
      echo
    fi
    DB_URL=$(strip_password "$DB_URL")
    if [ -n "$password" ]; then
      save_owner_password "$DB_URL" "$password"
    elif [ ! -f "$OWNER_PGPASS" ]; then
      die "the owner's password is needed (PGPASSWORD, or typed when asked). Nothing was changed."
    fi
    unset password
  fi
fi
export PGPASSFILE=$OWNER_PGPASS
unset PGPASSWORD

# What the database holds decides what an install may do with it.
DB_STATE=
if [ -n "$DB_URL" ]; then
  "$NODE" --input-type=module -e "
    import { tlsProblem } from '$SOURCE/scripts/server/lib/psctl-core.mjs';
    const p = tlsProblem(process.argv[1]); if (p) { console.error(p); process.exit(1); }
  " "$DB_URL" || die "the database connection is not protected. Nothing was changed."
  # Needs the pg package: from this folder, or the running release; else after the build.
  for dir in "$SOURCE" "$PREFIX/current"; do
    if [ -d "$dir/node_modules/pg" ]; then
      DB_STATE=$(db_state "$dir") || die "cannot connect to the database as $(url_part "$DB_URL" user). Nothing was changed."
      say "Database $(url_part "$DB_URL" db) on $(url_part "$DB_URL" host): $DB_STATE"
      break
    fi
  done
  # Without packages yet (a first install from a fresh checkout), the check runs after the build.
fi

decide_settings() {
  if [ -f "$ENV_FILE" ]; then
    MODE=update
  elif [ -n "$SETTINGS_FROM" ]; then
    MODE=reuse
  elif [ "$DB_STATE" = etna ]; then
    die "the database already holds ETNA, but this server has no $ENV_FILE. Its keys must stay the same (else everyone's two-factor stops working): run again with --settings-from <etna.env of the old or another app server>, or install on an empty database and use psctl restore <backup>. Nothing was changed."
  elif [ "$DB_STATE" = foreign ]; then
    die "the database holds tables that are not ETNA's. Use an empty database for ETNA. Nothing was changed."
  else
    MODE=fresh
  fi
}
[ -z "$DB_STATE" ] || decide_settings

# ─── 4. The new release ──────────────────────────────────────────────────────
VERSION=$(node -p "require('$SOURCE/package.json').version")
RELEASE=$PREFIX/releases/etna-$VERSION-$(date +%Y%m%dT%H%M%S)
say "Copying the app to $RELEASE"
mkdir -p "$RELEASE"
tar -C "$SOURCE" \
  --exclude=./node_modules --exclude=./.next --exclude='./.next-*' --exclude=./.git \
  --exclude=./storage --exclude=./dist --exclude=./prereqs --exclude=./.claude \
  --exclude='./.env' --exclude='./.env.*' \
  -cf - . | tar -C "$RELEASE" -xf -
# Until the release is ready, any failure removes it (the running version stays).
RELEASE_READY=
trap '[ -n "$RELEASE_READY" ] || { echo "Removing the unfinished release $RELEASE" >&2; rm -rf "$RELEASE"; }' EXIT

say "Installing packages and building (this takes a few minutes)"
(
  umask 022
  cd "$RELEASE"
  export NEXT_TELEMETRY_DISABLED=1 npm_config_update_notifier=false
  # The same source gives the same build id on every app server (psctl cluster).
  ETNA_BUILD_ID=$(cd "$SOURCE" && { git rev-parse HEAD 2>/dev/null ||
    find package-lock.json next.config.mjs src public -type f -print0 | LC_ALL=C sort -z | xargs -0 sha256sum | sha256sum | cut -c1-40; })
  export ETNA_BUILD_ID
  npm ci --no-audit --no-fund
  npx --no-install next build
  npm prune --omit=dev --no-audit --no-fund
)
# The service only reads the app: owned by root, readable by etna. Next.js
# keeps its image cache in .next/cache, which points into the data folder
# (one per app server: the folder may be shared).
chown -R root:etna "$RELEASE"
chmod -R u=rwX,g=rX,o= "$RELEASE"
CACHE_DIR=$DATA_ROOT/cache/next
[ -z "$SHARED_DATA" ] || CACHE_DIR=$DATA_ROOT/cache/next-$(hostname -s)
if [ -n "$SHARED_DATA" ]; then
  runuser -u etna -- mkdir -p -m 0750 "$CACHE_DIR"
else
  install -d -m 0750 -o etna -g etna "$DATA_ROOT/cache" "$CACHE_DIR"
fi
rm -rf "$RELEASE/.next/cache"
ln -s "$CACHE_DIR" "$RELEASE/.next/cache"

if [ -n "$DB_URL" ] && [ -z "$DB_STATE" ]; then
  DB_STATE=$(db_state "$RELEASE") || die "cannot connect to the database as $(url_part "$DB_URL" user). Nothing was changed."
  say "Database $(url_part "$DB_URL" db) on $(url_part "$DB_URL" host): $DB_STATE"
  decide_settings
fi
[ -n "$DB_URL" ] || MODE=update

# ─── 5. Database and settings ────────────────────────────────────────────────
case "$MODE" in
  fresh)
    say "Preparing the empty database and writing $ENV_FILE (new keys)"
    (cd "$RELEASE" && MIGRATION_DATABASE_URL=$DB_URL "$NODE" scripts/setup-local.mjs --settings "$ENV_FILE")
    {
      echo ''
      echo '# Where the app keeps uploaded documents and company folders.'
      echo "ETNA_DATA_ROOT=$DATA_ROOT"
      echo '# Behind Caddy or nginx on this server (deploy/linux/Caddyfile):'
      echo '# TRUST_PROXY=1'
      echo '# ETNA_PUBLIC_URL=https://erp.example.com'
    } >>"$ENV_FILE"
    ;;
  reuse)
    # The same database and keys as the server the file comes from.
    from_db=$(url_part "$(setting "$SETTINGS_FROM" DATABASE_URL)" db)
    [ -n "$from_db" ] || die "$SETTINGS_FROM has no DATABASE_URL: it is not an etna.env."
    [ -n "$(setting "$SETTINGS_FROM" MFA_ENCRYPTION_KEY)" ] || die "$SETTINGS_FROM has no MFA_ENCRYPTION_KEY: it is not an etna.env."
    [ "$from_db" = "$(url_part "$DB_URL" db)" ] || die "$SETTINGS_FROM is for database $from_db, not $(url_part "$DB_URL" db). Nothing was changed."
    [ "$DB_STATE" = etna ] || die "$SETTINGS_FROM is for an ETNA database, but this one is $DB_STATE. Nothing was changed."
    say "Using the settings and keys of $SETTINGS_FROM"
    install -m 0640 -o root -g etna "$SETTINGS_FROM" "$ENV_FILE"
    grep -q '^ETNA_DATA_ROOT=' "$ENV_FILE" || printf '\nETNA_DATA_ROOT=%s\n' "$DATA_ROOT" >>"$ENV_FILE"
    (cd "$RELEASE" && MIGRATION_DATABASE_URL=$DB_URL "$NODE" scripts/db/migrate.mjs)
    ;;
  update)
    if [ -n "$DB_URL" ]; then
      if [ -z "$NO_BACKUP" ] && [ -n "$(setting "$CTL_FILE" ETNA_BACKUP_KEY)" ]; then
        say "Backup before the update"
        "$NODE" "$RELEASE/scripts/server/psctl.mjs" backup || die "the backup failed: nothing was updated (--no-backup skips it)."
      elif [ -z "$NO_BACKUP" ]; then
        warn "No backup before this update: backups are not set up (psctl backup-setup)."
      fi
      say "Applying new database migrations"
      (cd "$RELEASE" && MIGRATION_DATABASE_URL=$DB_URL "$NODE" scripts/db/migrate.mjs)
    fi
    ;;
esac
chown root:etna "$ENV_FILE"
chmod 0640 "$ENV_FILE"

# psctl's settings: the owner connection (without its password) and whether
# PostgreSQL is this server's own.
if [ -n "$DB_URL" ]; then
  "$NODE" --input-type=module -e "
    import { writeEnvFile } from '$SOURCE/scripts/server/lib/envfile.mjs';
    writeEnvFile(process.argv[1], { MIGRATION_DATABASE_URL: process.argv[2], ETNA_LOCAL_POSTGRES: process.argv[3] || null, ETNA_SHARED_DATA: process.argv[4] || null });
  " "$CTL_FILE" "$DB_URL" "$LOCAL_PG" "$SHARED_DATA"
  chmod 0600 "$CTL_FILE"
fi
RELEASE_READY=1

# ─── 6. Switch and (re)start ─────────────────────────────────────────────────
PREVIOUS=$(readlink -f "$PREFIX/current" 2>/dev/null || true)
ln -sfn "$RELEASE" "$PREFIX/current.new"
mv -T "$PREFIX/current.new" "$PREFIX/current"
say "Now running $(basename "$RELEASE")"

install -m 0755 "$SOURCE/deploy/linux/etna-db-backup.sh" "$PREFIX/bin/etna-db-backup.sh"
install -m 0755 "$SOURCE/deploy/linux/psctl" /usr/local/bin/psctl
for unit in etna.service etna-worker.service etna-backup.service etna-backup.timer etna-db-backup.service etna-db-backup.timer etna-offsite.service etna-offsite.timer; do
  install -m 0644 "$SOURCE/deploy/linux/$unit" "$UNIT_DIR/$unit"
done
systemctl daemon-reload
systemctl enable etna.service etna-worker.service >/dev/null
systemctl restart etna.service etna-worker.service

port=$(setting "$ENV_FILE" ETNA_PORT)
answers() {
  for _ in $(seq 1 45); do
    "$NODE" -e "fetch('http://127.0.0.1:${port:-4028}/api/health').then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))" && return 0
    sleep 2
  done
  return 1
}
say "Waiting for ETNA to answer"
if ! answers; then
  warn "ETNA $(basename "$RELEASE") does not answer: journalctl -u etna -n 50"
  if [ -n "$PREVIOUS" ] && [ -d "$PREVIOUS" ] && [ "$PREVIOUS" != "$RELEASE" ]; then
    warn "Going back to $(basename "$PREVIOUS")."
    ln -sfn "$PREVIOUS" "$PREFIX/current.new"
    mv -T "$PREFIX/current.new" "$PREFIX/current"
    systemctl restart etna.service etna-worker.service
    answers && warn "$(basename "$PREVIOUS") runs again. The database keeps the new migrations (they only add)." || warn "$(basename "$PREVIOUS") does not answer either: psctl doctor."
  fi
  exit 1
fi
say "ETNA answers on 127.0.0.1:${port:-4028}"

# Keep the current and the previous release (to go back to), remove older ones.
for dir in "$PREFIX"/releases/etna-*; do
  [ -d "$dir" ] || continue
  [ "$dir" = "$RELEASE" ] || [ "$dir" = "$PREVIOUS" ] || rm -rf "$dir"
done

if [ "$MODE" = fresh ] && interactive && [ -z "$(setting "$CTL_FILE" ETNA_BACKUP_KEY)" ]; then
  read -r -p "Set up nightly encrypted backups now? [Y/n] " yn
  case "$yn" in [nN]*) ;; *) psctl backup-setup || warn "Backups are not set up: psctl backup-setup" ;; esac
fi

cat <<EOF

Done. Next steps (docs/teknis/INSTALL-LINUX.md):
  - state:           psctl status    (and psctl doctor)
  - first account:   psctl users create-user --email you@example.com
  - backups:         psctl backup-setup --copy-to <mounted NAS folder>, then psctl backup
  - HTTPS:           deploy/linux/Caddyfile, then TRUST_PROXY=1 and ETNA_PUBLIC_URL in $ENV_FILE
  - logs:            psctl logs -f
EOF
