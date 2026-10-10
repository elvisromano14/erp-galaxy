#!/usr/bin/env bash
# Respaldo diario de la base `erp` (pg_dump comprimido, rotación de 14 días). Usa el rol `erp_backup` (solo lectura, BYPASSRLS).
set -euo pipefail
DIR="${ERP_BACKUP_DIR:-$HOME/backups/erp}"
KEEP="${ERP_BACKUP_KEEP:-14}"
. "$HOME/.config/erp/backup.env"
mkdir -p "$DIR"; chmod 700 "$DIR"
OUT="$DIR/erp-$(date +%Y%m%d-%H%M%S).sql.gz"
PGPASSWORD="$BACKUP_PASSWORD" pg_dump -h 127.0.0.1 -U erp_backup --no-owner --no-privileges erp | gzip -9 > "$OUT.tmp"
mv "$OUT.tmp" "$OUT"; chmod 600 "$OUT"
ls -1t "$DIR"/erp-*.sql.gz | tail -n +$((KEEP + 1)) | xargs -r rm -f
echo "Respaldo listo: $OUT ($(du -h "$OUT" | cut -f1))"
