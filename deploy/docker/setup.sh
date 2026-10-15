#!/bin/sh
# The setup service of deploy/docker/compose.yml (runs before app and worker).
# First time: applies the schema, gives the app roles new passwords and writes
# /config/etna.env with new keys. Later: applies new migrations. Every time:
# takes ETNA_DATA_ROOT, TRUST_PROXY and ETNA_PUBLIC_URL from compose's .env.
set -eu
ENV_FILE=/config/etna.env

if [ -f "$ENV_FILE" ]; then
  node scripts/db/migrate.mjs
else
  node scripts/setup-local.mjs --env-file "$ENV_FILE"
fi

node --input-type=module -e "
import fs from 'node:fs';
import { updateEnv } from './scripts/server/lib/envfile.mjs';
const file = '$ENV_FILE';
const changes = { ETNA_DATA_ROOT: '/data' };
for (const key of ['TRUST_PROXY', 'ETNA_PUBLIC_URL']) changes[key] = process.env[key] || null;
fs.writeFileSync(file, updateEnv(fs.readFileSync(file, 'utf8'), changes), { mode: 0o600 });
"
echo "Settings in $ENV_FILE are ready."
