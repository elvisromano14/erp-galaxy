#!/usr/bin/env bash
# Despliegue manual del ERP al VPS (galaxy-vps): construye las imágenes aquí, las sube por SSH, migra la base y reinicia.
#   deploy/deploy.sh              construye y despliega
#   deploy/deploy.sh --no-build   despliega las imágenes ya construidas (localhost/erp-api:latest y erp-web:latest)
#   deploy/deploy.sh --no-upload  no construye ni sube imágenes (solo configuración, migración y reinicio)
#   deploy/deploy.sh --only=web   solo construye/sube esa imagen (api | web)
#   deploy/deploy.sh --rollback   vuelve a las imágenes anteriores (las migraciones de base NO se revierten)
# Requiere: podman local, acceso SSH al host `galaxy-vps` (ver ~/.ssh/config) y `sudo` sin contraseña en el VPS.
set -euo pipefail
cd "$(dirname "$0")/.."
VPS="${ERP_VPS:-galaxy-vps}"
FUNNEL_PORT="${ERP_FUNNEL_PORT:-10000}"
MODE="deploy"; BUILD=1; UPLOAD=1; IMAGES="api web"
for a in "$@"; do case "$a" in --no-build) BUILD=0;; --no-upload) BUILD=0; UPLOAD=0;; --only=*) IMAGES="${a#--only=}";; --rollback) MODE="rollback";; *) echo "Opción desconocida: $a"; exit 2;; esac; done
log() { printf '\n\033[1;34m▶ %s\033[0m\n' "$*"; }
ssh_() { ssh -o BatchMode=yes "$VPS" "$@"; }
unit_wait() {  # espera a que el contenedor esté sano
  local name="$1" i
  for i in $(seq 1 45); do
    st="$(ssh_ "podman inspect -f '{{.State.Health.Status}}' $name 2>/dev/null" || true)"
    [ "$st" = "healthy" ] && return 0
    sleep 3
  done
  echo "✘ $name no quedó sano; últimos registros:"; ssh_ "journalctl --user -u $name -n 30 --no-pager" || true; return 1
}

if [ "$MODE" = "rollback" ]; then
  log "Rollback a las imágenes anteriores"
  ssh_ 'for i in erp-api erp-web; do podman image exists localhost/$i:previous || { echo "No hay imagen previa de $i"; exit 1; }; podman tag localhost/$i:previous localhost/$i:latest; done; systemctl --user restart erp-api erp-web'
  unit_wait erp-api; unit_wait erp-web; echo "✔ Rollback hecho"; exit 0
fi

TAG="$(git rev-parse --short HEAD 2>/dev/null || date +%Y%m%d%H%M)"
if [ "$BUILD" = 1 ]; then
  log "Construyendo imágenes ($TAG)"
  case " $IMAGES " in *" api "*) podman build -q -f deploy/Containerfile.api -t localhost/erp-api:latest -t "localhost/erp-api:$TAG" .;; esac
  case " $IMAGES " in *" web "*) podman build -q -f deploy/Containerfile.web --build-arg API_URL=http://127.0.0.1:3301 -t localhost/erp-web:latest -t "localhost/erp-web:$TAG" .;; esac
fi

log "Preparando el VPS (archivos de despliegue y entorno)"
ssh_ 'rm -rf ~/erp-deploy && mkdir -p ~/erp-deploy'
tar -C deploy -cf - quadlet erp-backup.sh erp-backup.service erp-backup.timer vps-setup.sh | ssh_ 'tar -C ~/erp-deploy -xf -'
ssh_ 'bash ~/erp-deploy/vps-setup.sh ~/erp-deploy'

if [ "$UPLOAD" = 1 ]; then
  log "Subiendo imágenes por SSH"
  for img in $IMAGES; do ssh_ "podman image exists localhost/erp-$img:latest && podman tag localhost/erp-$img:latest localhost/erp-$img:previous || true"; done
  # Una imagen por transferencia (un solo archivo con varias imágenes etiqueta mal al cargarlas).
  for img in $IMAGES; do
    podman save "localhost/erp-$img:latest" | gzip -1 | ssh_ 'gunzip | podman load' | sed 's/^/   /'
  done
fi

log "Iniciando Redis (lo necesita el arranque de la API)"
ssh_ 'systemctl --user daemon-reload && systemctl --user enable erp-redis >/dev/null 2>&1; systemctl --user start erp-redis'
unit_wait erp-redis

log "Migrando la base y preparando datos de referencia"
ssh_ 'podman run --rm --network host --env-file ~/.config/erp/migrate.env localhost/erp-api:latest ./node_modules/.bin/prisma migrate deploy 2>&1 | tail -3'
# El arranque de datos usa la aplicación completa pero SIN workers ni tareas periódicas.
ssh_ 'set -a; . ~/.config/erp/secrets.env; set +a; podman run --rm --network host --env-file ~/.config/erp/api.env -e WORKER_ENABLED=false -e JOBS_ENABLED=false -e FX_SYNC_ENABLED=false -e ADMIN_EMAIL -e ADMIN_PASSWORD localhost/erp-api:latest node dist/cli/bootstrap.js'

log "Reiniciando servicios"
ssh_ 'systemctl --user enable erp-api erp-web >/dev/null 2>&1; systemctl --user restart erp-api erp-web'
unit_wait erp-api; unit_wait erp-web

log "Publicación (Tailscale Funnel, puerto $FUNNEL_PORT)"
ssh_ "sudo -n tailscale funnel status 2>&1 | grep -q ':$FUNNEL_PORT' || sudo -n tailscale funnel --bg --https=$FUNNEL_PORT http://127.0.0.1:3300 2>&1 | tail -3"
HOST="$(ssh_ "sudo -n tailscale status --json | python3 -c 'import sys,json;print(json.load(sys.stdin)[\"Self\"][\"DNSName\"].rstrip(\".\"))'")"
echo "✔ Desplegado ($TAG): https://$HOST:$FUNNEL_PORT"
echo "  Administrador inicial: ssh $VPS 'cat ~/.config/erp/secrets.env | grep ADMIN_'"
