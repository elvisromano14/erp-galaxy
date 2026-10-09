#!/usr/bin/env bash
# Uso: scripts/dev-server.sh start|stop|restart  (API en segundo plano; log en /tmp/minierp-api.log)
cd "$(dirname "$0")/.."
export PATH="$HOME/.local/share/npm/bin:$PATH"
PORT="${PORT:-3101}"
stop() { fuser -k "${PORT}/tcp" >/dev/null 2>&1 || true; sleep 1; }
start() {
  nohup npx ts-node --transpile-only src/main.ts > /tmp/minierp-api.log 2>&1 &
  for i in $(seq 1 40); do curl -sf "localhost:${PORT}/api/v1/health" >/dev/null && { echo "API arriba en :${PORT}"; return; }; sleep 1; done
  echo "La API no arrancó; ver /tmp/minierp-api.log"; tail -20 /tmp/minierp-api.log; exit 1
}
case "${1:-start}" in stop) stop;; start) start;; restart) stop; start;; esac
