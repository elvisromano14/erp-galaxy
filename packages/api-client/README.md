# @erp/api-client

Cliente tipado de la API del Mini ERP, **generado desde su OpenAPI** (`openapi.json`). Sirve para la web, la app móvil u otro cliente en TypeScript.

```ts
import { createErpClient, unwrap } from '@erp/api-client';

let token: string | null = null;
const api = createErpClient({
  baseUrl: 'https://erp.ejemplo.com',
  getAccessToken: () => token,
  refreshAccessToken: async () => { /* renovar con tu flujo y devolver el nuevo token */ return token; },
});

const login = await unwrap<{ accessToken: string; companies: { id: string }[] }>(api.POST('/api/v1/auth/login', { body: { email, password } }));
token = login.data.accessToken;
const sel = await unwrap<{ accessToken: string }>(api.POST('/api/v1/auth/select-company', { body: { companyId: login.data.companies[0].id } }));
token = sel.data.accessToken;

const orders = await unwrap<Order[]>(api.GET('/api/v1/sales/orders', { params: { query: { page: 1, limit: 20, status: 'CONFIRMED' } } }));
console.log(orders.data, orders.meta?.total);
```

- Rutas, parámetros de consulta y cuerpos están **tipados** (un cuerpo inválido o una ruta inexistente no compilan).
- Las respuestas vienen siempre en el sobre `{ data, meta? }`; `unwrap<T>()` lo devuelve o lanza `ErpApiError` (`status`, `code`, `message`, `details`, `requestId`).
- `refreshAccessToken` se invoca una vez ante un 401 y la petición se reintenta.

## Regenerar tras cambiar la API

```bash
pnpm --filter @erp/api openapi:export      # requiere PostgreSQL y Redis de desarrollo; escribe openapi.json
pnpm --filter @erp/api-client generate     # openapi.json → src/schema.d.ts
pnpm --filter @erp/api-client test          # compila (incluye comprobaciones de tipos de uso)
```

> Limitación conocida: los esquemas de **respuesta** no están descritos en el OpenAPI (la API documenta entradas con Zod); los tipos de respuesta se indican con el genérico de `unwrap<T>()`.
