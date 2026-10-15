#!/bin/sh
# First start of the database container only (an empty volume): the schema
# owner etna_owner (not a superuser) and the database etna, as on a server
# installed by hand (docs/DEVELOPMENT.md, 2a).
set -eu
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname postgres -v pw="$ETNA_OWNER_PASSWORD" <<'SQL'
CREATE ROLE etna_owner LOGIN CREATEROLE PASSWORD :'pw';
CREATE DATABASE etna OWNER etna_owner;
SQL
