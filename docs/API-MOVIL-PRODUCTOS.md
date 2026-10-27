# App móvil: productos, ubicaciones y marca (contrato del servidor)

Extiende `GET /sync/pull` y `POST /sync/push` (ver `erp-v3.md`). Todo sigue el mismo sobre, cabeceras (`X-Device-Id`, `X-App-Version`) y reglas de idempotencia que clientes y documentos.

## Pull (lectura)
Entidades nuevas (catálogos pequeños: `fullRefresh: true`, la app reemplaza su tabla local; los borrados llegan con `deletedAt`):

| `entity` | Campos |
|---|---|
| `locations` | `id, code, name, isActive, updatedAt, deletedAt` |
| `units` | `id, code, name, deletedAt` |
| `categories` | `id, code, name, parentId, deletedAt` |

`products` (incremental, cursor) agrega: `categoryId, unitId, brand, locationId, minStock, maxStock` (además de los ya existentes `categoryName`, `unitCode`, `taxId`, …). `version` es la que la app debe devolver al editar.

`app_settings` agrega `allowProductCreate` y `allowProductUpdate` (booleanos): el usuario tiene los permisos `admin:products:create` / `admin:products:update`. La app oculta «Nuevo producto» / «Editar» si son `false`.

## Push: `product.create`
`entity: "product"`, `action: "create"`, `entityId`: UUID local del producto en el teléfono.

```json
{
  "sku": "MOV-001",              // obligatorio, 1–60
  "name": "Bujía NGK",           // obligatorio, 1–250
  "description": "…",            // opcional, ≤ 2000
  "categoryId": "<uuid>|null",   // opcional (id de `categories`)
  "unitId": "<uuid>",            // obligatorio (id de `units`)
  "taxId": "<uuid>|null",        // opcional (id de `taxes`)
  "brand": "MHW",                // opcional, ≤ 80 (texto libre)
  "locationId": "<uuid>|null",   // opcional (id de `locations`)
  "minStock": "2", "maxStock": "20",   // opcionales, decimales como texto
  "isService": false,            // opcional
  "barcodes": ["7599990001"],    // opcional, ≤ 20
  "price": "12.50"               // opcional: precio en la lista de precios PREDETERMINADA (moneda de la lista)
}
```

Reglas: permiso `admin:products:create` del usuario; solo productos simples (sin lotes ni seriales; la empresa puede restringir `isService` según su configuración). **Idempotencia:** el mismo `clientOpId` devuelve `DUPLICATE` con el mismo `serverId`; si ya existe un producto con ese SKU (sin distinguir mayúsculas) se **vincula** al existente (`APPLIED`, `linked: true`) y no se duplica. El `entityId` local queda mapeado para ediciones posteriores aún sin sincronizar.

Resultado `APPLIED`: `serverId` (id del producto), `serverNumber` (= SKU), `serverStatus` (`ACTIVE`/`INACTIVE`).

## Push: `product.update`
`entity: "product"`, `action: "update"`, `entityId`: id local (si el alta vino del mismo teléfono) o id del servidor.

Mismos campos que el alta **excepto `sku`** (no se cambia desde el móvil), todos opcionales, más:

* `version` (**obligatorio**, entero): la `version` que la app vio en el pull. Si el producto cambió desde entonces → `REJECTED` / `VERSION_CONFLICT` (la app debe bajar el producto y reintentar).
* `price` (opcional): agrega/actualiza el precio de hoy en la lista predeterminada.

Permiso `admin:products:update`.

## Rechazos (`status: "REJECTED"`, definitivos)
| `errorCode` | Cuándo |
|---|---|
| `FORBIDDEN` | El usuario no tiene el permiso de producto. |
| `VALIDATION_ERROR` | Un campo no cumple el esquema (el mensaje lista `campo: motivo`), p. ej. `version` ausente, `unitId` no UUID, precio negativo. |
| `LOCATION_NOT_FOUND` | `locationId` no existe en la empresa (o está borrada). |
| `VERSION_CONFLICT` | `version` vencida (solo `update`). |
| `PRODUCT_NOT_FOUND` | El producto a editar no existe (o está borrado). |
| `PRICE_LIST_REQUIRED` | Se envió `price` y la empresa no tiene lista predeterminada. |
| `FEATURE_DISABLED`, `INVALID_TRACKING` | Reglas de la empresa sobre servicios, lotes o seriales. |

Los errores transitorios del servidor devuelven `RETRY` (la app conserva la operación), como en las demás entidades.
