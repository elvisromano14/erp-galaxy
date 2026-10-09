import createClient, { type Middleware } from 'openapi-fetch';
import type { paths } from './schema';

export type { paths, components, operations } from './schema';

/** Todas las respuestas exitosas de la API vienen envueltas: `{ data, meta? }` (paginación con `meta`). */
export interface Envelope<T = unknown> {
  data: T;
  meta?: { page?: number; limit?: number; total?: number; totalPages?: number; nextCursor?: string | null };
}

/** Cuerpo de error estándar de la API. */
export interface ErpErrorBody {
  statusCode: number; error: string; message: string;
  details?: { field?: string; code: string; message?: string }[]; requestId?: string;
}

export class ErpApiError extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly details: NonNullable<ErpErrorBody['details']> = [], readonly requestId?: string) {
    super(message);
    this.name = 'ErpApiError';
  }
}

export interface ErpClientOptions {
  /** Raíz de la API, p. ej. `https://erp.ejemplo.com` (las rutas ya incluyen `/api/v1`). */
  baseUrl: string;
  /** Token de acceso vigente (la API lo emite con `POST /api/v1/auth/login` + `select-company`). */
  getAccessToken: () => string | null | undefined | Promise<string | null | undefined>;
  /** Si se indica, ante un 401 se llama una vez para renovar el token y se reintenta la petición. */
  refreshAccessToken?: () => Promise<string | null | undefined>;
  fetch?: typeof fetch;
}

/**
 * Cliente tipado: rutas, parámetros y cuerpos salen del OpenAPI de la API (`openapi.json`).
 * Las respuestas se tipan como el sobre `{ data, meta }`; use `unwrap<T>()` para obtener el dato o un `ErpApiError`.
 */
export function createErpClient(opts: ErpClientOptions) {
  const client = createClient<paths>({ baseUrl: opts.baseUrl, fetch: opts.fetch });
  const withToken = async (req: Request, token?: string | null) => {
    const t = token ?? (await opts.getAccessToken());
    if (t) req.headers.set('Authorization', `Bearer ${t}`);
    return req;
  };
  const middleware: Middleware = {
    async onRequest({ request }) {
      return withToken(request);
    },
    async onResponse({ request, response }) {
      if (response.status !== 401 || !opts.refreshAccessToken || request.headers.get('X-Retried')) return undefined;
      const fresh = await opts.refreshAccessToken();
      if (!fresh) return undefined;
      const retry = new Request(request.url, { method: request.method, headers: new Headers(request.headers), body: request.body ? await request.clone().arrayBuffer() : undefined });
      retry.headers.set('X-Retried', '1');
      return (opts.fetch ?? fetch)(await withToken(retry, fresh));
    },
  };
  client.use(middleware);
  return client;
}

export type ErpClient = ReturnType<typeof createErpClient>;

/** Resultado de una llamada de `openapi-fetch`. */
export interface CallResult { data?: unknown; error?: unknown; response: Response }

/** Devuelve el sobre `{ data, meta }` tipado o lanza `ErpApiError` con el código, mensaje y detalles de la API. */
export async function unwrap<T = unknown>(call: Promise<CallResult>): Promise<Envelope<T>> {
  const { data, error, response } = await call;
  if (!response.ok || error) {
    const e = (error ?? {}) as Partial<ErpErrorBody>;
    throw new ErpApiError(response.status, e.error ?? 'HTTP_ERROR', e.message ?? response.statusText, e.details ?? [], e.requestId);
  }
  return (data ?? { data: undefined }) as Envelope<T>;
}
