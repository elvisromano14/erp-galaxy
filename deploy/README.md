# Despliegue del ERP al VPS (`galaxy-vps`)

El ERP corre en **Podman sin root** (unidades Quadlet de usuario) junto a otros proyectos que ya están en producción en el mismo servidor.
**Todo lo propio del ERP lleva el prefijo `erp`** y no toca nada de KTSU ni JAC.

```
Internet ──HTTPS──▶ Tailscale Funnel :10000 ──▶ erp-web (Next.js, 127.0.0.1:3300)
                                                   │  /api/v1/*  y  /api/session/*
                                                   ▼
                                               erp-api (NestJS + workers BullMQ, 127.0.0.1:3301)
                                                   │                    │
                                  PostgreSQL 18 del host (base `erp`)   erp-redis (127.0.0.1:6390)
```

| Pieza | Detalle |
|---|---|
| Acceso público | `https://prod-cloud.tailf30e87.ts.net:10000` (Tailscale Funnel; los puertos 443 y 8443 son de KTSU y JAC) |
| Contenedores | `erp-web`, `erp-api`, `erp-redis` (red del host; API y Redis solo en 127.0.0.1; la web escucha en 0.0.0.0:3300 —Next lo exige tras Funnel— pero UFW niega todo lo entrante salvo SSH; sistema de archivos de solo lectura, sin capacidades, con tope de memoria) |
| Base de datos | PostgreSQL 18 **del servidor** (no en contenedor): base `erp`, roles `erp_migrator` (DDL), `erp_app` (DML, sin BYPASSRLS), `erp_backup` (solo lectura, para respaldos) |
| Secretos | `~/.config/erp/*.env` (modo 600), generados una sola vez por `vps-setup.sh` |
| Respaldo | `erp-backup.timer` diario 03:30 → `~/backups/erp/erp-*.sql.gz` (14 copias). **Falta una copia fuera del servidor** |
| Imágenes | Se construyen en el equipo de desarrollo y se suben por SSH (`podman save | ssh podman load`); no se compila nada en el VPS |

## Uso

```bash
deploy/deploy.sh              # construye, sube, migra, reinicia y verifica
deploy/deploy.sh --no-build   # reutiliza las imágenes locales ya construidas
deploy/deploy.sh --rollback   # vuelve a las imágenes anteriores (las migraciones NO se revierten)
```

La primera ejecución aprovisiona el VPS (`vps-setup.sh`: roles y base, archivos de entorno, unidades Quadlet, respaldo) y publica el Funnel.
Las siguientes solo actualizan imágenes y migran. Es idempotente.

**Administrador inicial**: `ssh galaxy-vps 'grep ADMIN_ ~/.config/erp/secrets.env'` (cambie la contraseña al entrar).
Después cree clientes y empresas desde la web (Configuración → Clientes / Empresas).

## Operación

```bash
ssh galaxy-vps 'systemctl --user status erp-api erp-web erp-redis'
ssh galaxy-vps 'journalctl --user -u erp-api -f'                  # registros (también erp-web, erp-redis)
ssh galaxy-vps 'systemctl --user restart erp-api'
ssh galaxy-vps 'podman ps --filter name=erp-'                      # estado y salud
ssh galaxy-vps '~/.local/bin/erp-backup.sh'                         # respaldo manual
# restaurar (en una base vacía): gunzip -c erp-AAAAMMDD.sql.gz | psql -h 127.0.0.1 -U erp_migrator erp
```

Variables de entorno de la API: `~/.config/erp/api.env` (ver `apps/api/.env.example`). Cambios → `systemctl --user restart erp-api`.
`TRUST_PROXY_HOPS=2` porque delante de la API hay Next.js y Tailscale (la IP real del cliente se usa para limitar intentos de acceso).

## Archivos

| Archivo | Para qué |
|---|---|
| `Containerfile.api`, `Containerfile.web` | Imágenes multi-etapa (usuario no root, `tini`, healthcheck) |
| `quadlet/erp-*.container` | Unidades Quadlet (se copian a `~/.config/containers/systemd/`) |
| `vps-setup.sh` | Aprovisionamiento idempotente (corre en el VPS) |
| `erp-backup.*` | Respaldo diario con rotación |
| `deploy.sh` | Script de despliegue manual |
| `healthcheck.js` | Comprobación de salud dentro de los contenedores |

## Despliegue automático (GitHub Actions)

`.github/workflows/ci-cd.yml` tiene dos trabajos:

1. **Pruebas** (en cada push y pull request): PostgreSQL 18 y Redis en contenedores, pruebas del dominio, tipos y e2e de la API, comprobación de que el cliente OpenAPI está regenerado, y tipos, lint y compilación de la web.
2. **Desplegar al VPS** (solo en `main`, después de pasar las pruebas): conecta el ejecutor a la red Tailscale, entra por SSH y corre el mismo `deploy/deploy.sh`. Está **apagado** hasta definir la variable `DEPLOY_ENABLED=true`; también se puede lanzar a mano (Actions → CI/CD → Run workflow → deploy).

El VPS solo acepta SSH desde dos IP; los ejecutores de GitHub no pueden usarlas, así que entran por Tailscale. Preparación (una sola vez):

| Dónde | Qué |
|---|---|
| Tailscale (consola de administración) | En la política ACL: `"tagOwners": {"tag:ci": ["autogroup:admin"]}` y una regla que permita `tag:ci` → `prod-cloud:22`. Crear un **cliente OAuth** con permiso *Auth Keys: write* y la etiqueta `tag:ci`. |
| VPS | `sudo ufw allow in on tailscale0 to any port 22 proto tcp` (SSH solo desde la red Tailscale). Crear una clave `ssh-keygen -t ed25519 -f erp_ci -N ""` y agregar `erp_ci.pub` a `~/.ssh/authorized_keys` con el prefijo `from="100.64.0.0/10" `. |
| GitHub → Settings → Secrets (Actions) | `TS_OAUTH_CLIENT_ID`, `TS_OAUTH_SECRET`, `VPS_SSH_KEY` (la clave privada), `VPS_KNOWN_HOSTS` (salida de `ssh-keyscan -t ed25519 <host>`). |
| GitHub → Settings → Variables | `VPS_HOST` (nombre o IP Tailscale del VPS, p. ej. `100.106.134.19`) y `DEPLOY_ENABLED=true`. |
| GitHub → Settings → Environments | Crear `production` y, si se desea, exigir un revisor para aprobar cada despliegue. |

**Riesgo a tener presente**: la clave de despliegue entra como el usuario `galaxy`, que tiene `sudo` sin contraseña en un servidor compartido con KTSU y JAC. Por eso se limita a la red Tailscale y se recomienda exigir aprobación en el entorno `production`.

## Pendiente (siguiente etapa)

- Copia externa de los respaldos (otro servidor o almacenamiento de objetos).
- Un dominio propio con certificado (hoy se usa el de Tailscale Funnel).
