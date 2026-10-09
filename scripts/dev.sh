#!/usr/bin/env bash
# Entorno local de pruebas: contenedores (PostgreSQL 18 + Redis), API (:3101) y web (:3100).
#   scripts/dev.sh up        levanta todo (compila la web si hace falta)
#   scripts/dev.sh down      detiene API y web (los contenedores siguen: `pnpm db:down` para apagarlos)
#   scripts/dev.sh status
set -euo pipefail
cd "$(dirname "$0")/.."
export PATH="$HOME/.local/share/npm/bin:$PATH"
API_PORT=3101; WEB_PORT=3100

up() {
  podman-compose -f docker-compose.dev.yml up -d >/dev/null 2>&1 || true
  apps/api/scripts/dev-server.sh restart
  fuser -k ${WEB_PORT}/tcp >/dev/null 2>&1 || true
  (cd apps/web && { [ -d .next ] || pnpm build; } && nohup pnpm start > /tmp/minierp-web.log 2>&1 &)
  for i in $(seq 1 30); do curl -sf "localhost:${WEB_PORT}/signin" >/dev/null && { echo "Web arriba en http://localhost:${WEB_PORT}"; return; }; sleep 1; done
  echo "La web no arrancó; ver /tmp/minierp-web.log"; tail -20 /tmp/minierp-web.log; exit 1
}
down() { fuser -k ${API_PORT}/tcp ${WEB_PORT}/tcp >/dev/null 2>&1 || true; echo "API y web detenidas"; }
status() { for p in $API_PORT $WEB_PORT 55432 56379; do printf ":%s " $p; (ss -ltn | grep -q ":$p ") && echo up || echo down; done; }
case "${1:-status}" in up) up;; down) down;; status) status;; esac
