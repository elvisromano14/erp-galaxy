#!/usr/bin/env bash
# Crea roles y base de datos (idempotente). Uso: scripts/db-init.sh [nombre_bd]
# Roles: erp_migrator (dueño del esquema, DDL) y erp_app (DML, NOBYPASSRLS) — erp-v3 §21.2
set -euo pipefail
DB="${1:-minierp}"
ADMIN="${ADMIN_PSQL:-postgresql://minierp_admin:minierp_admin@127.0.0.1:55432/postgres}"
psql "$ADMIN" -v ON_ERROR_STOP=1 <<SQL
DO \$\$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='erp_migrator') THEN CREATE ROLE erp_migrator LOGIN PASSWORD 'erp_migrator'; END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='erp_app') THEN CREATE ROLE erp_app LOGIN PASSWORD 'erp_app' NOBYPASSRLS; END IF;
END \$\$;
SQL
if ! psql "$ADMIN" -Atc "select 1 from pg_database where datname='$DB'" | grep -q 1; then
  psql "$ADMIN" -v ON_ERROR_STOP=1 -c "CREATE DATABASE \"$DB\" OWNER erp_migrator"
else
  psql "$ADMIN" -v ON_ERROR_STOP=1 -c "ALTER DATABASE \"$DB\" OWNER TO erp_migrator"
fi
DBURL="${ADMIN%/*}/$DB"
psql "$DBURL" -v ON_ERROR_STOP=1 <<SQL
ALTER SCHEMA public OWNER TO erp_migrator;
GRANT USAGE ON SCHEMA public TO erp_app;
ALTER DEFAULT PRIVILEGES FOR ROLE erp_migrator IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO erp_app;
ALTER DEFAULT PRIVILEGES FOR ROLE erp_migrator IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO erp_app;
SQL
echo "BD '$DB' lista."
