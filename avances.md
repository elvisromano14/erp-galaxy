# Avances — Mini ERP (erp-galaxy)

Última actualización: 2026-10-09 · Plan de referencia: [`docs/erp-v3.md`](docs/erp-v3.md)

## 1. Qué está hecho

**Fases del roadmap cubiertas:** S0 (parcial), S1, S2, S3–S4 y S5.

| Área | Estado | Detalle |
|---|---|---|
| Fundación (S0) | ✅ parcial | Monorepo pnpm, API NestJS 11 + Prisma 6 + PostgreSQL 18, config validada, logs Pino, health, Swagger, errores estándar, idempotencia, numeración sin huecos, auditoría |
| Seguridad | ✅ | JWT (access 15 min + refresh rotativo con detección de robo y ventana de gracia de 10 s), argon2id, bloqueo por intentos, RBAC por permisos, rate limiting, roles de BD `erp_migrator`/`erp_app` |
| Multiempresa | ✅ | **RLS obligatorio** (falla cerrada) + FK compuestas `(company_id, id)`; un usuario puede pertenecer a varias empresas |
| Catálogos (S1) | ✅ | Empresa y flags, usuarios/roles, monedas, factor cambiario (historial inmutable), impuestos con vigencia, depósitos, instancias, unidades, productos (OEM, barras, precios con historial), listas de precio |
| Terceros (S2) | ✅ | Proveedores, clientes (RIF validado), zonas, vendedores, instrumentos de pago, bancos y cuentas, tipos de operación, motivos |
| Inventario (S3–S4) | ✅ | Kardex inmutable, costo promedio ponderado, cargos/descargos/traslados/ajustes/ajuste de costo, lotes con vencimiento (FEFO) tras flag, stock negativo configurable, períodos de inventario, valorización actual e histórica |
| Compras (S5) | ✅ | Cotización → orden → nota de entrega → compra, devoluciones al costo original, anulaciones con reversos, cuentas por pagar, trazabilidad |
| Frontend | ✅ base | Next 16 + TailAdmin en español: login con sesión BFF (cookie httpOnly), selector de empresa, menú por permisos, 43 pantallas (catálogos genéricos, productos, inventario, compras, configuración) |
| Pruebas | ✅ | 11 unitarias (dominio) + 44 e2e contra PostgreSQL/Redis reales (auth, RLS, costeo, concurrencia, lotes, compras) + recorrido de UI con Chrome headless (manual, no versionado) |

## 2. Qué falta

**Del Sprint 0 / infraestructura (aplazado a propósito: no se monta nada en el VPS aún)**
- Despliegue al VPS (Caddy, Quadlet/Podman, CI/CD en GitHub Actions) y backups con copia externa
- Cliente API generado desde OpenAPI; PWA base

**Funcional pendiente dentro de lo ya iniciado**
- Pantalla de secuencias de numeración (hoy se crean solas con prefijos por defecto)
- Sincronización de la tasa BCV (hoy carga manual)
- Seriales (diseño listo, bloqueado con `FEATURE_NOT_AVAILABLE`)
- Reportes: solo existencias, kardex y valorizado; sin exportación PDF/Excel
- Workers BullMQ (mín/máx, alertas, jobs programados)
- Migrar las pantallas a TanStack Query/Table y React Hook Form (paquetes ya instalados, aún sin usar)

**Fases siguientes del roadmap**
- S6 Importación de datos · S7–S8 Ventas + motor offline (Dexie/Serwist) · S9–S10 Facturación fiscal (IVA, IGTF, número de control, libros) · S11 CxC/CxP y retenciones · S12 Piloto offline · S13 Bancos y conciliación · S14 Precios/reposición · S15–S16 Reportes y fiscal · S17–S18 Endurecimiento y salida

**Decisiones/validaciones abiertas**
- Proveedor de numeración y control fiscal (antes de S7) y validación fiscal con el contador (porcentajes y bancos son de referencia)
- Modo A/B de facturación offline; cobros offline sí/no; fuente de la tasa BCV

**Límites conocidos**
- Compras de contado quedan con CxP `PAID` hasta que exista el módulo de pagos
- Diferencias de precio entre nota de entrega y factura no revalorizan el costo ya ingresado

## 3. Cómo probar

### Requisitos
Node ≥ 24, pnpm (`npm i -g pnpm`), Podman con `podman-compose`, `psql` y Google Chrome (solo para pruebas de UI).

### Primera vez
```bash
git clone https://github.com/elvisromano14/erp-galaxy && cd erp-galaxy
cp apps/api/.env.example apps/api/.env
pnpm install
pnpm --filter @erp/domain --filter @erp/contracts build
pnpm db:up                                   # PostgreSQL 18 (:55432) y Redis (:56379)
apps/api/scripts/db-reset.sh minierp         # roles + base + migraciones (RLS, FK, triggers)
(cd apps/api && npx prisma generate && SEED_DEMO=1 pnpm db:seed)   # datos demo
scripts/dev.sh up                            # compila la web y levanta API + web
```

### Probar las interfaces
| Qué | Dónde |
|---|---|
| Aplicación web | http://localhost:3100 |
| API con Swagger (probar endpoints) | http://localhost:3101/api/docs |
| Usuario administrador | `admin@demo.local` / `Admin12345!` |
| Superadmin (crea empresas por API) | `superadmin@erp.local` / `Admin12345!` |

Recorrido sugerido en la web: **Administración → Factor cambiario** (cargar tasa USD) → **Compras → Órdenes de compra → Nuevo** → confirmar → *Recibir* → *Facturar* → *Crear devolución* → revisar **Inventario → Kardex** y **Existencias**. Para ver lotes/vencimiento: **Configuración → Empresa** (activar lotes).

### Detener / reiniciar
```bash
scripts/dev.sh status        # estado de puertos
scripts/dev.sh down          # detiene API y web
pnpm db:down                 # apaga PostgreSQL y Redis
```

### Pruebas automáticas
```bash
pnpm --filter @erp/domain test                                  # unitarias
cd apps/api && npx jest --config jest.e2e.config.js             # e2e (recrea la BD minierp_test sola)
cd apps/web && npx eslint src && pnpm build                     # lint y compilación de la web
```

### Desarrollo con recarga
```bash
cd apps/api && pnpm dev          # API (ts-node)
cd apps/web && pnpm dev          # web en :3100
```
> Cambios en `packages/*` requieren `pnpm --filter @erp/domain build`.
