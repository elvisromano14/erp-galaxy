#!/usr/bin/env bash
# Publica un APK de la app móvil en el VPS para descargarlo desde el ERP (Configuración → App móvil).
#   deploy/publish-apk.sh <archivo.apk> [versión] ["notas de la versión"]
# La versión por omisión sale del nombre del archivo (erp-ventas-prod-0.1.0.apk → 0.1.0). Se conserva la versión anterior como respaldo.
set -euo pipefail
APK="${1:?Uso: publish-apk.sh <archivo.apk> [versión] [notas]}"
[ -f "$APK" ] || { echo "No existe $APK"; exit 1; }
VPS="${ERP_VPS:-galaxy-vps}"
NAME="$(basename "$APK")"
[[ "$NAME" =~ ^[A-Za-z0-9._-]+\.apk$ ]] || { echo "Nombre de archivo no permitido: $NAME (solo letras, números, . _ -)"; exit 1; }
VERSION="${2:-$(echo "$NAME" | sed -E 's/.*-([0-9]+\.[0-9]+\.[0-9]+).*\.apk/\1/')}"
NOTES="${3:-}"
SHA="$(sha256sum "$APK" | cut -d' ' -f1)"
SIZE="$(stat -c %s "$APK")"
echo "Publicando $NAME ($((SIZE / 1048576)) MB, v$VERSION, sha256 ${SHA:0:12}…) en $VPS"

# 1) subir con nombre temporal y 2) activar de forma atómica (latest.json apunta al archivo nuevo)
scp -q "$APK" "$VPS:erp-apk/$NAME.part"
UPLOADED="$(date -u +%Y-%m-%dT%H:%M:%S.000Z)"
ssh -o BatchMode=yes "$VPS" "NAME='$NAME' VERSION='$VERSION' SHA='$SHA' UPLOADED='$UPLOADED' NOTES=$(printf '%q' "$NOTES") bash -s" <<'REMOTE'
set -euo pipefail
cd "$HOME/erp-apk"
mv "$NAME.part" "$NAME"
chmod 644 "$NAME"
python3 - <<PY
import json, os
meta = {"version": os.environ["VERSION"], "fileName": os.environ["NAME"], "sha256": os.environ["SHA"], "uploadedAt": os.environ["UPLOADED"], "notes": os.environ.get("NOTES") or None}
open("latest.json.tmp", "w").write(json.dumps(meta, ensure_ascii=False, indent=2))
PY
chmod 644 latest.json.tmp && mv latest.json.tmp latest.json
# conservar solo el APK vigente y el anterior
ls -1t *.apk 2>/dev/null | tail -n +3 | xargs -r rm -f
ls -la
REMOTE
echo "Listo: el ERP ya ofrece la versión $VERSION en Configuración → App móvil."
