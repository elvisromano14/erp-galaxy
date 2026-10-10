# Mini ERP – Guía de Desarrollo v3 (documento de arranque consolidado)

> **Nota (2026-10):** el modo offline/PWA descrito en este plan (D7, sección 10 y partes de 6.7) **se hará en otro proyecto** (app móvil en otra tecnología, que consume `packages/api-client`). En este repositorio ya no hay Dexie, Serwist ni la bandera `offline`.

> **Stack:** NestJS · Next.js (TailAdmin Free) como **PWA offline-first** · PostgreSQL 18 · Redis · JWT
> **Mercado:** Venezuela (SENIAT) · **Multiempresa** · **Lotes/seriales/vencimiento opcionales**
> **Hosting:** VPS Ubuntu 24.04 (2 vCPU · 4 GB RAM · 20 GB SSD) con Podman + Tailscale
> **Esta versión consolida v2 + v2.1** y reemplaza a las anteriores. Es el documento de referencia para el desarrollo.

---

## Tabla de contenido

0. [Registro de decisiones y cambios respecto a v1](#0-registro-de-decisiones-y-cambios-respecto-a-v1)
1. [Alcance y principios](#1-alcance-y-principios)
2. [Stack tecnológico definitivo](#2-stack-tecnológico-definitivo)
3. [Presupuesto de recursos del VPS](#3-presupuesto-de-recursos-del-vps)
4. [Arquitectura](#4-arquitectura)
5. [Multiempresa](#5-multiempresa)
6. [Modelo de datos](#6-modelo-de-datos)
7. [Reglas de negocio transversales](#7-reglas-de-negocio-transversales)
8. [Normativa fiscal Venezuela](#8-normativa-fiscal-venezuela)
9. [Lotes, seriales y vencimiento (opcional por producto)](#9-lotes-seriales-y-vencimiento-opcional-por-producto)
10. [Offline-first para vendedores](#10-offline-first-para-vendedores)
11. [API: convenciones y catálogo de endpoints](#11-api-convenciones-y-catálogo-de-endpoints)
12. [Seguridad](#12-seguridad)
13. [Reportes](#13-reportes)
14. [Frontend](#14-frontend)
15. [Procesos en segundo plano](#15-procesos-en-segundo-plano)
16. [Infraestructura y despliegue en el VPS](#16-infraestructura-y-despliegue-en-el-vps)
17. [Repositorio y arranque (Sprint 0)](#17-repositorio-y-arranque-sprint-0)
18. [Estrategia de pruebas](#18-estrategia-de-pruebas)
19. [Roadmap y backlog por sprint](#19-roadmap-y-backlog-por-sprint)
20. [Riesgos y pendientes por validar](#20-riesgos-y-pendientes-por-validar)
21. [Especificaciones ampliadas (v2.1)](#21-especificaciones-ampliadas-incorporadas-de-v21)
- [Anexo A – Glosario](#anexo-a--glosario)
- [Anexo B – Definición de "terminado"](#anexo-b--definición-de-terminado)

---

## 0. Registro de decisiones y cambios respecto a v1

### 0.1 Decisiones confirmadas

| # | Tema | Decisión |
|---|---|---|
| D1 | País / fiscal | **Venezuela** (SENIAT: IVA, IGTF, retenciones IVA/ISLR, libros de compras y ventas, facturación con número de control) |
| D2 | Multiempresa | **Varias empresas en la misma instalación** (una BD, columna `company_id`, un usuario puede pertenecer a varias empresas) |
| D3 | Costeo | **Promedio ponderado móvil** (abstraído en `CostingStrategy` para añadir PEPS luego) |
| D4 | Lotes / seriales / vencimiento | **Incluidos en el diseño, desactivados por defecto**; se activan por empresa (feature flag) y por producto (`tracking_mode`) |
| D5 | Volumen | Transaccionalidad moderada, **10 usuarios concurrentes** → monolito modular en un solo servidor es suficiente |
| D6 | Hosting | VPS Ubuntu 24.04 · 2 vCPU · 4 GB · 20 GB SSD · **PostgreSQL 18 en el host** · Podman · Tailscale |
| D7 | Offline | **Vendedores deben operar sin conexión** → PWA con IndexedDB + cola de sincronización (sección 10) |

### 0.2 Cambios técnicos respecto a v1 (y por qué)

| Tema | v1 | v2 | Motivo |
|---|---|---|---|
| Validación | class-validator | **Zod** compartido (`packages/contracts`) | Mismos esquemas en API, web y cliente offline |
| PDF | Puppeteer | **pdfmake** (o `@react-pdf/renderer`) | Chromium consume 300–500 MB; el VPS tiene 4 GB |
| Observabilidad | OpenTelemetry + Prometheus + Grafana | **Pino + `/health` + Sentry (opcional) + `pg_stat_statements`** | Ahorro de RAM y disco |
| Backups | pg_dump + WAL/PITR | **pg_dump diario + copia externa** (PITR queda opcional) | Solo 20 GB de disco |
| Tablas de documentos | ~30 pares cabecera/líneas | **Modelo unificado**: `sales_documents`, `purchase_documents`, `inventory_documents` + tabla `document_links` | Menos código, una sola máquina de estados |
| IDs | uuid v4 / bigint | **UUIDv7** (`uuidv7()` nativo de PG18) | Ordenables por tiempo, el cliente offline puede generarlos |
| Multi-tenant | RLS opcional | **Filtro por `company_id` vía extensión de Prisma + FK compuestas**; RLS queda como endurecimiento posterior | Prisma no maneja RLS cómodamente |
| Workers | Contenedor aparte | **Mismo proceso que la API** (`WORKER_ENABLED=true`) | Ahorro de RAM |
| Costo de inventario | Moneda base | **Moneda de valoración configurable** (recomendado USD) + equivalente en Bs a tasa del día | Realidad económica venezolana |
| Proxy | Nginx/Traefik | **Caddy** (TLS automático) | Configuración mínima |
| Lotes/seriales | Pendiente | Diseño incluido (sección 9) | Decisión D4 |
| Offline | No contemplado | Sección 10 | Decisión D7 |

---

## 1. Alcance y principios

Sistema ERP ligero que cubre el ciclo **compra → inventario → venta → cobro/pago → banco → impuestos → reportes**, inicialmente para una empresa de venta de repuestos, pero diseñado para múltiples empresas y otros giros.

| Principio | Aplicación |
|---|---|
| Monolito modular | Un despliegue; módulos NestJS desacoplados por dominio y comunicados por eventos internos |
| Ledgers inmutables | Kardex, CxC, CxP, bancos y libros fiscales son **registros de solo inserción**; se corrigen con asientos inversos |
| Documentos confirmados no se editan | Se anulan o se corrigen con nota de crédito/débito, devolución o ajuste |
| Servidor autoritativo | Stock, numeración fiscal y totales finales los decide el servidor; el cliente offline propone |
| Parámetros fiscales en datos, no en código | Alícuotas, porcentajes de retención y vigencias son configurables y con fecha de vigencia |
| Opcional sin estorbar | Lotes/seriales/vencimiento no aparecen ni cuestan nada a quien no los use |
| Idempotencia | Toda escritura crítica acepta clave de idempotencia (necesario para sincronización offline) |

---

## 2. Stack tecnológico definitivo

### Backend

| Capa | Tecnología | Notas |
|---|---|---|
| Runtime | **Node.js 24 LTS** | |
| Framework | **NestJS 11** (TypeScript `strict`) | |
| ORM | **Prisma** (última estable) | CRUD y transacciones. Reportes y bloqueos con **SQL crudo** (`$queryRaw`, TypedSQL). Migraciones con SQL manual para triggers, índices parciales y vistas |
| Base de datos | **PostgreSQL 18** (host) | `uuidv7()` nativo, columnas generadas virtuales |
| Caché / colas | **Redis 7** (contenedor) + **BullMQ** | `maxmemory 128mb`, política `noeviction` para colas |
| Validación | **Zod** + `nestjs-zod` | Esquemas en `packages/contracts` |
| Docs API | `@nestjs/swagger` (OpenAPI 3) | Cliente TS generado con `orval` u `openapi-typescript` |
| Auth | `@nestjs/jwt`, `passport-jwt`, **argon2id** | Access 15 min + refresh rotativo |
| Logs | `nestjs-pino` | JSON → journald |
| Reportes | **ExcelJS**, **pdfmake**, `fast-csv` | Sin navegador headless |
| Decimales | **decimal.js** | Nunca `number` para dinero/cantidades |
| Eventos | `@nestjs/event-emitter` | Desacople interno |
| Jobs | `@nestjs/schedule` (cron) + BullMQ | |
| Tests | Jest, Supertest, Testcontainers (PG 18 + Redis) | |

### Frontend / PWA

| Capa | Tecnología |
|---|---|
| Framework | **Next.js (App Router)** + TypeScript — usar la versión que traiga el template TailAdmin (Next 15/16, React 19, Tailwind 4) |
| UI | **TailAdmin Free Next.js** — https://github.com/TailAdmin/free-nextjs-admin-dashboard |
| PWA / Service Worker | **Serwist** (`@serwist/next`) |
| Base local offline | **Dexie** (IndexedDB) |
| Datos servidor | **TanStack Query** |
| Tablas | **TanStack Table** |
| Formularios | **React Hook Form + Zod** |
| Estado | **Zustand** |
| Gráficos | ApexCharts (incluido en TailAdmin) |
| i18n | `next-intl` (es-VE por defecto) |
| Fechas | `date-fns` (zona horaria `America/Caracas`) |

### Paquetes compartidos (monorepo)

| Paquete | Contenido |
|---|---|
| `packages/contracts` | Esquemas Zod, DTOs, enums, tipos de la API |
| `packages/domain` | **Lógica pura** (sin I/O) usada por API **y** cliente offline: cálculo de totales, impuestos, IGTF, conversión de moneda, redondeo |
| `packages/config` | tsconfig, ESLint, Prettier |

> **Regla clave:** `packages/domain` es la única implementación de cálculo de líneas/impuestos. El cliente offline calcula con ella y el servidor **recalcula** al sincronizar; si difieren, gana el servidor y se registra la discrepancia.

---

## 3. Presupuesto de recursos del VPS

Servidor: **2 vCPU · 4 GB RAM · 20 GB SSD**.

### RAM (objetivo)

| Componente | Reserva |
|---|---|
| Sistema operativo + Tailscale + Caddy | ~450 MB |
| PostgreSQL 18 | ~900 MB (`shared_buffers=512MB`) |
| API NestJS + workers (`--max-old-space-size=400`) | ~550 MB |
| Next.js standalone (`--max-old-space-size=256`) | ~350 MB |
| Redis | ~100 MB |
| **Total** | **~2,35 GB** |
| Libre para caché de SO, picos de reportes | ~1,6 GB |

Crear **swap de 2 GB** (`fallocate`, `swapon`, `vm.swappiness=10`).

### Disco (20 GB)

| Uso | Reserva |
|---|---|
| SO + paquetes | ~6 GB |
| Imágenes Podman (limpiar con `podman image prune`) | ~3 GB |
| PostgreSQL (año 1) | ~2–4 GB |
| Backups locales (7 diarios comprimidos) | ~2 GB |
| Swap | 2 GB |
| Logs (journald limitado a 500 MB) y temporales de reportes | ~1 GB |
| **Holgura** | ~2–3 GB |

**Reglas para no quedarse sin disco:**

- Los reportes se escriben en `/var/lib/erp/tmp` con **TTL de 24 h** (job de limpieza).
- Los backups se **copian fuera del VPS** y localmente solo se retienen 7 días.
- Alerta cuando el disco supere 80 %.
- **Construir imágenes en CI (GitHub Actions)**, nunca en el VPS (el build de Next.js consume demasiada RAM y disco).
- Cuando sea posible, ampliar a 40 GB: es la mejora de menor costo con mayor impacto.

### Ajuste de PostgreSQL 18 (`/etc/postgresql/18/main/conf.d/erp.conf`)

```conf
listen_addresses = 'localhost'        # + IP de Tailscale si se administra remoto
max_connections = 50
shared_buffers = 512MB
effective_cache_size = 1536MB
work_mem = 8MB
maintenance_work_mem = 128MB
wal_compression = on
checkpoint_timeout = 15min
max_wal_size = 1GB
random_page_cost = 1.1                # SSD
jit = off                             # evita latencia en consultas pequeñas
shared_preload_libraries = 'pg_stat_statements'
log_min_duration_statement = 500ms
timezone = 'America/Caracas'
```

---

## 4. Arquitectura

```
 Vendedor (PWA, offline)         Oficina (navegador)
        │  HTTPS                        │  HTTPS
        └──────────────┬────────────────┘
                       ▼
            ┌────────────────────┐   Internet: 80/443
            │ Caddy (host, TLS)  │
            └───┬────────────┬───┘
         /api/* │            │ /*
                ▼            ▼
      ┌──────────────┐  ┌──────────────┐        Admin: SSH / psql
      │ NestJS API   │  │ Next.js      │        solo por Tailscale
      │ + workers    │  │ (standalone) │
      └──┬────────┬──┘  └──────────────┘
         │        │
   ┌─────▼───┐ ┌──▼──────┐
   │ Postgres│ │ Redis   │   (todo en el mismo VPS;
   │ 18 host │ │ podman  │    API y web en Podman con Quadlet)
   └─────────┘ └─────────┘
```

Web y API se sirven bajo **el mismo dominio** (`/api/*` → API). Esto elimina CORS, simplifica cookies y es necesario para el Service Worker.

### 4.1 Capas de cada módulo NestJS

```
modulo/
├── presentation/    Controllers, guards, mapeo DTO
├── application/     Casos de uso / servicios (orquestan, abren transacción)
├── domain/          Reglas, entidades, eventos, máquina de estados
└── infrastructure/  Repositorios Prisma, SQL crudo, adaptadores externos
```

### 4.2 Motor de documentos y de contabilización (clave del diseño)

Todos los documentos comerciales comparten un motor:

```
DocumentTypeRegistry  →  define por tipo de documento:
   · estados y transiciones permitidas
   · efectos: inventario (+/−/0), CxC, CxP, banco, libro fiscal
   · serie de numeración y si requiere número fiscal/de control
   · permisos requeridos

PostingService.confirm(doc)   — UNA transacción SQL:
   1. Validar estado y permisos
   2. Recalcular totales con packages/domain
   3. Asignar número (document_sequences, SELECT … FOR UPDATE)
   4. InventoryPoster   → inventory_movements + inventory_stock (+ lotes/seriales)
   5. ReceivablePoster / PayablePoster
   6. TaxBookPoster     → tax_book_entries (libro de ventas/compras)
   7. BankPoster        → bank_transactions (si el cobro/pago es bancario)
   8. Marcar CONFIRMED + audit_log + evento de dominio

PostingService.void(doc, reason)  — genera asientos INVERSOS (nunca borra)
```

La tabla **`operation_types`** (menú *Administración → Operaciones*) parametriza estos efectos por tipo de operación (afecta inventario, CxC, CxP, banco; requiere número fiscal; serie).

### 4.3 Modelo unificado de documentos

| Tabla cabecera | Tipos (`doc_type`) |
|---|---|
| `sales_documents` | `QUOTE`, `BUDGET`, `ORDER`, `ORDER_RETURN`, `INVOICE`, `CREDIT_NOTE`, `DEBIT_NOTE` |
| `purchase_documents` | `QUOTE`, `ORDER`, `DELIVERY_NOTE`, `DELIVERY_NOTE_RETURN`, `PURCHASE`, `PURCHASE_RETURN` |
| `inventory_documents` | `TRANSFER`, `CHARGE`, `DISCHARGE`, `ADJUSTMENT` |

Cada una con su tabla `*_lines`. Además:

- `document_links` (`parent_type, parent_id, child_type, child_id, quantity_map`) → trazabilidad y cantidades pendientes (pedido → factura, OC → recepción → compra).
- `sales_fiscal_data` (1:1 con facturas/NC/ND): número fiscal, número de control, factura afectada, proveedor de imprenta, etc.
- `document_cancellations` (motivo, usuario, fecha).

---

## 5. Multiempresa

**Estrategia:** base de datos única; toda tabla de negocio lleva `company_id`.

| Aspecto | Diseño |
|---|---|
| Usuarios | `users` global + `user_companies` (usuario ↔ empresa ↔ roles). Un usuario puede operar varias empresas |
| Sesión | Al iniciar sesión se **elige empresa**; el JWT lleva `companyId`. Cambiar de empresa emite un token nuevo |
| Aislamiento | **Extensión de Prisma** que inyecta `company_id` en toda lectura/escritura + índices con `company_id` primero + **FK compuestas** `(company_id, x_id)` para impedir referencias entre empresas |
| Unicidad | Siempre por empresa: `UNIQUE (company_id, sku)`, `(company_id, rif)`, etc. |
| Parámetros | Cada empresa tiene su moneda base, moneda de valoración, feature flags (`lots`, `serials`, `expiry`, `offline`), datos fiscales, secuencias, impuestos y listas de precio |
| Catálogos compartidos | Globales (sin `company_id`): `banks`, `currencies`, `islr_concepts` (semilla). Tasas de cambio: globales (BCV) |
| Auditoría | Registra `company_id` y `user_id` |
| Reportes | Siempre limitados a la empresa activa (sin consolidado multiempresa en el alcance inicial) |
| Futuro | Si una empresa crece, su BD puede extraerse por `company_id` |

**RLS obligatorio desde S0** (decisión D8): ver sección 21.2.

---

## 6. Modelo de datos

### 6.1 Convenciones

- Tablas `snake_case` en inglés, plural. Etiquetas en español solo en UI.
- PK `id uuid DEFAULT uuidv7()`.
- Columnas estándar: `company_id`, `created_at`, `updated_at` (trigger con `clock_timestamp()`), `created_by`, `updated_by`, y `deleted_at` en catálogos (soft delete).
- Dinero y cantidades: `numeric(18,4)`; tasas: `numeric(18,8)`; porcentajes: `numeric(7,4)`.
- Fechas de negocio: `date`; instantes: `timestamptz`.
- Enums como `text` + `CHECK` (más fácil de migrar que enums nativos).
- Cada tabla sincronizable offline tiene `version int` (incrementa en cada update) y `deleted_at`.

### 6.2 Núcleo y seguridad

| Tabla | Descripción |
|---|---|
| `companies` | RIF, razón social, domicilio fiscal, moneda base/valoración, flags fiscales (ver 8.1), feature flags |
| `users`, `user_companies` | Usuarios y su pertenencia/roles por empresa |
| `roles`, `permissions`, `role_permissions` | RBAC |
| `refresh_tokens` | Hash, dispositivo, expiración, rotación |
| `devices` | Dispositivos registrados para offline (sección 10) |
| `audit_logs` | Quién, cuándo, entidad, acción, diff JSON |
| `document_sequences` | Correlativos por empresa + tipo + serie |
| `idempotency_keys` | Clave, hash del request, respuesta, expiración |
| `settings` | Parámetros por empresa |

### 6.3 Administración

| Entidad UI | Tabla | Campos clave |
|---|---|---|
| Depósitos (Almacenes) | `warehouses`, `warehouse_locations` | código, nombre, `allow_negative_stock`; ubicaciones (pasillo/estante/bin) para repuestos |
| Instancias (Categorías) | `categories` | jerarquía `parent_id`, margen por defecto |
| Productos | `products` | `sku`, `name`, `category_id`, `unit_id`, `tax_id`, `tracking_mode` (`NONE`/`LOT`/`SERIAL`), `has_expiry`, `is_service`, `min_stock`, `max_stock` |
| — | `product_barcodes` | múltiples códigos de barras |
| — | `product_references` | códigos **OEM / equivalentes / alternos** (clave en repuestos) |
| — | `product_fitments` *(opcional)* | compatibilidad marca/modelo/año |
| — | `product_uoms` | presentaciones y factores (caja = 12 unidades) |
| — | `price_lists`, `product_prices` | listas (detal, mayor…) con moneda y vigencia |
| — | `product_suppliers` | código del proveedor, último costo |
| Proveedores | `suppliers` | RIF, tipo, contribuyente especial, retención IVA/ISLR, días de crédito |
| Zonas | `zones` | jerarquía |
| Vendedores | `sellers` | usuario, comisión, zona, meta |
| Clientes | `customers` | RIF/CI, tipo de persona, contribuyente especial, lista de precios, límite y días de crédito, vendedor, zona |
| Instrumentos de pago | `payment_methods` | tipo (`CASH`, `TRANSFER`, `MOBILE_PAYMENT`, `CARD`, `ZELLE`, `CHECK`…), moneda, `requires_reference`, `applies_igtf`, cuenta bancaria destino |
| Operaciones | `operation_types` | efectos sobre inventario/CxC/CxP/banco, serie, `requires_fiscal_number` |
| Unidades | `units` | |

### 6.4 Inventario (kardex inmutable)

```prisma
// Fragmento referencial de schema.prisma (ajustar a la versión de Prisma)
enum TrackingMode { NONE LOT SERIAL }

model Product {
  id            String       @id @default(dbgenerated("uuidv7()")) @db.Uuid
  companyId     String       @map("company_id") @db.Uuid
  sku           String
  name          String
  trackingMode  TrackingMode @default(NONE) @map("tracking_mode")
  hasExpiry     Boolean      @default(false)  @map("has_expiry")
  isService     Boolean      @default(false)  @map("is_service")
  // …
  @@unique([companyId, sku])
  @@unique([companyId, id])           // destino de FKs compuestas
  @@map("products")
}
// SQL manual: CHECK (NOT has_expiry OR tracking_mode = 'LOT')
```

| Tabla | Descripción |
|---|---|
| `inventory_movements` | **Kardex**: `product_id, warehouse_id, lot_id?, quantity (±), unit_cost, total_cost, avg_cost_after, balance_after, doc_type, doc_id, doc_line_id, reversal_of?, posted_at`. **Sin UPDATE ni DELETE** (trigger que lo impide) |
| `inventory_stock` | Saldo por `(product_id, warehouse_id)`: `quantity, reserved_qty` |
| `product_costs` | Costo promedio por `(company_id, product_id)`: `avg_cost`, moneda de valoración |
| `inventory_lot_balances` | Solo para productos con lotes: saldo por `(product_id, warehouse_id, lot_id)` |
| `lots` | `product_id, lot_no, expiry_date?, manufactured_at?, supplier_id?, status` |
| `product_serials` | `product_id, serial_no, lot_id?, warehouse_id, status (IN_STOCK/SOLD/RETURNED/SCRAPPED), last_doc` |
| `inventory_documents` / `_lines` | Traslados, cargos, descargos, ajustes |
| `stock_levels` | min / max / punto de reposición por producto y depósito |
| `movement_reasons` | Motivos para cargos/descargos/ajustes |

**Invariantes (verificados por job nocturno):**

- `inventory_stock.quantity = Σ inventory_movements.quantity` por producto/depósito.
- Para productos con lotes: `Σ inventory_lot_balances = inventory_stock`.
- Para seriales: `COUNT(product_serials IN_STOCK) = inventory_stock.quantity`.

### 6.5 Precios, impuestos, monedas

| Tabla | Descripción |
|---|---|
| `currencies` | ISO, símbolo, decimales (VES, USD, EUR) |
| `exchange_rates` | `currency_id, rate (Bs por unidad), date, source (BCV/MANUAL)` — historial inmutable |
| `taxes` | IVA general/reducida/adicional, exento, exonerado, IGTF… con vigencia |
| `tax_adjustments` / `_lines` | Cambios masivos de impuesto por producto/instancia, con fecha de vigencia |
| `price_adjustments` / `_lines` | Ajuste **manual** de precios (documento con motivo) |
| `price_rules`, `price_rule_runs` | Ajuste **automático** (regla, alcance, % o margen, redondeo, vigencia) |
| `price_history` | Todo cambio de precio |

### 6.6 Compras, ventas, CxC/CxP, bancos

| Grupo | Tablas |
|---|---|
| Compras | `purchase_documents`, `purchase_document_lines` |
| Ventas | `sales_documents`, `sales_document_lines`, `sales_fiscal_data`, `sales_document_payments` |
| Caja | `cash_registers`, `cash_sessions`, `cash_closings` |
| CxC | `receivable_entries`, `receipts`, `receipt_allocations` |
| CxP | `payable_entries`, `payments`, `payment_allocations` |
| Anticipos | `advance_payments` (clientes y proveedores) |
| Retenciones | `withholding_vouchers` (tipo IVA/ISLR, dirección emitida/recibida, número de comprobante, período, base, %, monto) |
| Libros fiscales | `tax_book_entries` (libro de ventas/compras, **generado al confirmar**) |
| Bancos | `banks`, `bank_accounts`, `beneficiaries`, `bank_operation_types`, `bank_transactions`, `bank_statement_lines`, `bank_reconciliations` (+ líneas) |
| Soporte | `document_links`, `document_cancellations`, `report_runs` |

### 6.7 Sincronización offline

| Tabla | Descripción |
|---|---|
| `devices` | `id, user_id, company_id, name, platform, last_seen_at, revoked_at, number_range?` |
| `sync_operations` | Registro de cada operación recibida: `client_op_id (UNIQUE), device_id, client_seq, entity, payload, status (APPLIED/DUPLICATE/REJECTED/NEEDS_REVIEW), error_code, applied_at` |
| `sync_conflicts` | Casos que requieren revisión humana (stock insuficiente, precio cambiado, cliente duplicado…) |

---

## 7. Reglas de negocio transversales

### 7.1 Dinero, moneda y factor cambiario

- Cada empresa define: **moneda base fiscal = VES (Bs)**, **moneda de valoración del inventario** (recomendado USD) y monedas permitidas.
- `exchange_rates` guarda la **tasa BCV** por fecha. Toda operación usa la tasa vigente a su fecha y **la congela** en el documento.
- Cada documento guarda: `currency_id`, `exchange_rate`, importes en **moneda del documento** y en **Bs** (los documentos fiscales se expresan siempre en Bs con la tasa del día).
- Los precios pueden definirse en USD y convertirse a Bs al momento de la operación.
- Revalorización de saldos CxC/CxP/bancos en divisas: proceso explícito que genera **diferencial cambiario**.
- Fuente de tasas: carga manual + job de sincronización (con fallback manual si la fuente falla). Ningún dato de tasa se sobrescribe; se agrega una nueva fila.

### 7.2 Costeo e inventario (especificación completa; incluye reglas de concurrencia)

Reemplaza las secciones 7.2 y 7.3 de la v2.

#### 7.2.1 Estado y definiciones

Por `(company_id, product_id)` en `product_costs`:

- `Q` = existencia total (suma de `inventory_stock.quantity` de todos los depósitos).
- `C` = costo promedio vigente, en la **moneda de valoración** de la empresa.

Precisión: `unit_cost` y `avg_cost` en `numeric(18,6)`; `total_cost` en `numeric(18,4)`. Redondeo **half-up** al calcular `total_cost = round(qty × unit_cost, 4)`. El promedio no se redondea más allá de 6 decimales.

Cada fila de `inventory_movements` guarda: `seq` (secuencia de contabilización por empresa), `qty`, `unit_cost`, `total_cost`, `Q_after`, `avg_cost_after`, `doc_type/doc_id/doc_line_id`, `reversal_of`.

#### 7.2.2 Reglas por tipo de movimiento

Sea `q > 0` la cantidad del movimiento y `c` su costo unitario de entrada.

| Movimiento | Costo del movimiento | Efecto sobre `C` y `Q` |
|---|---|---|
| **Compra / recepción** (entrada) | `c` = costo de la línea convertido a moneda de valoración con la tasa del documento | `C' = (Q·C + q·c) / (Q + q)` si `Q > 0`; si `Q ≤ 0`, `C' = c`. `Q' = Q + q` |
| **Cargo** (entrada manual) | `c` = costo indicado en el cargo (obligatorio) | Igual que compra |
| **Venta / Descargo** (salida) | `C` vigente | `C' = C`. `Q' = Q − q` |
| **Ajuste negativo** | `C` vigente | `C' = C` |
| **Ajuste positivo** | `C` vigente | `C' = C` (no altera el promedio) |
| **Traslado** (salida + entrada) | `C` vigente en ambas patas | `C' = C`. `Q` global no cambia. No toca `product_costs`, solo `inventory_stock` |
| **Devolución de venta / nota de crédito** (entrada) | **Costo de la salida original** (se obtiene vía `document_links` → movimiento origen) | Se trata como entrada con `c = costo original`: `C' = (Q·C + q·c)/(Q + q)` |
| **Devolución de compra / anulación de compra** (salida) | **Costo de la entrada original** `c0` | Si `Q − q > 0`: `C' = (Q·C − q·c0)/(Q − q)`; si el resultado es `< 0` o `Q − q ≤ 0`, `C' = C`. `Q' = Q − q` |
| **Anulación de venta** | Costo de la salida original | Igual que devolución de venta |

Consecuencias de diseño:

- **Anular nunca modifica el pasado:** genera un movimiento nuevo (con `reversal_of`) en el instante actual y a su costo original. No se recalculan movimientos posteriores.
- **Stock negativo permitido** (`allow_negative_stock = true`): las salidas se valoran a `C`; `C` no cambia. Cuando entra mercancía con `Q ≤ 0`, el promedio se reinicia en `c` (los faltantes ya se vendieron al costo anterior).
- **Servicios** (`is_service = true`): no generan movimientos.
- **Productos sin costo** (`C` desconocido, nunca comprado): venta permitida solo si la empresa lo habilita; se valora a 0 y se marca `cost_pending = true` para corrección vía ajuste de costo.

#### 7.2.3 Corrección de costos (único mecanismo)

Documento `COST_ADJUSTMENT` (tipo de `inventory_documents`): ajusta `C` de un producto por un motivo y con aprobación. Genera un movimiento de **valor** (`qty = 0`, `total_cost = (C' − C)·Q`) para que el valorizado del kardex cuadre. Es el único modo de cambiar el costo sin una entrada.

#### 7.2.4 Fechas y períodos

- La fecha del movimiento de inventario es **siempre el instante de confirmación** (`posted_at`). Los documentos de inventario no aceptan fecha anterior.
- Los documentos comerciales (factura, compra) tienen `document_date`, que puede ser anterior solo dentro del **período fiscal abierto**; su efecto en inventario sigue ocurriendo en `posted_at`.
- **Período de inventario:** mensual. Al cerrarlo se congelan: saldo, costo y valor por producto (`inventory_period_snapshots`). Un cierre solo puede revertirlo un rol autorizado y **si no existe un período posterior cerrado**.
- Reportes valorizados **históricos** se calculan desde `inventory_period_snapshots` + kardex posterior (no desde `product_costs` actual).

#### 7.2.5 Concurrencia y orden de bloqueo

Al contabilizar un documento, **dentro de una sola transacción**:

1. Reunir el conjunto de `(product_id, warehouse_id)` de todas las líneas.
2. Bloquear `product_costs` de esos productos, **ordenados por `product_id`**: `SELECT … FOR UPDATE`.
3. Bloquear `inventory_stock` de esos pares, **ordenados por `product_id, warehouse_id`**.
4. Si hay lotes/seriales, bloquear después `inventory_lot_balances` / `product_serials` en el mismo orden.
5. Calcular y escribir movimientos.

Orden fijo **costos → stock → lotes/seriales** y siempre ascendente por id → sin interbloqueos entre documentos. Reintento automático ante `40001` (serialization) y `40P01` (deadlock), máximo 3 veces con *backoff*.

Numeración: la fila de `document_sequences` se bloquea **al final** de la transacción (después de validar todo), para mantener el bloqueo el menor tiempo posible. Se acepta que un rollback no consuma número (la numeración se asigna dentro de la misma transacción, por lo que no hay huecos).

#### 7.2.6 Invariantes (job nocturno y pruebas)

- `inventory_stock.quantity = Σ inventory_movements.qty` por `(product, warehouse)`.
- `product_costs.avg_cost = avg_cost_after` del último movimiento del producto.
- `Σ qty·unit_cost` del kardex hasta una fecha = valorizado del reporte a esa fecha (tolerancia por redondeo ≤ 0,01 por movimiento).
- Lotes: `Σ inventory_lot_balances = inventory_stock`. Seriales: `COUNT(IN_STOCK) = inventory_stock.quantity`.

#### 7.2.7 Casos de prueba obligatorios de costeo

1. Compra 10 @ 5, compra 10 @ 7 → `C = 6`.
2. Venta de 5 → `C` sigue 6; valorizado = 15 × 6.
3. Devolución de compra de la segunda compra (10 @ 7, con `Q = 15`) → `C = (15·6 − 10·7)/5 = 4`; verifica que no sea negativo.
4. Devolución de venta reingresa al costo original, no al `C` actual.
5. Stock negativo: vender 3 con `Q = 1`, luego comprar 10 @ 8 → `C = 8`.
6. Traslado no cambia `C`.
7. Dos facturas concurrentes del mismo producto en depósitos distintos: promedio consistente, sin deadlock.
8. Anular una compra de hace 2 meses no altera movimientos posteriores y respeta el período cerrado.

---


### 7.4 Precios

- Varias listas de precio por producto (detal, mayor, distribuidor…) con moneda y vigencia.
- **Ajuste manual:** documento con líneas, motivo y usuario; genera `price_history`.
- **Ajuste automático:** reglas por instancia/proveedor/producto (`% sobre costo`, `margen`, `% sobre precio`, redondeo a 0,05 / 0,10 / 1), ejecutadas por job o al confirmar una compra con costo nuevo. Cada ejecución queda en `price_rule_runs`.

### 7.5 Numeración

- `document_sequences` por `(company_id, tipo, serie)`.
- El número se asigna **al confirmar** (no en borrador), con bloqueo de fila → sin huecos ni duplicados.
- Prefijos configurables (`OC-`, `PED-`, `PRE-`, etc.).
- **Facturas, notas de crédito y débito:** número correlativo + **número de control** (ver sección 8.4). Un documento fiscal **no puede crearse offline** (sección 10).

### 7.6 CxC / CxP

- Facturas/compras a crédito generan `receivable_entries` / `payable_entries` con vencimiento (`fecha + días de crédito`).
- Cobros/pagos se aplican a uno o varios documentos (`*_allocations`): parciales, anticipos, notas de crédito/débito, **retenciones**.
- Análisis de vencimiento: *Por vencer · 1–30 · 31–60 · 61–90 · +90*.

### 7.7 Bancos y conciliación

- Cobros/pagos por instrumentos bancarios (transferencia, pago móvil, punto de venta, Zelle…) generan `bank_transactions`.
- Conciliación: importación de extracto (CSV) + emparejamiento manual/automático por referencia, monto y fecha → cierre del período.
- Bancos venezolanos con **código de 4 dígitos** (semilla en `banks`).

### 7.8 Auditoría y borrado

- `audit_logs` para toda escritura relevante (anulaciones, cambios de precio, ajustes, permisos).
- Catálogos: **soft delete**. Documentos confirmados: **nunca se borran, se anulan**.

---

## 8. Normativa fiscal Venezuela

> ⚠️ **Importante:** esta sección es una guía técnica de modelado. Las alícuotas, porcentajes, formatos y providencias **deben ser validados por un contador público / asesor tributario** antes de salir a producción, y mantenerse **parametrizables con fecha de vigencia** (la normativa cambia con frecuencia). Los números de providencia citados son referencias a verificar.

### 8.1 Datos fiscales por empresa, cliente y proveedor

| Entidad | Campos |
|---|---|
| `companies` | RIF, razón social, domicilio fiscal, **`is_special_taxpayer`** (contribuyente especial), **`is_vat_withholding_agent`**, **`is_igtf_collector`**, régimen, datos de imprenta/proveedor de facturación |
| `customers` / `suppliers` | RIF (formato `J-12345678-9`; prefijos V, E, J, G, P, C), tipo de persona, **contribuyente especial**, % retención IVA (75 % / 100 %), exento/exonerado, sujeto a ISLR |

Validar formato de RIF en `packages/contracts`.

### 8.2 Impuestos (`taxes`, con vigencia)

| Impuesto | Valor de referencia (verificar vigencia) |
|---|---|
| IVA alícuota general | 16 % |
| IVA alícuota reducida | 8 % |
| IVA alícuota adicional (bienes suntuarios) | 15 % adicional a la general (se refleja como dos líneas de impuesto) |
| Exento / Exonerado / No sujeto | 0 %, se reportan en columnas distintas del libro |
| **IGTF** (Impuesto a las Grandes Transacciones Financieras) | 3 % sobre **pagos efectuados en divisas** (se calcula sobre el pago, no sobre la línea del documento) |

- Cada línea de documento **congela** el impuesto y la alícuota aplicados.
- `tax_adjustments` permite cambiar alícuotas con fecha de vigencia sin tocar documentos pasados.
- **IGTF:** `payment_methods.applies_igtf` + `companies.is_igtf_collector` → al registrar un pago en divisas se calcula y se muestra como línea separada del documento/recibo.

### 8.3 Retenciones

| Retención | Dirección | Modelado |
|---|---|---|
| **IVA** (por lo general 75 % o 100 % del IVA) | Emitida (cuando la empresa es agente de retención y compra) / Recibida (cuando un cliente retiene a la empresa) | `withholding_vouchers` + reduce CxP/CxC |
| **ISLR** (Decreto 1.808 y conceptos) | Emitida / Recibida | `islr_concepts` (código, descripción, tipo de persona, %, base mínima, sustraendo) + `tax_unit_values` (UT con vigencia) |

- **Comprobante de retención de IVA:** número con formato `AAAAMMNNNNNNNN` (año + mes + correlativo de 8 dígitos) — validar con providencia vigente.
- Al **pagar** una compra a proveedor sujeto a retención: se genera el comprobante y el pago se reduce por el monto retenido.
- Al **cobrar** a cliente que retiene: el cobro admite el instrumento *"Retención de IVA / ISLR"* con número de comprobante, y reduce la CxC.
- Reportes: *relación de retenciones por quincena/mes* y archivos de declaración (TXT para IVA, XML para ISLR) en una fase posterior.

### 8.4 Facturación (requisitos de diseño)

Datos mínimos que debe poder almacenar e imprimir una factura (validar con la providencia de facturación vigente):

- Denominación **"FACTURA"**, **número correlativo** y **número de control**.
- Fecha de emisión; razón social, **RIF** y domicilio fiscal del emisor; datos del adquirente (nombre/razón social, RIF o C.I., domicilio).
- Descripción, cantidad, precio unitario, valor de cada operación.
- **Base imponible por alícuota**, alícuota y monto del IVA; monto exento/exonerado; total.
- Si la operación es en divisas: **monto en Bs al tipo de cambio BCV** de la fecha y la tasa usada; línea de **IGTF** cuando aplique.
- Datos de la imprenta autorizada (si usa formas libres / imprenta digital).
- **Notas de crédito y débito:** deben referenciar la factura afectada (número, fecha, control).
- **Facturas anuladas:** conservan su número y aparecen en el libro como anuladas.

**Abstracción del proveedor de numeración/control** (decisión pendiente, ver sección 20):

```ts
interface FiscalProvider {
  allocateNumbers(doc): Promise<{ invoiceNo: string; controlNo: string }>;
  render(doc): Promise<Buffer>;            // PDF / formato imprenta digital
  void(doc, reason): Promise<void>;
}
// Implementaciones: ManualRangeProvider (talonarios/rangos),
// DigitalPrinterProvider (API de imprenta digital), FiscalPrinterProvider (equipo fiscal)
```

### 8.5 Libros fiscales

Se alimentan de **`tax_book_entries`**, generadas al confirmar/anular cada documento (no se recalculan al consultar). Columnas típicas del **libro de ventas**:

> Fecha · RIF · Nombre/Razón social · Nº factura · Nº control · Nº nota de débito · Nº nota de crédito · **Tipo de transacción** (01 registro, 02 complemento, 03 anulación, 04 ajuste) · Nº factura afectada · Total ventas incl. IVA · Ventas exentas · Base imponible (general / reducida / adicional) · % alícuota · Impuesto IVA · **IVA retenido por el comprador** · Nº comprobante de retención · Fecha.

El **libro de compras** es análogo (con crédito fiscal e IVA retenido al proveedor). Soportar:

- Ventas a consumidor final **resumidas por día** (cuando aplique).
- Períodos mensuales con cierre (un período cerrado no admite nuevas entradas; los ajustes van al período abierto).
- Exportación PDF/Excel con la estructura exigida.

### 8.5.1 Instrumentos de pago locales

`CASH_VES`, `CASH_USD`, `TRANSFER`, `MOBILE_PAYMENT` (pago móvil: banco, teléfono, referencia), `CARD_POS` (punto de venta), `ZELLE`, `CHECK`, `WITHHOLDING` (retención), `CREDIT` (a crédito).

---

## 9. Lotes, seriales y vencimiento (opcional por producto)

**Objetivo:** que una empresa de repuestos que **no** los usa tenga cero fricción, y que otra que sí los necesite los active sin migraciones.

### 9.1 Activación en dos niveles

| Nivel | Control |
|---|---|
| Empresa | `companies.features = { lots: false, serials: false, expiry: false }` (desactivado por defecto) |
| Producto | `products.tracking_mode` (`NONE` / `LOT` / `SERIAL`) y `has_expiry` (solo con `LOT`) |

Si el flag de empresa está apagado, la UI **oculta** campos de lote/serie/vencimiento y la API los **rechaza** o ignora.

### 9.2 Comportamiento por modo

| Modo | Stock | Documentos |
|---|---|---|
| `NONE` (por defecto) | Solo `inventory_stock` | Líneas normales, sin selección extra |
| `LOT` | `inventory_stock` (total) + `inventory_lot_balances` (detalle) | Cada línea de entrada indica lote (y vencimiento); cada salida indica lote o se asigna automáticamente |
| `SERIAL` | `inventory_stock` + `product_serials` (1 fila por unidad) | Cada unidad lleva su serial; cantidad por línea = número de seriales |

### 9.3 Reglas

- **Asignación de salida (picking):** estrategia por empresa/producto: `FEFO` (primero en vencer, por defecto si hay vencimiento), `FIFO` o manual.
- **Vencimiento:** configurable si se **bloquea** o solo **advierte** la venta de lotes vencidos; alertas de próximos vencimientos (job diario, ventana configurable).
- **Seriales:** estados `IN_STOCK → SOLD → RETURNED / SCRAPPED`; un serial no puede venderse dos veces ni salir de un depósito donde no está.
- **Traslados:** mueven lote/serial entre depósitos.
- **Costeo:** el promedio sigue siendo **por producto** (decisión D3); el costo del lote se registra informativamente en `lots`/movimientos. Costo específico por lote/serial queda para una fase futura (`CostingStrategy`).
- **Trazabilidad:** consulta "¿a qué clientes se vendió el lote X / serial Y?" mediante `inventory_movements` + `document_links`.
- **Offline:** el catálogo offline incluye lotes/seriales **solo** de productos con tracking activo (indicativos); la asignación final se valida en el servidor.

### 9.3.1 Reglas de repuestos (ya incluidas aunque no usen lotes)

`product_references` (OEM/equivalentes) · múltiples códigos de barras · presentaciones/factores · ubicaciones en depósito · compatibilidad vehicular opcional.

---

## 10. Offline-first para vendedores

### 10.1 Principio y alcance

Los vendedores deben poder **tomar pedidos sin conexión**. Una **factura fiscal** requiere número correlativo y número de control, que **no pueden asignarse sin el servidor** (salvo que se usen rangos pre-asignados, ver 10.6). Por eso:

| Operación | Offline | Detalle |
|---|---|---|
| Consultar catálogo, precios, existencias *(indicativas)*, clientes | ✅ | Desde IndexedDB |
| Crear / editar **cotizaciones, presupuestos y pedidos** | ✅ | Número provisional local; número definitivo al sincronizar |
| Crear clientes nuevos | ✅ | Quedan "pendientes de validación" (RIF único, aprobación opcional) |
| Registrar **cobros** de clientes (anticipo/recibo) | ✅ (configurable) | Pendiente de conciliación |
| **Emitir factura / nota de crédito / débito** | ❌ por defecto | Se genera tras sincronizar (automática o por administración) |
| Confirmación de existencias reales | ❌ | El servidor valida al sincronizar |

**Modo A (por defecto):** offline = pedidos; facturación al sincronizar.
**Modo B (opcional):** facturación offline con **rangos de numeración asignados por dispositivo** (solo si el negocio emite con talonarios/formas pre-impresas). Ver 10.6.

### 10.2 Arquitectura cliente

```
UI (React) ─▶ Capa de repositorio local (Dexie)
                 ├─ Catálogos (productos, precios, clientes, impuestos, tasa, ...)
                 ├─ Documentos locales (borradores, pedidos)
                 └─ OUTBOX (cola de operaciones pendientes, con client_seq)
                          │
          Sync Engine ────┴──▶ POST /sync/push  ·  GET /sync/pull
          (arranque, evento 'online', cada N min, botón manual)
```

- **Service Worker (Serwist):** precache del *app shell* (JS/CSS/HTML), estrategia *stale-while-revalidate* para estáticos. **No** se cachean respuestas de `/api`; los datos viven en Dexie.
- Solicitar `navigator.storage.persist()` para evitar desalojo de IndexedDB.
- **Indicador de estado** permanente: En línea / Sin conexión / Sincronizando / N pendientes / N con conflicto.
- *Background Sync API* no es universal (iOS): la sincronización se dispara también al abrir la app y al detectar `online`.
- Recomendar **Android + Chrome** para los vendedores.

### 10.3 Contrato de sincronización

#### Pull (servidor → dispositivo)

```
GET /api/v1/sync/pull?cursor=<ts>&entities=products,prices,customers,taxes,exchange_rates,...
→ { cursor: "<nuevo>", changes: [ { entity, id, op: "upsert"|"delete", version, data } ], hasMore }
```

- Basado en `updated_at` (trigger con `clock_timestamp()`) y `deleted_at` (tombstones).
- El cliente solicita desde `cursor − 60 s` (solape) y aplica *upserts* idempotentes comparando `version`.
- **Primera carga** (bootstrap): por entidad y paginada; los clientes se filtran por vendedor/zona si así se configura.
- **Catálogo grande** (decenas de miles de repuestos): paginado de 1 000–2 000 filas; búsqueda local con índices Dexie (`sku`, `name` tokenizado, `references`, `barcode`).

#### Push (dispositivo → servidor)

```
POST /api/v1/sync/push
Headers: Authorization, X-Device-Id, Idempotency-Key (por lote)
Body: { schemaVersion, ops: [ { clientOpId, clientSeq, entity, action, data } ] }
→ { results: [ { clientOpId, status: "APPLIED"|"DUPLICATE"|"REJECTED"|"NEEDS_REVIEW",
                  serverId?, serverNumber?, errorCode?, message? } ] }
```

- Las operaciones se procesan **en orden de `clientSeq`** por dispositivo.
- **Idempotencia:** `clientOpId` único en `sync_operations`; reintentar nunca duplica.
- **El ID del documento lo genera el cliente (UUIDv7)** y es el PK en el servidor → relaciones padre/hijo seguras sin remapeo.
- Cada operación se procesa en su **propia transacción**: una falla no tumba el lote.

### 10.4 Resolución de conflictos

| Situación | Política |
|---|---|
| Stock insuficiente al sincronizar un pedido | El pedido se **acepta** (no reserva) y se marca advertencia; el administrador decide (parcial, esperar, anular) |
| Precio cambió desde la descarga | Configurable: **respetar precio pactado** (por defecto) o **revalidar** y marcar `NEEDS_REVIEW` |
| Cliente nuevo con RIF ya existente | Se **vincula** al existente y se notifica |
| Producto desactivado/eliminado | `REJECTED` con código; el vendedor ve el motivo |
| Documento ya modificado en servidor | El servidor **gana**; el cambio local pasa a `sync_conflicts` |
| Dispositivo revocado / usuario inactivo | Operaciones en cuarentena (`NEEDS_REVIEW`) hasta que un administrador las revise |
| Totales distintos | Servidor recalcula con `packages/domain`; se guarda la diferencia como metadato |

La UI de conflictos (bandeja *Sincronización → Pendientes de revisión*) permite aprobar, corregir o descartar.

### 10.5 Autenticación y seguridad offline

- **Registro de dispositivo** (`devices`): primer login en línea; un administrador puede **revocar** dispositivos.
- Refresh token de dispositivo de larga duración (p. ej. 30 días) con rotación al reconectar.
- **Bloqueo local** con PIN o WebAuthn para abrir la app sin conexión.
- Datos sensibles en IndexedDB: guardar el mínimo necesario (no costos, no datos de otros vendedores); opción de **borrado remoto** al revocar dispositivo (se ejecuta en la próxima conexión) y cierre automático tras N días sin sincronizar.
- Cada operación en el *outbox* queda atada a `user_id` y `device_id`.

### 10.6 Modo B: facturación offline con rangos pre-asignados (opcional)

- `devices.number_range = { series, from, to, next }` asignado por el administrador.
- Solo aplica si el emisor usa **formas pre-impresas con numeración y control propios**; no es posible con numeración centralizada.
- Al sincronizar, el servidor valida que los números caigan en el rango del dispositivo y no estén usados.
- Requiere validación explícita del contador antes de habilitarse.

### 10.7 Compatibilidad de versiones

- Los clientes offline pueden tardar días en sincronizar con una versión vieja de la app.
- `schemaVersion` en cada push; el servidor mantiene compatibilidad **N−1** como mínimo.
- Migraciones de BD con patrón **expandir → migrar → contraer**.
- *Prompt* de actualización del Service Worker (sin forzar recarga si hay *outbox* pendiente).
- Migraciones de Dexie versionadas.

### 10.8 Criterios de aceptación offline

- [ ] Con el modo avión, un vendedor crea 20 pedidos y los ve en su lista local.
- [ ] Al reconectar, los 20 se sincronizan una sola vez (aunque se reintente el push).
- [ ] Un corte de conexión a mitad del push no duplica ni pierde pedidos.
- [ ] Un pedido con producto sin stock se sincroniza con advertencia, sin bloquear el lote.
- [ ] Un dispositivo revocado no puede sincronizar.
- [ ] El catálogo de 50 000 productos se busca localmente en < 200 ms.
- [ ] Totales de cliente y servidor coinciden (mismo `packages/domain`).

---

## 11. API: convenciones y catálogo de endpoints

### 11.1 Convenciones

- **Base:** `/api/v1` (mismo dominio que la web). JSON `camelCase`.
- **Recursos** en plural y en inglés.
- **Verbos:** `GET` listar/detalle · `POST` crear y acciones · `PATCH` actualizar · `DELETE` baja lógica.
- **Paginación:** `?page=1&limit=20` (máx. 100); por cursor en kardex y movimientos.
- **Orden/filtros:** `?sort=-createdAt` · `?filter[status]=CONFIRMED&filter[dateFrom]=…` · `?search=…`
- **Respuesta:** `{ data, meta: { page, limit, total, totalPages } }`
- **Error:**

```json
{ "statusCode": 422, "error": "BUSINESS_RULE_VIOLATION",
  "message": "Stock insuficiente", "details": [{ "field": "lines[0].quantity", "code": "INSUFFICIENT_STOCK" }],
  "requestId": "…" }
```

- **Cabeceras:** `Authorization`, `Idempotency-Key`, `X-Request-Id`, `X-Device-Id`.
- **Estados de documento:** `DRAFT → CONFIRMED → (PARTIALLY_)FULFILLED → CLOSED`, y `CANCELLED/VOIDED` con motivo.

### 11.2 Catálogo (prefijo `/api/v1`)

CRUD estándar = `GET /`, `GET /:id`, `POST /`, `PATCH /:id`, `DELETE /:id`, `POST /:id/restore`.

| Módulo | Rutas |
|---|---|
| **Auth** | `POST /auth/login`, `/auth/select-company`, `/auth/refresh`, `/auth/logout`; `GET /auth/me`; `POST /auth/change-password` |
| **Empresas y usuarios** | `/companies` (+ `/companies/:id/settings`, `/features`), `/users`, `/roles`, `/permissions`, `/devices` (+ `POST /:id/revoke`) |
| **Administración** | `/warehouses`, `/categories`, `/products` (+ `/:id/stock`, `/:id/kardex`, `/:id/price-history`, `/:id/references`, `/:id/lots`, `/:id/serials`), `/suppliers`, `/zones`, `/sellers`, `/customers` (+ `/:id/statement`), `/payment-methods`, `/operation-types`, `/units`, `/price-lists` |
| **Inventario** | `GET /inventory/stock`, `/inventory/kardex`, `/inventory/lots`, `/inventory/serials`; documentos `/inventory/transfers`, `/charges`, `/discharges`, `/adjustments` (cada uno con `POST /:id/confirm`, `/:id/void`; ajustes con `GET /:id/count-sheet`); `/inventory/stock-levels` (+ `POST /calculate`), `GET /inventory/replenishment-suggestions` |
| **Precios e impuestos** | `/pricing/manual-adjustments` (`POST /:id/apply`), `/pricing/rules` (`POST /:id/run`, `GET /:id/runs`), `/taxes`, `/taxes/adjustments` (`POST /:id/apply`) |
| **Monedas** | `/currencies`, `/exchange-rates` (+ `/latest`, `POST /sync`) |
| **Compras** | `/purchases/quotes`, `/orders`, `/delivery-notes`, `/delivery-note-returns`, `/` (compras), `/returns`; acciones: `/:id/confirm`, `/:id/cancel`, `/:id/convert-to-order`, `/:id/receive`, `/:id/convert-to-purchase` |
| **Ventas** | `/sales/quotes`, `/budgets`, `/orders`, `/order-returns`, `/invoices`, `/credit-notes`, `/debit-notes`; acciones: `/:id/confirm`, `/:id/cancel`, `/:id/void`, `/:id/convert-to-*`, `/:id/invoice`; `GET /invoices/:id/pdf`; `/sales/cash-sessions` (`POST /open`, `POST /:id/close`, `GET /:id/summary`) |
| **CxC / CxP** | `/receivables`, `/receivables/receipts`, `/payables`, `/payables/payments`, `/advances`, `/withholdings` (+ `POST /:id/issue`) |
| **Bancos** | `/banking/banks`, `/accounts` (+ `/:id/balance`), `/beneficiaries`, `/operation-types`, `/transactions` (+ `POST /:id/reverse`), `/reconciliations` (`POST /start`, `/:id/import-statement`, `/:id/match`, `/:id/close`) |
| **Fiscal** | `/fiscal/books/sales`, `/fiscal/books/purchases`, `POST /fiscal/periods/:id/close`, `/fiscal/withholding-vouchers` |
| **Sincronización** | `GET /sync/pull`, `POST /sync/push`, `GET /sync/conflicts`, `POST /sync/conflicts/:id/resolve` |
| **Reportes** | `GET /reports/{categoria}/{reporte}`, `POST /reports/jobs`, `GET /reports/jobs/:id` |
| **Sistema** | `GET /health`, `/health/ready`, `/audit-logs` |

### 11.3 Ejemplo: crear pedido (idéntico online/offline)

```json
POST /api/v1/sales/orders
Idempotency-Key: 0194b3a2-…
{
  "id": "0194b3a2-7c1e-7d3a-9a44-1f2c9b5a0e11",
  "customerId": "…", "sellerId": "…", "warehouseId": "…",
  "currencyId": "0194b3a2-…", "exchangeRate": 36.5200,
  "paymentCondition": "CREDIT", "creditDays": 15,
  "lines": [ { "productId": "…", "quantity": 3, "unitPrice": 12.50, "discountPct": 5, "taxId": "0194b3a2-…" } ],
  "clientMeta": { "deviceId": "…", "localNumber": "OFF-D01-000123", "createdAt": "2026-10-09T14:03:00-04:00" }
}
```

---

## 12. Seguridad

### 12.1 JWT

| Token | Duración | Detalle |
|---|---|---|
| Access | 15 min | Claims: `sub`, `companyId`, `roles`, `permHash`, `jti` |
| Refresh | 7 días (web) / 30 días (dispositivo registrado) | Rotativo, guardado **hasheado**, detección de reutilización |
| Revocación | `jti` en lista de bloqueo (Redis) hasta expirar | |

- Contraseñas con **argon2id**. Bloqueo temporal tras intentos fallidos.
- Web: refresh en **cookie `httpOnly; Secure; SameSite=Lax`** vía *route handlers* de Next (BFF ligero); access en memoria.

### 12.2 Autorización (RBAC)

- Permisos `modulo:recurso:accion` (`sales:invoices:create`, `inventory:adjustments:approve`).
- `@RequirePermissions()` + `PermissionsGuard`; permisos cacheados en Redis y versionados por `permHash`.
- Roles iniciales: **ADMIN, GERENTE, VENDEDOR, ALMACENISTA, CAJERO, CONTADOR, COMPRAS**.
- Reglas por registro: el VENDEDOR solo ve **sus** clientes/pedidos (según zona/asignación).

### 12.3 Protección

- `helmet`, rate limiting (`@nestjs/throttler` con Redis), validación Zod estricta (rechaza campos desconocidos).
- Auditoría de acciones críticas; correlación por `requestId`.
- Secretos en archivos `EnvironmentFile` con permisos `600` (nunca en el repositorio).
- **2FA TOTP** para ADMIN/CONTADOR (fase posterior).
- Dependencias: `pnpm audit` en CI y Renovate/Dependabot.

---

## 13. Reportes

### 13.1 Implementación

- Endpoint común: `GET /reports/{categoria}/{reporte}?format=json|pdf|xlsx|csv&…filtros`.
- **Ligeros** (< ~5 000 filas): síncronos. **Pesados**: `POST /reports/jobs` → BullMQ → descarga con URL firmada y TTL de 24 h.
- Consultas con **SQL optimizado / vistas**; vistas materializadas solo para consolidados y estadísticas (refresco nocturno).
- Concurrencia de reportes pesados limitada a **1–2** a la vez (por RAM del VPS).
- Filtros comunes: fechas, depósito, instancia, proveedor, cliente, vendedor, zona, moneda (documento / Bs / valoración).
- Cada exportación queda en `report_runs`.
- PDF con **pdfmake**; Excel con **ExcelJS en modo streaming**.

### 13.2 Catálogo

| Categoría | Reportes (ruta bajo `/reports/<categoría>/`) |
|---|---|
| **Proveedores** `suppliers` | `list`, `analysis`, `statistics`, `statement`, `payables`, `aging`, `payments`, `pending-transactions`, `product-purchases` |
| **Instancias** `categories` | `inventory`, `inventory-consolidated`, `inventory-statistics` |
| **Inventario** `inventory` | `products`, `replenishment`, `purchase-sales-analysis`, `price-list`, `physical-count`, `product-analysis`, `lots-expiry`*, `serials`* |
| **Vendedores** `sellers` | `list`, `commissions`, `effectiveness`, `last-sale-by-customer`, `sales-by-category`, `product-sales`, `statistics` |
| **Clientes** `customers` | `list`, `analysis`, `statistics`, `statement`, `receivables`, `aging`, `collections`, `receipts-advances`, `tax-withholdings`, `product-sales` |
| **Ventas** `sales` | `transactions`, `daily-closing`, `summary`, `cash-closing`, `processed-transactions`, `credit-sales`, `by-category` |
| **Compras** `purchases` | `list`, `by-category` |
| **Impuestos** `taxes` | `vat-collected`, `sales-book`, `vat-paid`, `purchase-book`, `vat-withholding`, `islr-withholding`, `igtf` |

\* Solo visibles si la empresa activó lotes/seriales.

> **Libros de ventas/compras y retenciones:** salen de `tax_book_entries` y `withholding_vouchers`, no se recalculan desde los documentos.

---

## 14. Frontend

### 14.1 Menú (sidebar de TailAdmin adaptado)

```
Dashboard
Administración   Depósitos · Instancias · Productos · Proveedores · Zonas · Vendedores
                 Clientes · Instrumentos de pago · Operaciones
Transacciones    CxC · CxP · Traslados · Cargos · Descargos · Ajustes de inventario
                 Mínimo y máximo · Ajuste de precios (manual/automático)
                 Ajuste de impuestos · Factor cambiario
Compras          Cotizaciones · Órdenes · Anulación de órdenes · Compras · Devoluciones
                 Notas de entrega · Devolución de notas de entrega
Ventas           Cotizaciones · Presupuestos · Anulación de presupuestos · Pedidos
                 Devolución de pedidos · Facturas · Notas de crédito/débito · Caja
Bancos           Monedas · Cuentas · Bancos · Beneficiarios · Operaciones
                 Transacciones · CxC · CxP · Conciliaciones
Fiscal           Libro de ventas · Libro de compras · Retenciones · Períodos
Reportes         (según sección 13)
Sincronización   Dispositivos · Pendientes de revisión
Configuración    Empresa · Usuarios · Roles · Secuencias · Impuestos · Parámetros fiscales
```

El menú se **filtra por permisos y feature flags** (p. ej., lotes/seriales).

### 14.2 Componentes reutilizables (construir una sola vez)

| Componente | Uso |
|---|---|
| `DataTable` | Tabla server-side (paginación, orden, filtros, exportación) sobre TanStack Table |
| `CrudPage` / `CrudForm` | Generador genérico para catálogos (basado en esquemas Zod) |
| `DocumentEditor` | Cabecera + grid de líneas + totales en vivo con `packages/domain`; **funciona online y offline** |
| `ProductPicker` | Búsqueda por SKU, nombre, OEM/equivalente, código de barras; usa Dexie offline |
| `EntitySelect` | Select asíncrono (clientes, proveedores…) |
| `MoneyInput` / `QtyInput` | Decimales controlados, formato es-VE |
| `LotSerialPicker` | Solo aparece si el producto tiene tracking |
| `StatusBadge` / `DocumentTimeline` | Estado y trazabilidad (`document_links`) |
| `SyncStatusBar` | Estado de conexión y cola offline |
| `ReportViewer` | Filtros → vista previa → PDF/Excel |
| `PermissionGate`, `ConfirmDialog` | Permisos y confirmaciones (anulación con motivo) |

### 14.3 Notas

- TailAdmin Free aporta layout/estilos; **no** incluye componentes complejos → los de arriba se construyen o se complementan con librerías.
- Teclado: atajos en el editor de documentos; lector de código de barras como entrada de teclado.
- Pantalla de vendedor móvil: priorizar **táctil**, búsqueda rápida y modo offline visible.
- Pantalla de caja/mostrador: optimizada para rapidez.
- Formato regional: `es-VE`, separador decimal coma, moneda Bs / USD visible en documentos.

---

## 15. Procesos en segundo plano

Ejecutados **dentro del proceso de la API** (`WORKER_ENABLED=true`), con BullMQ sobre Redis.

| Cola | Job | Disparador |
|---|---|---|
| `reports` | Reportes pesados (concurrencia 1–2) | Usuario |
| `inventory` | Cálculo de mínimo/máximo; verificación de invariantes del kardex | Cron nocturno / manual |
| `inventory` | Alertas de vencimiento (solo empresas con vencimiento) | Cron diario |
| `pricing` | Ejecución de reglas de precio automático | Cron / evento de compra |
| `fx` | Sincronización de tasa BCV (con fallback manual y alerta) | Cron (varias veces al día) |
| `receivables` | Marcar vencidos, recordatorios | Cron diario |
| `banking` | Procesar extractos importados | Usuario |
| `sync` | Reprocesar operaciones `NEEDS_REVIEW` aprobadas | Evento |
| `maintenance` | Limpiar reportes temporales, tokens vencidos, `idempotency_keys`, refrescar vistas materializadas | Cron |
| `backup` | `pg_dump` + copia externa (alternativa: `systemd timer` en el host) | Cron 02:00 |

**Cálculo de mínimo y máximo:**

```
consumo_diario    = ventas_últimos_N_días / N
stock_seguridad   = consumo_diario × días_seguridad
mínimo            = consumo_diario × lead_time_proveedor + stock_seguridad
máximo            = mínimo + consumo_diario × días_cobertura
sugerido_reponer  = máximo − (stock_actual + pedido_en_tránsito)
```

Parámetros por instancia/producto (N, seguridad, cobertura).

---

## 16. Infraestructura y despliegue en el VPS

### 16.1 Preparación del servidor (una sola vez)

```bash
# 1. Usuario sin privilegios para ejecutar contenedores
sudo adduser --disabled-password erp
sudo loginctl enable-linger erp                  # permite servicios de usuario sin sesión

# 2. Swap de 2 GB
sudo fallocate -l 2G /swapfile && sudo chmod 600 /swapfile
sudo mkswap /swapfile && sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
echo 'vm.swappiness=10' | sudo tee /etc/sysctl.d/90-erp.conf

# 3. Límite de journald
sudo sed -i 's/^#\?SystemMaxUse=.*/SystemMaxUse=500M/' /etc/systemd/journald.conf

# 4. Caddy en el host
sudo apt install -y caddy

# 5. Base de datos (PostgreSQL 18 ya instalado)
sudo -u postgres psql -c "CREATE ROLE erp LOGIN PASSWORD '***';"
sudo -u postgres createdb -O erp erp
sudo -u postgres psql -d erp -c "CREATE EXTENSION IF NOT EXISTS pg_stat_statements; CREATE EXTENSION IF NOT EXISTS pgcrypto;"
```

### 16.2 Red y cortafuegos

- Público: **solo 80/443** (Caddy).
- **SSH, PostgreSQL y administración solo por Tailscale.**

```bash
sudo ufw default deny incoming
sudo ufw allow 80,443/tcp
sudo ufw allow in on tailscale0                 # SSH/psql por la red Tailscale
# ⚠️ Verificar primero que puedes entrar por Tailscale; luego:
sudo ufw delete allow OpenSSH
sudo ufw enable
```

- PostgreSQL: `listen_addresses='localhost'` (+ IP Tailscale si se usan herramientas de escritorio) y `pg_hba.conf` con **`scram-sha-256`** únicamente.
- Opcional: Cloudflare delante del dominio (protección adicional y caché de estáticos).

### 16.3 Dominio y TLS

Se necesita un **dominio/subdominio** apuntando a la IP pública del VPS (por ejemplo `erp.tuempresa.com`). Caddy obtiene y renueva el certificado automáticamente. **El HTTPS es obligatorio**: sin él no funcionan Service Worker ni PWA.

`/etc/caddy/Caddyfile`:

```caddyfile
erp.tuempresa.com {
    encode zstd gzip

    handle /api/* {
        reverse_proxy 127.0.0.1:3001
    }
    handle {
        reverse_proxy 127.0.0.1:3000
    }

    header {
        Strict-Transport-Security "max-age=31536000; includeSubDomains"
        X-Content-Type-Options nosniff
        Referrer-Policy strict-origin-when-cross-origin
        -Server
    }
}
```

### 16.4 Contenedores con Podman + Quadlet (systemd)

Imágenes construidas en CI y publicadas en **GHCR**. Contenedores *rootless* del usuario `erp`, con `Network=host` enlazando a `127.0.0.1` (así alcanzan PostgreSQL del host sin configuración extra).

`~/.config/containers/systemd/erp-api.container`

```ini
[Unit]
Description=ERP API (NestJS)
After=network-online.target erp-redis.service
Wants=erp-redis.service

[Container]
Image=ghcr.io/TU_ORG/erp-api:SHA_DEL_COMMIT
ContainerName=erp-api
Network=host
EnvironmentFile=/home/erp/env/api.env
PodmanArgs=--memory=700m --memory-swap=900m
HealthCmd=wget -qO- http://127.0.0.1:3001/api/v1/health || exit 1
HealthInterval=30s
Volume=/var/lib/erp/tmp:/app/tmp:Z

[Service]
Restart=always
TimeoutStartSec=180

[Install]
WantedBy=default.target
```

`erp-web.container` (análogo, puerto 3000, `--memory=450m`) y `erp-redis.container`:

```ini
[Container]
Image=docker.io/library/redis:7-alpine
ContainerName=erp-redis
Network=host
Exec=redis-server --bind 127.0.0.1 --maxmemory 128mb --requirepass CAMBIAR --maxmemory-policy noeviction --appendonly yes --appendfsync everysec
Volume=erp-redis-data:/data
PodmanArgs=--memory=200m

[Service]
Restart=always
[Install]
WantedBy=default.target
```

```bash
# Como usuario erp
systemctl --user daemon-reload
systemctl --user enable --now erp-redis erp-api erp-web
```

> Ubuntu 24.04 incluye Podman 4.9, que ya soporta Quadlet. Variables de entorno en `/home/erp/env/*.env` con permisos `600`.

### 16.5 Variables de entorno (`api.env`)

```
NODE_ENV=production
PORT=3001
HOST=127.0.0.1
TZ=America/Caracas
DATABASE_URL=postgresql://erp:***@127.0.0.1:5432/erp?connection_limit=10
REDIS_URL=redis://:CAMBIAR@127.0.0.1:6379
JWT_ACCESS_SECRET=***            # ≥ 64 caracteres aleatorios
JWT_REFRESH_SECRET=***
JWT_ACCESS_TTL=15m
JWT_REFRESH_TTL=7d
WORKER_ENABLED=true
REPORTS_TMP_DIR=/app/tmp
NODE_OPTIONS=--max-old-space-size=400
```

### 16.6 CI/CD (GitHub Actions)

1. `pnpm install` (con caché) → lint → typecheck → tests (Testcontainers con PG 18 y Redis).
2. Build de imágenes (`erp-api`, `erp-web`) y *push* a **GHCR**.
3. Despliegue: el *runner* se une a la tailnet con `tailscale/github-action` (credenciales OAuth, nodo efímero) y por SSH ejecuta en el VPS:

```bash
podman pull ghcr.io/TU_ORG/erp-api:$TAG ghcr.io/TU_ORG/erp-web:$TAG
podman run --rm --network=host --env-file ~/env/api.env ghcr.io/TU_ORG/erp-api:$TAG \
  npx prisma migrate deploy                       # migraciones ANTES de reiniciar
systemctl --user restart erp-api erp-web
curl -fsS https://erp.tuempresa.com/api/v1/health/ready   # smoke test
```

4. Migraciones **compatibles hacia atrás** (expandir → migrar → contraer), por los clientes offline.

### 16.7 Backups y recuperación

| Qué | Cómo | Retención |
|---|---|---|
| Base de datos | `pg_dump -Fc` diario 02:00 (systemd timer) | 7 diarios locales |
| Copia externa | `restic` o `rclone` a almacenamiento S3-compatible (Backblaze B2, etc.) o a otro nodo Tailscale | 7 diarios + 4 semanales + 12 mensuales |
| Roles y configuración | `pg_dumpall --globals-only` + `/etc/caddy`, `~/env`, Quadlets (cifrados) | Con cada backup |
| Prueba de restauración | **Mensual**, en un entorno temporal | — |
| PITR (WAL) | Opcional cuando haya más disco | — |

Objetivos sugeridos: **RPO ≤ 24 h**, **RTO ≤ 4 h**. Documentar el procedimiento de restauración en `docs/runbook.md`.

### 16.8 Monitoreo ligero

- `/api/v1/health` (liveness) y `/health/ready` (BD + Redis).
- Monitor externo gratuito (UptimeRobot / Better Stack) + alertas por correo/Telegram.
- Alertas de disco > 80 % y RAM/swap altos (script + timer o `node_exporter` si se desea).
- `pg_stat_statements` revisado mensualmente.
- Sentry (plan gratuito) o GlitchTip para errores del frontend y backend (opcional).

### 16.9 Entornos

| Entorno | Dónde |
|---|---|
| Local | `podman compose` / Docker Compose con `postgres:18` y `redis:7` |
| Staging | Mismo VPS, **base de datos distinta** (`erp_staging`) y subdominio `staging.` — solo si la RAM lo permite; de lo contrario, staging temporal bajo demanda |
| Producción | VPS (descrito arriba) |

> **Recomendación:** si el negocio depende críticamente del sistema, valorar más adelante un segundo VPS (réplica/standby) o ampliar recursos. Con 10 usuarios concurrentes el hardware actual es suficiente si se respetan las reglas de este documento.

---

## 17. Repositorio y arranque (Sprint 0)

### 17.1 Estructura

```
mini-erp/
├── apps/
│   ├── api/                       # NestJS
│   │   ├── prisma/ (schema.prisma, migrations/, sql/)   # sql/: triggers, vistas, índices parciales
│   │   └── src/
│   │       ├── main.ts, app.module.ts
│   │       ├── common/            # guards, interceptors, filters, decorators, tenant ext.
│   │       ├── config/
│   │       ├── database/          # PrismaService (+ extensión multiempresa), seeds
│   │       └── modules/
│   │           ├── auth/ users/ companies/ devices/
│   │           ├── administration/ inventory/ pricing/ taxes/ currencies/
│   │           ├── purchases/ sales/ receivables/ payables/ banking/
│   │           ├── fiscal/ documents/ (motor de documentos y posting)
│   │           ├── sync/ reports/ audit/ jobs/
│   └── web/                       # Next.js + TailAdmin + PWA
│       └── src/
│           ├── app/ (auth)/ (dashboard)/
│           ├── components/        # TailAdmin + propios
│           ├── features/          # una carpeta por módulo
│           ├── offline/           # dexie, outbox, sync-engine, service worker (serwist)
│           └── lib/api/           # cliente generado
├── packages/
│   ├── contracts/                 # Zod + tipos
│   ├── domain/                    # cálculo de totales, impuestos, IGTF, moneda
│   └── config/
├── deploy/ (quadlet/, caddy/, scripts/backup.sh, runbook.md)
├── docker-compose.dev.yml
├── turbo.json · pnpm-workspace.yaml · .github/workflows/
```

### 17.2 Comandos de arranque

```bash
corepack enable && corepack prepare pnpm@latest --activate
mkdir mini-erp && cd mini-erp && git init && pnpm init
printf "packages:\n  - 'apps/*'\n  - 'packages/*'\n" > pnpm-workspace.yaml

# API
pnpm dlx @nestjs/cli new api --directory apps/api --package-manager pnpm --strict
# Web (TailAdmin Free)
git clone https://github.com/TailAdmin/free-nextjs-admin-dashboard apps/web && rm -rf apps/web/.git

# Paquetes compartidos
mkdir -p packages/contracts packages/domain packages/config

# Servicios de desarrollo
cat > docker-compose.dev.yml <<'EOF'
services:
  postgres:
    image: postgres:18
    environment: { POSTGRES_DB: erp, POSTGRES_USER: erp, POSTGRES_PASSWORD: erp }
    ports: ["5432:5432"]
    volumes: ["pgdata:/var/lib/postgresql"]
  redis:
    image: redis:7-alpine
    ports: ["6379:6379"]
volumes: { pgdata: {} }
EOF
```

### 17.3 Estándares de código

- TypeScript `strict`, ESLint + Prettier, Husky + lint-staged, **Conventional Commits**.
- Ramas: `main` (producción), `develop`, `feature/*`; PR obligatorio con CI verde.
- Todo endpoint con Zod + Swagger + permiso declarado.
- Prohibido `number` para dinero; usar `Decimal`.
- Toda consulta de negocio **pasa por la extensión multiempresa**; el SQL crudo debe filtrar por `company_id` (revisión obligatoria en PR).
- Una migración = un cambio; SQL manual en `prisma/sql/`.

### 17.4 Checklist de Sprint 0

- [ ] Monorepo pnpm + Turborepo, ESLint/Prettier/Husky
- [ ] `docker-compose.dev.yml` funcionando con PG 18
- [ ] NestJS: config validada, Pino, health, Swagger, filtro de errores estándar, `requestId`
- [ ] Prisma + extensión multiempresa + migración inicial + seeds (monedas, bancos, impuestos VE, roles/permisos)
- [ ] Auth: login, select-company, refresh rotativo, logout, RBAC, auditoría
- [ ] `packages/contracts` y `packages/domain` con primeras pruebas (totales, IVA, IGTF, redondeo)
- [ ] Next.js: TailAdmin integrado, login, selector de empresa, layout con menú por permisos
- [ ] PWA base: Serwist + manifest + Dexie + indicador de conexión
- [ ] Cliente API generado desde OpenAPI
- [ ] **Primer despliegue real al VPS** (Caddy + Quadlet + CI) — desplegar desde la semana 1 evita sorpresas
- [ ] Backup diario + copia externa configurados y probados

---

## 18. Estrategia de pruebas

| Nivel | Herramienta | Foco |
|---|---|---|
| Unitarias | Jest / Vitest | `packages/domain` (totales, IVA, IGTF, redondeo, conversión), costeo promedio, mínimo/máximo, aplicación de pagos |
| Integración | Jest + Testcontainers (PG 18) | Repositorios, `PostingService`, bloqueos, numeración |
| E2E API | Supertest | Flujos completos (abajo) |
| E2E UI | Playwright (incluye `context.setOffline(true)`) | Login, pedido offline → sincronización, factura, reportes |
| Carga | k6 | 10–20 usuarios simultáneos confirmando documentos; reportes pesados con 2 concurrentes |
| Invariantes | Job + pruebas | Kardex = stock = lotes = seriales |

**Flujos E2E obligatorios:**

1. OC → nota de entrega → compra → pago con retención IVA → libro de compras.
2. Pedido (offline) → sincronización → factura con IVA + IGTF → cobro parcial → libro de ventas.
3. Nota de crédito por devolución: revierte inventario, CxC y libro (referenciando factura afectada).
4. Anulación de factura: asiento inverso y línea "anulación" en libro.
5. Traslado entre depósitos con lotes (empresa con lotes activos).
6. Cierre de caja diario cuadra contra transacciones.

**Casos críticos:**

- Dos facturas simultáneas sobre la última unidad (sin stock negativo si no está permitido).
- Numeración fiscal sin huecos ni duplicados bajo concurrencia.
- Costo promedio correcto tras compras, devoluciones y traslados.
- Reintentos de `sync/push` sin duplicar.
- Diferencia de redondeo Bs/USD dentro de la tolerancia definida.
- Aislamiento multiempresa: un usuario de A **nunca** accede a datos de B (pruebas automáticas sobre cada endpoint).
- Una empresa **sin** lotes no ve campos ni recibe errores relacionados con lotes.

---

## 19. Roadmap y backlog por sprint

*Sprints de 2 semanas · 2–3 devs full-stack · reportes esenciales por módulo (D16).*
**Total realista: 38–44 semanas (19–22 sprints), incluyendo piloto.**

| Sprint | Entregable | Contenido | Reportes esenciales |
|---|---|---|---|
| **S0** | Fundación | Checklist 17.4 + **RLS y roles (3)**, PoC Prisma/PG18, despliegue VPS, backups, PoC Dexie con 50 000 productos en móvil real | — |
| **S1** | Catálogos base | Empresa, usuarios/roles, monedas, tasa BCV, impuestos, depósitos, instancias, unidades, productos (+OEM, barras, presentaciones), listas de precio | Productos, lista de precios |
| **S2** | Terceros y parámetros | Proveedores, clientes, zonas, vendedores, instrumentos de pago, bancos/cuentas, `operation_types`, secuencias | Listados de clientes/proveedores/vendedores |
| **S3–S4** | Inventario núcleo (**4 sem**) | Motor de costeo (sección 2), kardex, stock, cargos, descargos, traslados, ajustes, **períodos de inventario**, ajuste de costo, lotes/seriales tras flag | Existencias, kardex, inventario valorizado |
| **S5** | Compras | Cotización → OC → nota de entrega → compra, devoluciones, CxP | Compras, pendientes de recepción |
| **S6** | Importación de datos | Plantillas Excel/CSV (productos, clientes, proveedores, saldos y existencias iniciales); **cargar datos reales de la empresa piloto** | — |
| **S7–S8** | Ventas I + **motor offline** (**4 sem**) | Cotizaciones, presupuestos, pedidos, devolución de pedidos; `DocumentEditor` online/offline; `change_log`, `sync/push|pull`; dispositivos | Pedidos por vendedor |
| **S9–S10** | Ventas II fiscal (**4 sem**) | Facturas, NC/ND, `FiscalProvider`, IVA, IGTF, PDF, caja y cierre, `tax_book_entries`, **período fiscal** | Ventas diarias, cierre de caja |
| **S11** | CxC/CxP y retenciones | Cobros/pagos, anticipos, ND, retenciones IVA/ISLR (incl. tardías), comprobantes | CxC, CxP, vencimientos |
| **S12** | Offline endurecido + **piloto** | Conflictos, revocación, borrado remoto, compatibilidad N−1; piloto con 2–3 vendedores reales | — |
| **S13** | Bancos | Cuentas, transacciones, extractos, conciliación | Movimientos bancarios |
| **S14** | Precios/impuestos/reposición | Ajustes de precios, ajuste de impuestos, min/máx, sugerencias, revalorización | Reposición |
| **S15–S16** | Reportes II + fiscal (**4 sem**) | Clientes, proveedores, vendedores, estados de cuenta, **libros de ventas/compras**, retenciones, IGTF, cierre fiscal | Resto del catálogo |
| **S17** | Endurecimiento | Carga (k6), seguridad, optimización, simulacro de restauración, correo (SMTP) y recuperación de contraseña, 2FA ADMIN/CONTADOR | — |
| **S18** | Capacitación y *go-live* | Manual, capacitación, migración final, plan de contingencia | — |

**MVP vendible:** fin de **S11** (catálogos, inventario, pedidos offline, facturación fiscal, libro de ventas básico, cobros y reportes esenciales).

**Holgura:** reservar un 15 % de capacidad por sprint para deuda técnica y hallazgos del contador; si se prefiere el calendario de la v2 (26–30 sem.), recortar alcance (por ejemplo, posponer bancos/conciliación y precios automáticos), no calidad.

---


## 20. Riesgos y pendientes por validar

| # | Tema | Riesgo / Pregunta | Acción |
|---|---|---|---|
| 1 | **Validación fiscal** | Alícuotas, IGTF, retenciones, formatos de libros y de comprobantes cambian con providencias | Revisión con contador **antes de S6**; todo parametrizable con vigencia |
| 2 | **Facturación y número de control** | ¿Imprenta digital autorizada, formas libres/talonarios o máquina fiscal? Define el `FiscalProvider` | **Decidir antes de S6** (bloqueante para facturas) |
| 3 | **Facturación offline** | Modo A (pedido offline, factura al sincronizar) vs. Modo B (rangos por dispositivo) | Confirmar con el negocio; por defecto Modo A |
| 4 | **Fuente de tasa BCV** | La fuente oficial puede cambiar de formato o no tener API estable | Carga manual como respaldo + alerta si no hay tasa del día |
| 5 | **Recursos del VPS** | 4 GB / 20 GB es ajustado (reportes, imágenes, backups) | Seguir reglas de la sección 3; planificar ampliar disco/RAM |
| 6 | **Punto único de falla** | Un solo servidor | Backups externos probados; considerar standby futuro |
| 7 | **Dominio y HTTPS** | Sin dominio no hay PWA/offline | Registrar dominio/subdominio y apuntarlo al VPS |
| 8 | **iOS y offline** | Safari puede desalojar IndexedDB y limita *background sync* | Recomendar Android/Chrome a vendedores; `storage.persist()` |
| 9 | **Compatibilidad de Prisma con PostgreSQL 18** | Verificar la versión de Prisma y funciones (`uuidv7()`) | Prueba de concepto en S0 |
| 10 | **Versión de TailAdmin** | Versión de Next/React/Tailwind del template y componentes faltantes | Verificar en S0; evaluar versión Pro si hace falta |
| 11 | **Migración de datos** | Carga inicial de productos, clientes, saldos, existencias | Plantillas de importación (Excel/CSV) y validación — incluir en S13 (o antes si se pilota) |
| 12 | **Contabilidad general** | No incluida (plan de cuentas/asientos) | Emitir eventos de dominio para integrarla después |
| 13 | **Costo por lote/serial** | Hoy es promedio por producto | `CostingStrategy` permite añadirlo si algún negocio lo exige |
| 14 | **Ajuste por inflación / otros regímenes** | Fuera del alcance | Reevaluar con el contador |
| 15 | **Protección de datos** | Datos de clientes en dispositivos móviles | PIN, borrado remoto, cierre por inactividad |

---

---

## 21. Especificaciones ampliadas (incorporadas de v2.1)

> Estas secciones **prevalecen** sobre cualquier texto contradictorio de las secciones anteriores.

### 21.1 Decisiones nuevas

| # | Tema | Decisión |
|---|---|---|
| D8 | Aislamiento | **RLS de PostgreSQL obligatorio desde S0**, además de la extensión de Prisma y las FK compuestas (defensa en profundidad) |
| D9 | Fechas retroactivas | **Prohibidas** en documentos de inventario. El kardex se ordena por orden de contabilización, nunca se recalcula hacia atrás |
| D10 | Cierre de períodos | Existen **períodos de inventario** y **períodos fiscales**; un período cerrado no admite entradas nuevas |
| D11 | Sincronización | Cursor por `(txid, seq)` sobre una tabla `change_log`, no por `updated_at` |
| D12 | Precio en pedido offline | El precio se pacta en la **moneda de la lista** (normalmente USD); los Bs del pedido son **indicativos**; la factura convierte a la tasa BCV de su fecha |
| D13 | Staging | **Sin staging permanente en el VPS**. Se levanta bajo demanda y se destruye |
| D14 | Contenedores | **Tags inmutables** (`sha`), sin `latest` ni `AutoUpdate` |
| D15 | Roles de BD | Dos roles: `erp_migrator` (DDL) y `erp_app` (DML, **sin** `BYPASSRLS`) |
| D16 | Reportes esenciales | Se entregan **junto con cada módulo**, no todos al final |

---

### 21.2 Aislamiento multiempresa con RLS desde S0

#### 3.1 Roles

```sql
CREATE ROLE erp_migrator LOGIN PASSWORD '…';   -- dueño del esquema, ejecuta migraciones
CREATE ROLE erp_app      LOGIN PASSWORD '…' NOBYPASSRLS;  -- usada por la API en runtime
-- erp_app: SELECT/INSERT/UPDATE/DELETE sobre tablas; NO DDL, NO superusuario
ALTER DEFAULT PRIVILEGES FOR ROLE erp_migrator IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO erp_app;
```

La API usa `DATABASE_URL` con `erp_app`; el CI usa `MIGRATION_DATABASE_URL` con `erp_migrator` solo para `prisma migrate deploy`.

#### 3.2 Plantilla de política (aplicar a **toda** tabla con `company_id`)

```sql
ALTER TABLE products ENABLE ROW LEVEL SECURITY;
ALTER TABLE products FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON products
  USING      (company_id = current_setting('app.company_id', true)::uuid)
  WITH CHECK (company_id = current_setting('app.company_id', true)::uuid);
```

- Si `app.company_id` no está definido, `current_setting(..., true)` devuelve `NULL` → **no se ve ninguna fila** (falla cerrada).
- Una migración de verificación (y un test de CI) comprueba que **todas** las tablas con `company_id` tienen RLS habilitado y forzado y una política.

#### 3.3 Cómo se fija el contexto con Prisma

Cada request de negocio ejecuta **una transacción interactiva** y lo primero es:

```ts
await tx.$executeRaw`SELECT set_config('app.company_id', ${companyId}, true)`; // true = local a la transacción
```

Se implementa en la extensión de Prisma (`$allOperations`): envuelve cada operación en `$transaction` si no hay una en curso. Los servicios de aplicación abren la transacción una vez y la pasan a los repositorios (un `TenantContext` con `AsyncLocalStorage`).

- **SQL crudo** siempre pasa por el mismo `TenantContext`; prohibido usar `prisma.$queryRaw` fuera de él (regla de ESLint personalizada).
- Los **workers** (jobs) establecen `app.company_id` por empresa en cada job; los jobs globales (tasa BCV, mantenimiento) usan un rol/conexión específicos sobre tablas globales sin RLS.

#### 3.4 Tablas globales (sin `company_id`, sin RLS)

`banks`, `currencies`, `exchange_rates`, `islr_concepts` (semilla). Sus FK **no** son compuestas. El resto sí: plantilla de FK `(company_id, x_id) → (company_id, id)` generada por un script (`scripts/gen-composite-fks.ts`) para no escribirla a mano.

#### 3.5 Pruebas

- Test automático por cada endpoint: usuario de empresa A, `id` de B → 404.
- Test de CI que lista tablas sin RLS.
- Test que ejecuta una consulta sin `set_config` y exige 0 filas.

---

### 21.3 Motor de sincronización

Complementa la sección 10 de la v2.

#### 4.1 Problema que resuelve

Un cursor basado en `updated_at` puede **omitir filas**: una transacción larga confirma con un `updated_at` anterior al cursor que el cliente ya consumió. Se reemplaza por un registro de cambios con cursor monótono y seguro.

#### 4.2 Tabla `change_log`

```sql
CREATE TABLE change_log (
  seq        bigint GENERATED ALWAYS AS IDENTITY,
  txid       xid8   NOT NULL DEFAULT pg_current_xact_id(),
  company_id uuid   NOT NULL,
  entity     text   NOT NULL,
  entity_id  uuid   NOT NULL,
  op         text   NOT NULL CHECK (op IN ('upsert','delete')),
  version    int    NOT NULL,
  PRIMARY KEY (seq)
);
CREATE INDEX ON change_log (company_id, txid, seq);
```

Un trigger `AFTER INSERT/UPDATE/DELETE` en cada tabla sincronizable (4.5) inserta una fila (soft delete = `op='delete'`).

#### 4.3 Pull seguro

El cursor es el par `(txid, seq)` de la última fila entregada. Solo se entregan filas cuyo `txid` es **menor** que el `xmin` del snapshot actual (es decir, de transacciones ya terminadas):

```sql
SELECT seq, txid, entity, entity_id, op, version
FROM change_log
WHERE company_id = $1
  AND (txid, seq) > ($cursor_txid, $cursor_seq)
  AND txid < pg_snapshot_xmin(pg_current_snapshot())
ORDER BY txid, seq
LIMIT $limit;
```

Luego el servidor carga los datos de cada `(entity, entity_id)` (una sola vez por id, tomando la última versión) y los devuelve. Garantías: sin pérdidas; orden estable; un cliente que reintenta recibe lo mismo. Las filas duplicadas se aplican idempotentemente (comparación de `version`).

Respuesta:

```json
{ "cursor": "123456:98765", "changes": [ { "entity": "products", "id": "…", "op": "upsert", "version": 7, "data": { … } } ], "hasMore": true }
```

- Se elimina el "solape de 60 s".
- **Bootstrap:** primera descarga por entidad con paginación por `id` (UUIDv7 es ordenable) y se registra el cursor inicial **antes** de empezar (para no perder cambios durante la descarga).
- **Retención de `change_log`:** 90 días. Si un dispositivo envía un cursor más antiguo, el servidor responde `410 CURSOR_EXPIRED` y el cliente hace **bootstrap completo**.
- Filtros por vendedor/zona: el filtro se aplica sobre `entity_id` al cargar datos; cambios de asignación de zona generan `delete` en el dispositivo anterior.

#### 4.4 Push

Como en la v2 (sección 10.3), con estas precisiones:

- Orden: por `clientSeq` por dispositivo; si falta un `clientSeq` intermedio, se rechaza con `GAP` y el cliente reenvía.
- `Idempotency-Key` por lote y `clientOpId` único por operación (`sync_operations`). Mismo `clientOpId` con **payload distinto** → `409 PAYLOAD_MISMATCH`.
- Cada operación en su propia transacción, con `app.company_id` y `app.user_id` fijados.
- Tras aplicar, el servidor devuelve el estado final del documento (número definitivo, totales recalculados) y la discrepancia con los totales del cliente (si la hay).
- **Reglas por tipo de operación:** solo se aceptan `ORDER`, `QUOTE`, `BUDGET`, `CUSTOMER_CREATE/UPDATE`, `RECEIPT_DRAFT`. Cualquier otra → `REJECTED/OP_NOT_ALLOWED_OFFLINE`.

#### 4.5 Entidades sincronizables

| Dirección | Entidades |
|---|---|
| Servidor → dispositivo (pull) | `products`, `product_barcodes`, `product_references`, `product_uoms`, `product_prices`, `price_lists`, `categories`, `units`, `taxes`, `exchange_rates`, `customers` (filtrados), `customer_addresses`, `payment_methods`, `warehouses`, `stock_snapshot` (existencias **indicativas** por producto/depósito), `lots` (solo tracking) |
| Dispositivo → servidor (push) | `sales_documents` (`QUOTE`, `BUDGET`, `ORDER`) + líneas, `customers` (alta/edición), `receipts` en borrador |

Los costos **nunca** se sincronizan al dispositivo.

#### 4.6 Pruebas

Las de 10.8 (v2) más: transacción larga en el servidor mientras el dispositivo hace pull (no se pierde la fila), cursor expirado → bootstrap, `clientSeq` con hueco, mismo `clientOpId` con payload distinto, 50 000 productos en un móvil de gama media (búsqueda < 200 ms) **medido en un dispositivo real antes de S5**.

---

### 21.4 Políticas del modo offline

| Tema | Política |
|---|---|
| **Moneda del pedido** | El precio se fija en la moneda de la lista (D12). El pedido guarda `rate_at_order` y `total_bs_indicative`. La factura recalcula en Bs con la tasa BCV de la fecha de emisión; el sistema muestra al cliente que el monto en Bs puede variar |
| **Frescura del catálogo** | Si el último pull exitoso supera `catalog_max_age_hours` (por defecto 72 h), la app **advierte** y, configurable, **bloquea** nuevos pedidos |
| **Sobreventa** | La existencia mostrada es indicativa con su fecha. Al sincronizar, si no hay stock, el pedido se acepta con advertencia (D en 10.4). Se añade límite configurable por empresa: `max_offline_order_value_usd` y por vendedor, para acotar el riesgo |
| **Cobros offline** | Solo se admiten como **recibo provisional** (`RECEIPT_DRAFT`), sin valor fiscal ni asignación a documentos. Al sincronizar pasan a revisión de caja (aprobar → se numera el recibo definitivo y se genera `receipt` + banco/caja). Configurable por empresa; **desactivado por defecto** |
| **Número provisional** | `OFF-<device>-<seq>` solo se muestra en UI; se guarda en `clientMeta.localNumber` y **no** en `document_sequences` |
| **Clientes nuevos** | Alta con RIF validado en cliente; duplicado en servidor se vincula al existente |
| **Cierre por inactividad** | Tras `offline_max_days` (por defecto 14) sin sincronizar, la app se bloquea hasta reconectar |

---

### 21.5 Fiscal

> Mismas advertencias de la sección 8 de la v2: **todo lo siguiente es modelado técnico y debe validarlo un contador** antes de producción.

#### 6.1 IGTF: dónde vive

- `sales_document_payments` (pagos del documento) incluye: `currency_id`, `amount_fx`, `exchange_rate`, `amount_bs`, `applies_igtf`, `igtf_base_bs`, `igtf_rate`, `igtf_amount_bs`.
- `sales_documents` totaliza `igtf_total_bs` **separado** de `tax_total` (no es parte de la base imponible del IVA).
- El IGTF forma parte de lo que el cliente paga, pero **no** del precio de la factura; se refleja en una línea informativa y se incluye en el recibo/factura según el formato validado con el contador.
- Libro de ventas: columna de IGTF solo si el contador lo exige; en todo caso existe el reporte `taxes/igtf` basado en `sales_document_payments`.
- Si el pago ocurre **después** de la factura (cobro de CxC), el IGTF se calcula en `receipt_allocations` y se registra en el recibo.

#### 6.2 Retenciones tardías

Modelo para retenciones que llegan después del cobro:

- La factura se cobra por lo efectivamente recibido; el saldo restante se marca como **`PENDING_WITHHOLDING`** si el cliente es agente de retención (monto esperado = IVA × % configurado).
- El estado de la factura es `PAID` solo cuando `cobros + retenciones recibidas ≥ total`. Mientras tanto aparece como *pagada con retención pendiente* en CxC y en el reporte de retenciones por recibir (con antigüedad).
- Al llegar el comprobante: `withholding_vouchers` (`status = RECEIVED`, número, fecha, período) → `receipt_allocations` de tipo `WITHHOLDING` contra la factura.
- Si el comprobante nunca llega o difiere del esperado, se crea una **nota de débito** o se concilia manualmente (documento `CxC adjustment` con motivo).
- Retenciones **emitidas** (compras): se generan al pagar al proveedor; el comprobante tiene su correlativo en `document_sequences` (serie `RET-IVA`/`RET-ISLR`).

#### 6.3 Ventas a consumidor final resumidas por día

Proceso diario `fiscal.daily_summary` (a la hora de cierre de caja): agrega facturas de consumidor final del día a una entrada de libro **resumen** (`tax_book_entries.entry_type = 'DAILY_SUMMARY'`) con rango de números de control. Solo se activa por empresa y si el contador lo valida. Las facturas individuales siguen existiendo; el libro refleja el resumen.

#### 6.4 Diferencial cambiario (sin contabilidad general)

No genera asiento. La revalorización de CxC/CxP/bancos produce un **reporte y un documento de revalorización** con la ganancia/pérdida cambiaria por período, listo para que el contador lo contabilice. Se emite el evento `fx.revaluation.posted` para una futura integración contable.

#### 6.5 Plazo para el `FiscalProvider`

La decisión del proveedor de numeración/control debe tomarse **antes de comenzar S5** (ver sección 11). El `ManualRangeProvider` se implementa primero (sirve para pruebas) y el definitivo se enchufa por la interfaz.

---

### 21.6 Correcciones al modelo de datos

#### 7.1 `document_links` relacional (reemplaza `quantity_map` JSON)

```sql
CREATE TABLE document_links (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  company_id uuid NOT NULL,
  parent_type text NOT NULL, parent_id uuid NOT NULL,
  child_type  text NOT NULL, child_id  uuid NOT NULL,
  UNIQUE (company_id, parent_id, child_id)
);
CREATE TABLE document_link_lines (
  link_id uuid NOT NULL REFERENCES document_links(id),
  company_id uuid NOT NULL,
  parent_line_id uuid NOT NULL,
  child_line_id  uuid NOT NULL,
  quantity numeric(18,4) NOT NULL CHECK (quantity > 0),
  PRIMARY KEY (link_id, parent_line_id, child_line_id)
);
-- Cantidad pendiente de una línea padre = line.quantity − Σ quantity (excluyendo hijos anulados)
```

Las cantidades pendientes se resuelven con una vista `v_line_pending`.

#### 7.2 Tabla única de documentos de ventas: campos por tipo

Para evitar una tabla "dios", cada `doc_type` declara en `DocumentTypeRegistry` qué columnas aplica, y la BD refuerza con `CHECK`:

| Columna | QUOTE/BUDGET/ORDER | INVOICE | CREDIT/DEBIT_NOTE |
|---|---|---|---|
| `fiscal_number`, `control_number` | NULL obligatorio | obligatorios al confirmar | obligatorios al confirmar |
| `affected_document_id` | NULL | NULL | obligatorio |
| `due_date`, `payment_condition` | opcional | obligatorios | opcional |
| `reserves_stock` | opcional (presupuesto) | false | false |

Los datos fiscales viven en `sales_fiscal_data` (1:1) para no engordar la tabla principal.

#### 7.3 Estados: `CANCELLED` vs `VOIDED`

- `CANCELLED`: documento **no fiscal** o **no confirmado**. No consume número (si estaba en `DRAFT`) o lo conserva (si se confirmó y es no fiscal).
- `VOIDED`: documento **fiscal confirmado** (factura/NC/ND). Conserva número y control y aparece en el libro como anulación.
- Rutas: `POST /:id/cancel` para el primer caso, `POST /:id/void` para el segundo. Un mismo endpoint nunca hace ambas cosas; el motor valida según `doc_type` y estado.
- "Anulación de órdenes/presupuestos" en el menú es una **vista filtrada** (`status = CANCELLED`) sobre `document_cancellations`, no un módulo aparte.

#### 7.4 Otras correcciones

| Tema | Corrección |
|---|---|
| `inventory_stock` | No guarda costo; el valorizado vigente sale de `product_costs` y el histórico del kardex/snapshots |
| `pgcrypto` | Se elimina de la instalación (PG18 trae `uuidv7()` y `gen_random_uuid()`) salvo que se use explícitamente |
| `version`/`updated_at` | Solo en tablas sincronizables (4.5) y catálogos; los ledgers no tienen `updated_at` |
| `idempotency_keys` | Misma clave + distinto hash de request → `409 IDEMPOTENCY_KEY_REUSED` |
| `permHash` en JWT | Un cambio de permisos tarda hasta 15 min en aplicar al access token; se acepta y se documenta (revocar por `jti` para casos urgentes) |
| Ejemplo 11.3 | Usar UUID para `taxId`/`currencyId`; `"iva-general"` y `"USD"` no son IDs válidos |
| Triggers `updated_at` | Mantener `clock_timestamp()`, pero el cursor de sync usa `change_log`, no este campo |

---

### 21.7 Infraestructura y seguridad de despliegue

Correcciones a la sección 16 de la v2.

| Punto | Corrección |
|---|---|
| **Acceso de emergencia** | No cerrar SSH público hasta probar Tailscale. Mantener acceso por la **consola web del proveedor**. Alternativa: dejar SSH abierto solo para IPs fijas conocidas y con `PasswordAuthentication no`. Documentarlo en `runbook.md` |
| **Redis** | Añadir `--requirepass <secreto>` y usar `REDIS_URL=redis://:secreto@127.0.0.1:6379`. Con `Network=host` cualquier proceso local lo alcanzaría |
| **Roles de BD** | Dos roles (D15). Contraseñas distintas. `pg_hba.conf` con `scram-sha-256` y `host … erp_app 127.0.0.1/32` |
| **Imágenes** | Tags inmutables por commit (`ghcr.io/ORG/erp-api:<sha>`). Quitar `AutoUpdate=registry` y `:latest`. El despliegue cambia el tag en el Quadlet (o usa un archivo de entorno con `IMAGE_TAG`) |
| **Orden de despliegue** | (1) migración con `erp_migrator`, (2) arrancar API nueva, (3) *smoke test*, (4) si falla, *rollback* al tag anterior (las migraciones son compatibles hacia atrás por el patrón expandir→migrar→contraer) |
| **Tailscale ACL** | El runner de CI usa un nodo efímero etiquetado `tag:ci` con ACL que **solo** permite SSH al VPS y solo como usuario `erp` (no root) |
| **Backups** | Evitar llenar el disco: `pg_dump -Fc \| zstd \| restic backup --stdin` directo a destino remoto; copia local solo de los últimos 3 días. Cifrado en el repositorio de restic. Verificar `restic check` semanal |
| **Staging** | No permanente (D13): `scripts/staging-up.sh` crea `erp_staging` + contenedores con límites bajos y se destruye tras la validación |
| **Disco** | Alerta a 70 % (aviso) y 85 % (crítica); el job de mantenimiento aborta reportes si queda < 1,5 GB libres |
| **Prisma / PG18** | PoC en S0: `uuidv7()` como `dbgenerated`, `xid8`, `pg_current_snapshot()`, RLS con `set_config` y transacciones interactivas. Si el PoC falla, generar UUIDv7 en la app |
| **Versiones** | Verificar versiones vigentes (Node, NestJS, Next, Prisma, PG 18.x) al iniciar S0 y fijarlas en `.nvmrc`/`package.json` (`engines`) |

---

### 21.8 Retención de datos y disco

| Tabla | Política |
|---|---|
| `audit_logs` | Detalle (`diff` JSON) 12 meses; después se conservan solo metadatos (entidad, acción, usuario, fecha). Exportar y archivar el detalle antiguo a almacenamiento externo comprimido |
| `sync_operations` | Payload completo 60 días; después solo `client_op_id`, estado y resultado (para idempotencia) |
| `change_log` | 90 días |
| `idempotency_keys` | 48 h |
| `report_runs` | Metadatos 12 meses; archivos 24 h |
| `refresh_tokens` | Eliminar expirados cada día |
| `inventory_movements`, `bank_transactions`, `tax_book_entries` | Nunca se borran. Si el volumen lo exige, particionar por año |

Presupuesto de crecimiento: medir el tamaño de las tablas en el piloto (S8) y proyectar a 12 meses; si la proyección supera el 60 % del disco, **ampliar a 40 GB antes del *go-live***.

---

### 21.9 Pendientes con fecha límite

| # | Decisión | Fecha límite | Responsable |
|---|---|---|---|
| P1 | Proveedor de numeración y control fiscal (imprenta digital / talonarios / equipo fiscal) | Antes de **S7** | Negocio + contador |
| P2 | Validación del modelo fiscal (IGTF, retenciones tardías, formato de libros) con el contador | Antes de **S9** | Contador |
| P3 | Modo A vs. B de facturación offline | Antes de **S7** | Negocio |
| P4 | Cobros offline sí/no (por defecto no) | Antes de **S7** | Negocio |
| P5 | Dominio/subdominio y DNS | **S0** | Infraestructura |
| P6 | Fuente de tasa BCV y política de redondeo Bs/USD | **S1** | Negocio + contador |
| P7 | Dispositivos de los vendedores (Android/Chrome) | **S6** | Negocio |
| P8 | Destino de backups externos (B2/S3/otro nodo) | **S0** | Infraestructura |
| P9 | Proveedor SMTP | **S16** | Infraestructura |
| P10 | Ampliar disco a 40 GB | Antes del piloto (**S12**) | Infraestructura |

---

### 21.10 Correcciones menores

- **Orden de ESLint:** regla personalizada que prohíbe `$queryRaw`/`$executeRaw` fuera del `TenantContext`.
- **CI:** verificar en cada PR que no hay tablas con `company_id` sin RLS, y que las FK compuestas existen (script de verificación del esquema).
- **Definición de terminado (Anexo B):** añadir *"RLS y FK compuestas verificadas"*, *"reporte esencial incluido"* y *"retención de datos definida si es una tabla de alto crecimiento"*.
- **Pruebas:** añadir a la sección 18 los casos de las secciones 2.7 (costeo) y 4.6 (sincronización).
- **Documentación viva:** mantener `docs/decisions/` con un ADR corto por cada decisión D1–D16.

---

*Fin de la adenda v2.1. Se recomienda, tras revisarla, fusionarla en un único `erp-v3.md` antes del Sprint 0.*


## Anexo A – Glosario

| Español | Código |
|---|---|
| Depósito / Almacén | `warehouse` |
| Instancia (categoría) | `category` |
| Producto | `product` |
| Lote / Serial / Vencimiento | `lot` / `serial` / `expiry` |
| Proveedor / Cliente / Vendedor / Zona | `supplier` / `customer` / `seller` / `zone` |
| Instrumento de pago | `payment_method` |
| Operación | `operation_type` |
| Traslado / Cargo / Descargo / Ajuste | `transfer` / `charge` / `discharge` / `adjustment` |
| Factor cambiario | `exchange_rate` |
| Cotización / Presupuesto / Pedido | `quote` / `budget` / `order` |
| Orden de compra / Nota de entrega | `purchase_order` / `delivery_note` |
| Factura / Nota de crédito / Nota de débito | `invoice` / `credit_note` / `debit_note` |
| Número de control | `control_number` |
| Cuenta por cobrar / pagar | `receivable` / `payable` |
| Retención (IVA / ISLR) | `withholding` |
| Libro de ventas / compras | `sales_book` / `purchase_book` |
| Contribuyente especial | `special_taxpayer` |
| IGTF | `igtf` |
| Conciliación | `reconciliation` |
| Beneficiario | `beneficiary` |
| Sincronización | `sync` |

## Anexo B – Definición de "terminado"

Un módulo se considera terminado cuando cumple **todo**:

- [ ] Modelo Prisma + migración (con SQL manual si aplica) y semillas
- [ ] Esquemas Zod en `contracts`, DTOs y Swagger actualizados
- [ ] Permisos definidos y sembrados; pruebas de aislamiento multiempresa
- [ ] Reglas de negocio con pruebas unitarias; flujo principal con prueba E2E
- [ ] Auditoría de acciones críticas
- [ ] Efectos verificados (inventario / CxC / CxP / banco / libro fiscal) y reversibles por anulación
- [ ] Pantallas Next.js (listado, formulario, detalle) con estados de carga/error
- [ ] ¿Aplica offline? → soportado en `DocumentEditor` + sincronización probada
- [ ] ¿Aplica lotes/seriales? → probado **con y sin** el flag activo
- [ ] Reporte(s) asociados y exportación
- [ ] Documentación y *runbook* actualizados

---

*Fin del documento – v3.*
