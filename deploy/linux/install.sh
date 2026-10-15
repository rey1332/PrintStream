#!/usr/bin/env bash
# Installs or updates ETNA on a Linux server with systemd (docs/INSTALL-LINUX.md).
# Run as root from the folder of an ETNA checkout or release:
#
#   sudo deploy/linux/install.sh
#
# First install, with the database prepared (the owner role and database):
#
#   sudo MIGRATION_DATABASE_URL=postgres://etna_owner@localhost:5432/etna \
#        PGPASSWORD='…' deploy/linux/install.sh
#
# What it does, in this order (an update stops before the switch if anything fails):
#   1. checks Node.js (22.18 or newer), npm and systemd;
#   2. creates the system user etna and the folders
#        /opt/etna/releases/<version>  the app versions (the current and the previous one)
#        /opt/etna/current             symlink to the version that runs
#        /etc/etna/etna.env            settings and keys (root:etna, 0640)
#        /var/lib/etna                 ETNA_DATA_ROOT: documents, company folders, in-app backups
#   3. copies the app to a new release folder, installs its packages and builds it;
#   4. the first time: prepares the database and writes /etc/etna/etna.env
#      (scripts/setup-local.mjs); later: applies new migrations when
#      MIGRATION_DATABASE_URL is set;
#   5. switches /opt/etna/current, installs the systemd units and (re)starts
#      etna and etna-worker, then checks /api/health.
set -euo pipefail

PREFIX=/opt/etna
CONFIG_DIR=/etc/etna
ENV_FILE=$CONFIG_DIR/etna.env
DATA_ROOT=/var/lib/etna
UNIT_DIR=/etc/systemd/system

say() { printf '\033[1m==>\033[0m %s\n' "$*"; }
die() { printf '\033[31mError:\033[0m %s\n' "$*" >&2; exit 1; }

SOURCE=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
[ "$(id -u)" -eq 0 ] || die "run as root (sudo $0)."
[ -f "$SOURCE/package.json" ] && [ -d "$SOURCE/src" ] || die "$SOURCE is not an ETNA folder."
command -v systemctl >/dev/null || die "systemd is needed."

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
if ! id etna >/dev/null 2>&1; then
  say "Creating the system user etna"
  useradd --system --home-dir "$DATA_ROOT" --no-create-home --shell /usr/sbin/nologin etna
fi
install -d -m 0755 -o root -g root "$PREFIX" "$PREFIX/releases" "$PREFIX/bin"
install -d -m 0750 -o root -g etna "$CONFIG_DIR"
install -d -m 0750 -o etna -g etna "$DATA_ROOT"

# ─── 3. The new release ──────────────────────────────────────────────────────
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
  cd "$RELEASE"
  export NEXT_TELEMETRY_DISABLED=1 npm_config_update_notifier=false
  npm ci --no-audit --no-fund
  npx --no-install next build
  npm prune --omit=dev --no-audit --no-fund
)
# The service only reads the app: owned by root, readable by etna. Next.js
# keeps its image cache in .next/cache, which points into the data folder.
chown -R root:etna "$RELEASE"
chmod -R u=rwX,g=rX,o= "$RELEASE"
install -d -m 0750 -o etna -g etna "$DATA_ROOT/cache" "$DATA_ROOT/cache/next"
rm -rf "$RELEASE/.next/cache"
ln -s "$DATA_ROOT/cache/next" "$RELEASE/.next/cache"

# ─── 4. Database and settings ────────────────────────────────────────────────
if [ ! -f "$ENV_FILE" ]; then
  [ -n "${MIGRATION_DATABASE_URL:-}" ] || die "$ENV_FILE does not exist yet. Prepare the database (docs/INSTALL-LINUX.md, step 2) and run again with MIGRATION_DATABASE_URL and PGPASSWORD set."
  say "Preparing the database and writing $ENV_FILE"
  (cd "$RELEASE" && "$NODE" scripts/setup-local.mjs --settings "$ENV_FILE")
  {
    echo ''
    echo '# Where the app keeps uploaded documents and company folders.'
    echo "ETNA_DATA_ROOT=$DATA_ROOT"
    echo '# Behind Caddy or nginx on this server (deploy/linux/Caddyfile):'
    echo '# TRUST_PROXY=1'
    echo '# ETNA_PUBLIC_URL=https://erp.example.com'
  } >>"$ENV_FILE"
elif [ -n "${MIGRATION_DATABASE_URL:-}" ]; then
  say "Applying new database migrations"
  (cd "$RELEASE" && "$NODE" scripts/db/migrate.mjs)
else
  say "MIGRATION_DATABASE_URL is not set: no migrations applied (set it when this version has new ones)."
fi
chown root:etna "$ENV_FILE"
chmod 0640 "$ENV_FILE"
RELEASE_READY=1

# ─── 5. Switch and (re)start ─────────────────────────────────────────────────
PREVIOUS=$(readlink -f "$PREFIX/current" 2>/dev/null || true)
ln -sfn "$RELEASE" "$PREFIX/current.new"
mv -T "$PREFIX/current.new" "$PREFIX/current"
say "Now running $(basename "$RELEASE")"

install -m 0755 "$SOURCE/deploy/linux/etna-db-backup.sh" "$PREFIX/bin/etna-db-backup.sh"
for unit in etna.service etna-worker.service etna-db-backup.service etna-db-backup.timer etna-offsite.service etna-offsite.timer; do
  install -m 0644 "$SOURCE/deploy/linux/$unit" "$UNIT_DIR/$unit"
done
systemctl daemon-reload
systemctl enable etna.service etna-worker.service >/dev/null
systemctl restart etna.service etna-worker.service

say "Waiting for ETNA to answer"
ok=
for _ in $(seq 1 30); do
  if "$NODE" -e "fetch('http://127.0.0.1:4028/api/health').then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))"; then
    ok=1
    break
  fi
  sleep 2
done
if [ -z "$ok" ]; then
  echo "ETNA does not answer yet: journalctl -u etna -n 50" >&2
  [ -n "$PREVIOUS" ] && echo "Back to the previous version: sudo ln -sfn $PREVIOUS $PREFIX/current && sudo systemctl restart etna etna-worker" >&2
  exit 1
fi
say "ETNA answers on 127.0.0.1:4028"

# Keep the current and the previous release (to go back to), remove older ones.
for dir in "$PREFIX"/releases/etna-*; do
  [ -d "$dir" ] || continue
  [ "$dir" = "$RELEASE" ] || [ "$dir" = "$PREVIOUS" ] || rm -rf "$dir"
done

cat <<EOF

Done. Next steps (docs/INSTALL-LINUX.md):
  - first account:   cd $PREFIX/current && sudo ADMIN_DATABASE_URL=… PGPASSWORD=… node scripts/admin/users.mjs create-user --email you@example.com
  - HTTPS:           deploy/linux/Caddyfile, then TRUST_PROXY=1 and ETNA_PUBLIC_URL in $ENV_FILE
  - daily backups:   systemctl enable --now etna-db-backup.timer (on the database server)
  - logs:            journalctl -u etna -u etna-worker -f
EOF
