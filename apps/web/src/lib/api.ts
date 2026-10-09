/**
 * Cliente HTTP del ERP.
 *  - El access token vive SOLO en memoria (erp-v3 §12.1); el refresh token va en una cookie httpOnly gestionada por
 *    los route handlers de `/api/session/*` (BFF ligero).
 *  - Ante un 401 intenta renovar la sesión una vez (con single-flight) y reintenta la petición.
 */

export interface ApiMeta {
  page?: number;
  limit?: number;
  total?: number;
  totalPages?: number;
  nextCursor?: string | null;
}

export interface ApiDetail {
  field?: string;
  code: string;
  message?: string;
}

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details: ApiDetail[] = [],
    public requestId?: string,
  ) {
    super(message);
  }
}

export interface ApiResult<T> {
  data: T;
  meta?: ApiMeta;
}

let accessToken: string | null = null;
let refreshing: Promise<string | null> | null = null;
let onSessionLost: (() => void) | null = null;

export const setAccessToken = (t: string | null) => {
  accessToken = t;
};
export const getAccessToken = () => accessToken;
export const setSessionLostHandler = (fn: (() => void) | null) => {
  onSessionLost = fn;
};

type Query = Record<string, string | number | boolean | undefined | null>;

export function buildQuery(q?: Query): string {
  if (!q) return "";
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(q)) {
    if (v === undefined || v === null || v === "") continue;
    sp.set(k, String(v));
  }
  const s = sp.toString();
  return s ? `?${s}` : "";
}

async function parse(res: Response) {
  const text = await res.text();
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return { message: text };
  }
}

/** Renueva el access token con la cookie de refresh (una sola petición simultánea). */
export function refreshSession(): Promise<string | null> {
  if (!refreshing) {
    refreshing = (async () => {
      try {
        const res = await fetch("/api/session/refresh", { method: "POST", credentials: "same-origin" });
        if (!res.ok) {
          accessToken = null;
          return null;
        }
        const body = await res.json();
        accessToken = body.accessToken as string;
        return accessToken;
      } catch {
        return null;
      } finally {
        refreshing = null;
      }
    })();
  }
  return refreshing;
}

interface RequestOptions {
  method?: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  query?: Query;
  body?: unknown;
  headers?: Record<string, string>;
  /** No intentar renovar sesión ante 401 (login, etc.). */
  skipRefresh?: boolean;
}

export async function api<T = unknown>(path: string, opts: RequestOptions = {}): Promise<ApiResult<T>> {
  const doFetch = () =>
    fetch(`/api/v1${path}${buildQuery(opts.query)}`, {
      method: opts.method ?? "GET",
      credentials: "same-origin",
      headers: {
        ...(opts.body !== undefined ? { "Content-Type": "application/json" } : {}),
        ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
        ...opts.headers,
      },
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    });

  let res = await doFetch();
  if (res.status === 401 && !opts.skipRefresh) {
    const t = await refreshSession();
    if (t) res = await doFetch();
    else {
      onSessionLost?.();
    }
  }
  const body = await parse(res);
  if (!res.ok) {
    throw new ApiError(
      res.status,
      body?.error ?? "ERROR",
      body?.message ?? `Error ${res.status}`,
      body?.details ?? [],
      body?.requestId,
    );
  }
  if (body && typeof body === "object" && "data" in body) return { data: body.data as T, meta: body.meta };
  return { data: body as T };
}

export const get = <T = unknown>(path: string, query?: Query) => api<T>(path, { query });
export const post = <T = unknown>(path: string, body?: unknown, headers?: Record<string, string>) =>
  api<T>(path, { method: "POST", body: body ?? {}, headers });
export const patch = <T = unknown>(path: string, body: unknown) => api<T>(path, { method: "PATCH", body });
export const del = <T = unknown>(path: string) => api<T>(path, { method: "DELETE" });

// ───────── sesión (BFF) ─────────
export interface SessionResponse {
  user: { id: string; email: string; fullName: string; isSuperAdmin: boolean };
  companies: { id: string; rif: string; legalName: string; tradeName: string | null }[];
  companyId: string | null;
  requiresCompanySelection: boolean;
  accessToken: string;
  expiresIn: number;
}

async function sessionCall<T>(path: string, body?: unknown, auth = false): Promise<T> {
  const res = await fetch(`/api/session/${path}`, {
    method: "POST",
    credentials: "same-origin",
    headers: {
      "Content-Type": "application/json",
      ...(auth && accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
    },
    body: JSON.stringify(body ?? {}),
  });
  const parsed = await parse(res);
  if (!res.ok) throw new ApiError(res.status, parsed?.error ?? "ERROR", parsed?.message ?? `Error ${res.status}`, parsed?.details ?? []);
  return parsed as T;
}

export async function login(email: string, password: string): Promise<SessionResponse> {
  const r = await sessionCall<SessionResponse>("login", { email, password });
  accessToken = r.accessToken;
  return r;
}

export async function selectCompany(companyId: string) {
  const r = await sessionCall<{ companyId: string; accessToken: string }>("select-company", { companyId }, true);
  accessToken = r.accessToken;
  return r;
}

export async function logout() {
  try {
    await sessionCall("logout", {}, true);
  } finally {
    accessToken = null;
  }
}
