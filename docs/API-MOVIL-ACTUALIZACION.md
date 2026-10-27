# API móvil: actualización automática de la app

La app **no se publica en tiendas**: el APK vive en el servidor (`MOBILE_APK_DIR`, junto con `latest.json`) y lo publica `deploy/publish-apk.sh`.
Estos dos endpoints permiten que la app, **con su sesión**, consulte y descargue la versión vigente (el enlace firmado de 10 minutos de
`/mobile/app/link` sigue existiendo para descargar desde el navegador o con QR).

Ambos exigen sesión con el permiso `mobile:sync:use`. **No** pasan por el control de versión mínima (`X-App-Version` → 426): una app
desactualizada debe poder consultar y descargar su actualización.

## `GET /mobile/app/latest?current=x.y.z`
`current` = versión instalada (opcional; formato `x.y.z`, otro formato → 400).

```json
{
  "available": true,
  "version": "1.5.0",            // versión publicada (null si no hay APK)
  "versionCode": 15,             // opcional: VERSION_CODE=15 deploy/publish-apk.sh … (null si no se registró)
  "updateAvailable": true,       // version > current (o sin `current`)
  "mandatory": false,            // current < MOBILE_MIN_APP_VERSION: la app debe actualizar antes de seguir
  "minAppVersion": "1.0.0",
  "notes": "Crea productos",
  "sizeBytes": 250000,
  "sha256": "…",                 // la app verifica tamaño y huella antes de instalar
  "fileName": "erp-ventas-prod-1.5.0.apk",
  "uploadedAt": "2026-10-27T00:00:00.000Z",
  "downloadPath": "/api/v1/mobile/app/latest/file"   // null si no hay APK
}
```

## `GET /mobile/app/latest/file`
Transmite el APK vigente (`application/vnd.android.package-archive`) con `Content-Length`, `Accept-Ranges` y **`Range`** (206 con
`Content-Range`) para reanudar descargas interrumpidas; `Cache-Control: private, no-store`. 404 si no hay APK publicado.
Queda auditado el inicio de cada descarga (acción `UPDATE_DOWNLOAD`).

## Publicación
```bash
VERSION_CODE=12 deploy/publish-apk.sh erp-ventas-prod-0.2.0.apk 0.2.0 "Crea productos desde la app; actualización automática"
```
- Para **obligar** a actualizar a todos, suba `MOBILE_MIN_APP_VERSION` en el servidor (los pendientes de la app no se pierden).
- Android solo actualiza una app si el APK nuevo está firmado con **la misma clave** que la instalada y tiene el mismo `applicationId`
  (variantes dev/staging/prod son apps distintas): use siempre el *Release firmado* con el keystore de la empresa.
