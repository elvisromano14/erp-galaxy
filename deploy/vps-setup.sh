#!/usr/bin/env bash
# Aprovisiona (una sola vez, idempotente) lo propio del ERP en el VPS. Se ejecuta EN el VPS, normalmente vía deploy.sh.
# No toca nada de KTSU/JAC: crea su propia base `erp`, sus roles, sus archivos en ~/.config/erp y sus unidades Quadlet `erp-*`.
set -euo pipefail
CFG="$HOME/.config/erp"
Q="$HOME/.config/containers/systemd"
SRC="${1:-$HOME/erp-deploy}"          # carpeta con quadlet/ y erp-backup.*
umask 077
mkdir -p "$CFG" "$Q" "$HOME/.config/systemd/user" "$HOME/.local/bin"
rand() { openssl rand -hex "$1"; }

# ── secretos y variables (solo si no existen)
if [ ! -f "$CFG/secrets.env" ]; then
  cat > "$CFG/secrets.env" <<EOT
PG_APP_PASSWORD=$(rand 24)
PG_MIGRATOR_PASSWORD=$(rand 24)
PG_BACKUP_PASSWORD=$(rand 24)
REDIS_PASSWORD=$(rand 24)
JWT_ACCESS_SECRET=$(rand 40)
JWT_REFRESH_SECRET=$(rand 40)
ADMIN_EMAIL=admin@erp.galaxy
ADMIN_PASSWORD=$(rand 9)Aa1!
EOT
  chmod 600 "$CFG/secrets.env"
fi
set -a; . "$CFG/secrets.env"; set +a

# ── PostgreSQL: roles y base propios (idempotente)
sudo -n -u postgres psql -v ON_ERROR_STOP=1 -q <<SQL
DO \$\$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='erp_migrator') THEN CREATE ROLE erp_migrator LOGIN PASSWORD '$PG_MIGRATOR_PASSWORD' NOBYPASSRLS; END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='erp_app')      THEN CREATE ROLE erp_app      LOGIN PASSWORD '$PG_APP_PASSWORD' NOBYPASSRLS CONNECTION LIMIT 25; END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='erp_backup')   THEN CREATE ROLE erp_backup   LOGIN PASSWORD '$PG_BACKUP_PASSWORD' BYPASSRLS CONNECTION LIMIT 2; END IF;
END \$\$;
ALTER ROLE erp_migrator PASSWORD '$PG_MIGRATOR_PASSWORD';
ALTER ROLE erp_app PASSWORD '$PG_APP_PASSWORD';
ALTER ROLE erp_backup PASSWORD '$PG_BACKUP_PASSWORD';
GRANT pg_read_all_data TO erp_backup;
SELECT 'CREATE DATABASE erp OWNER erp_migrator' WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname='erp')\gexec
REVOKE ALL ON DATABASE erp FROM PUBLIC;
GRANT CONNECT ON DATABASE erp TO erp_app, erp_backup, erp_migrator;
SQL
sudo -n -u postgres psql -d erp -v ON_ERROR_STOP=1 -q <<SQL
ALTER SCHEMA public OWNER TO erp_migrator;
REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO erp_app, erp_backup;
ALTER DEFAULT PRIVILEGES FOR ROLE erp_migrator IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO erp_app;
ALTER DEFAULT PRIVILEGES FOR ROLE erp_migrator IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO erp_app;
SQL

# ── archivos de entorno
cat > "$CFG/redis.env" <<EOT
REDIS_PASSWORD=$REDIS_PASSWORD
EOT
cat > "$CFG/api.env" <<EOT
NODE_ENV=production
PORT=3301
HOST=127.0.0.1
TZ=America/Caracas
DATABASE_URL=postgresql://erp_app:$PG_APP_PASSWORD@127.0.0.1:5432/erp?connection_limit=12
REDIS_URL=redis://:$REDIS_PASSWORD@127.0.0.1:6390/0
JWT_ACCESS_SECRET=$JWT_ACCESS_SECRET
JWT_REFRESH_SECRET=$JWT_REFRESH_SECRET
LOG_LEVEL=info
WORKER_ENABLED=true
JOBS_ENABLED=true
FX_SYNC_ENABLED=true
FX_SYNC_INTERVAL_MINUTES=120
TRUST_PROXY_HOPS=2
THROTTLE_DEFAULT_PER_MIN=600
THROTTLE_LOGIN_PER_MIN=10
QUEUE_PREFIX=erp
EOT
cat > "$CFG/migrate.env" <<EOT
DATABASE_URL=postgresql://erp_migrator:$PG_MIGRATOR_PASSWORD@127.0.0.1:5432/erp
EOT
cat > "$CFG/web.env" <<EOT
NODE_ENV=production
PORT=3300
# 0.0.0.0 (no 127.0.0.1): detrás de Tailscale Funnel Next arma sus URL internas con el nombre del servidor y X-Forwarded-Proto=https;
# con 127.0.0.1 intenta hablar TLS con su propio puerto HTTP y responde 500. El puerto no se expone: UFW niega todo lo entrante salvo SSH.
HOSTNAME=0.0.0.0
API_URL=http://127.0.0.1:3301
COOKIE_SECURE=true
EOT
cat > "$CFG/backup.env" <<EOT
BACKUP_PASSWORD=$PG_BACKUP_PASSWORD
EOT
chmod 600 "$CFG"/*.env

# ── unidades Quadlet, respaldo y arranque automático
cp "$SRC"/quadlet/erp-*.container "$Q/"
install -m 755 "$SRC/erp-backup.sh" "$HOME/.local/bin/erp-backup.sh"
cp "$SRC/erp-backup.service" "$SRC/erp-backup.timer" "$HOME/.config/systemd/user/"
loginctl enable-linger "$USER" >/dev/null 2>&1 || true
podman pull -q docker.io/library/redis:7-alpine >/dev/null
systemctl --user daemon-reload
systemctl --user enable --now erp-backup.timer >/dev/null
echo "VPS listo: base erp, roles, entorno en $CFG, unidades Quadlet y respaldo diario."
