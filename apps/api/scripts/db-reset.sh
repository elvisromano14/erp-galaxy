#!/usr/bin/env bash
# Recrea la BD de desarrollo desde cero y aplica migraciones. Uso: scripts/db-reset.sh [bd]
set -euo pipefail
cd "$(dirname "$0")/.."
DB="${1:-minierp}"
ADMIN="${ADMIN_PSQL:-postgresql://minierp_admin:minierp_admin@127.0.0.1:55432/postgres}"
psql "$ADMIN" -v ON_ERROR_STOP=1 -c "DROP DATABASE IF EXISTS \"$DB\" WITH (FORCE)" >/dev/null
./scripts/db-init.sh "$DB" >/dev/null
URL="postgresql://erp_migrator:erp_migrator@127.0.0.1:55432/$DB"
DATABASE_URL="$URL" npx prisma migrate deploy 2>&1 | tail -4
