# Mini ERP

Implementación de las **fases 0–5** de `docs/erp-v3.md` (fundación, catálogos, terceros, inventario con costeo, compras).
Monorepo pnpm: `apps/api` (NestJS 11 + Prisma 6 + PostgreSQL 18), `apps/web` (Next.js 16 + TailAdmin), `packages/domain` (cálculo puro compartido) y `packages/contracts`.

## Arranque rápido (desarrollo)

```bash
pnpm install                         # requiere pnpm (npm i -g pnpm)
pnpm db:up                           # PostgreSQL 18 (:55432) y Redis (:56379) en Podman, aislados de otros proyectos
apps/api/scripts/db-reset.sh minierp # crea roles + base + migraciones (RLS, FK compuestas, triggers)
cd apps/api && SEED_DEMO=1 pnpm db:seed && cd ../..   # monedas, bancos, permisos, superadmin y empresa demo
scripts/dev.sh up                    # API http://localhost:3101 (Swagger: /api/docs) · Web http://localhost:3100
scripts/dev.sh down                  # detener API y web
```

Usuarios de **desarrollo** (contraseña de semilla `Admin12345!`, cambiar `SEED_PASSWORD` fuera de local):

| Usuario | Rol |
|---|---|
| `admin@demo.local` | **Administrador global**: ve todas las empresas de todos los clientes y crea clientes/empresas |
| `superadmin@erp.local` | Otro administrador global (sin empresa propia) |
| `admin.ktsu@demo.local` | Administrador del cliente «KTSU-JAC»: ve solo KTSU y JAC; puede crear empresas en su cliente |
| `admin.sinocars@demo.local` | Administrador del cliente «Sinocars»: ve solo SIN0CARS y ELECTRICOS DEL SUR |
| `admin.ayagba@demo.local` | Administrador del cliente «Ayagba»: ve solo Ayagba Glam |

## Pruebas

```bash
pnpm --filter @erp/domain test       # 11 pruebas unitarias (totales, IVA, IGTF, costeo, RIF)
cd apps/api && npx jest --config jest.e2e.config.js   # 80 pruebas e2e contra PostgreSQL/Redis reales (BD `minierp_test`, se recrea sola)
```

Las e2e cubren: autenticación (bloqueo, rotación y reutilización de refresh, revocación), aislamiento multiempresa (RLS + FK compuestas),
RBAC, costeo promedio, kardex inmutable, anulaciones, **concurrencia** (última unidad, numeración sin huecos, costo entre depósitos),
lotes FEFO, períodos, idempotencia y el flujo completo de compras.

## Qué incluye

| Fase | Alcance implementado |
|---|---|
| Clientes | Modelo cliente → empresas → usuarios: cada administrador de cliente ve y crea solo las empresas de su cliente; el administrador global ve todas; un usuario normal solo las que se le asignan (ver `avances.md`) |
| S0 Fundación | Monorepo, API con config validada, Pino, health, Swagger, errores estándar, JWT (access 15 min + refresh rotativo con detección de robo), RBAC por permisos, auditoría, numeración sin huecos, idempotencia, **RLS obligatorio** + roles `erp_migrator`/`erp_app`, shell web con sesión BFF (cookie `httpOnly`) |
| S1 Catálogos | Empresa (datos fiscales, feature flags), usuarios/roles, monedas, **factor cambiario** (historial inmutable), impuestos con vigencia, depósitos, instancias, unidades, productos (OEM, códigos de barras, precios con historial), listas de precio |
| S2 Terceros | Proveedores, clientes (RIF validado), zonas, vendedores, instrumentos de pago, bancos y cuentas, tipos de operación, motivos |
| S3–S4 Inventario | Kardex, existencias, **costo promedio ponderado**, cargos, descargos, traslados, ajustes (hoja de conteo), ajuste de costo, **lotes con vencimiento (FEFO)** tras flag, stock negativo configurable, **períodos de inventario**, valorización actual/histórica |
| S5 Compras | Cotización → orden → nota de entrega → compra, devoluciones (al costo original), anulaciones con reversos, cuentas por pagar, trazabilidad por `document_links` |

Además: tasas BCV automáticas (DolarApi) con tasa manual por empresa, numeración configurable, seriales y edición/baja de empresas.

**Reportes** (25, exportables a PDF/Excel/CSV) y **importación de datos** desde Excel/CSV (instancias, productos, proveedores, clientes y existencias iniciales). Los reportes de ventas, clientes con CxC y fiscales llegan con sus módulos (D16).

## Decisiones y desviaciones respecto a `erp-v3.md` (a revisar)

- **Prisma 6.19** (no «la última»: el tag `latest` de Prisma es hoy un RC 8). NestJS 11.
- **Validación Zod con pipe propio** + `nestjs-zod` solo para Swagger (Zod 3.25).
- **Frontend** con TanStack Query/Table, React Hook Form + Zod y Zustand (instalados con autorización). Dexie y Serwist siguen sin usarse (PWA/offline: S7–S8).
- **Interfaz solo en español** (`es`); el template traía `en`, que se eliminó.
- **Compras de contado** se registran con la CxP en estado `PAID` (el pago/banco real llega con CxP y Bancos, S11/S13).
- Si el precio de la factura difiere del de la nota de entrega, **no se revaloriza** el costo ya ingresado (límite documentado).
- **Seriales** operativos (se activan por empresa y por producto); el costo sigue siendo promedio por producto (no por serial).
- **Tasas**: las del BCV son globales (DolarApi, fuente oficial); si la API no responde se carga manual. Una tasa manual solo aplica a su empresa.
- El ejemplo numérico de `erp-v2.md §9.9` tenía un error: 41,325 × 36,52 = **1.509,189** (no 1.509,219).
- Los porcentajes fiscales y la lista de bancos son **de referencia**: validar con el contador antes de producción (v3 §8).

## Pendiente del Sprint 0 / fases (no hecho)

Despliegue al VPS (Caddy, Quadlet, CI/CD en GitHub Actions), backups con copia externa, cliente API generado desde OpenAPI,
PWA base, workers BullMQ (el sync de tasas usa un planificador ligero con candado en Redis),
exportación PDF/Excel y el resto de reportes.

## Notas operativas

- El PostgreSQL del equipo (`:5432`) es **compartido con otros proyectos**; este proyecto usa sus propios contenedores (`minierp-postgres`, `minierp-redis`).
- Migraciones: **no usar `prisma migrate dev`** (RLS/FK/triggers están en SQL manual); usar `prisma migrate deploy` (`pnpm --filter @erp/api db:migrate`) o `db-reset.sh`.
- Acceso por HTTP en red local: la cookie de sesión es `Secure` en producción; usar `COOKIE_SECURE=false` solo para pruebas.
- Reutilizar un refresh token ya rotado dentro de 10 s (dos pestañas) se tolera; fuera de esa ventana se revoca toda la sesión.
