#!/usr/bin/env bash
# Corre las pruebas de carga contra una base y una API propias (no toca las de desarrollo ni producción).
set -euo pipefail
cd "$(dirname "$0")/.."
export PATH="$HOME/.local/share/npm/bin:$PATH"
DB=minierp_load
./scripts/db-reset.sh "$DB" >/dev/null
export NODE_ENV=development LOG_LEVEL=warn PORT=3402 HOST=127.0.0.1
export DATABASE_URL="postgresql://erp_app:erp_app@127.0.0.1:55432/$DB?connection_limit=20"
export REDIS_URL="redis://:minierp_redis@127.0.0.1:56379/3"
export JWT_ACCESS_SECRET=load_access_secret_load_access_secret_load_access_1234
export JWT_REFRESH_SECRET=load_refresh_secret_load_refresh_secret_load_refresh_12
export THROTTLE_DEFAULT_PER_MIN=1000000 THROTTLE_LOGIN_PER_MIN=1000000 WORKER_ENABLED=true QUEUE_PREFIX=load FX_SYNC_ENABLED=false JOBS_ENABLED=false
ADMIN_EMAIL=loadadmin@erp.local ADMIN_PASSWORD='LoadTest12345!' npx ts-node --transpile-only src/cli/bootstrap.ts
npx ts-node --transpile-only src/main.ts > /tmp/erp-load-api.log 2>&1 &
API_PID=$!
trap 'kill $API_PID 2>/dev/null || true' EXIT
for i in $(seq 1 60); do curl -sf localhost:3402/api/v1/health >/dev/null && break; sleep 1; done
node loadtest/run.mjs
