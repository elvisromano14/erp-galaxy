import { NextResponse } from "next/server";

export const API_URL = process.env.API_URL ?? "http://127.0.0.1:3101";
export const REFRESH_COOKIE = "erp_rt";

export function setRefreshCookie(res: NextResponse, token: string, days = 7) {
  res.cookies.set(REFRESH_COOKIE, token, {
    httpOnly: true,
    // HTTPS obligatorio en producción; COOKIE_SECURE=false solo para pruebas por HTTP en red local.
    secure: process.env.COOKIE_SECURE ? process.env.COOKIE_SECURE === "true" : process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/api/session", // solo viaja a estos handlers
    maxAge: days * 86400,
  });
}

export function clearRefreshCookie(res: NextResponse) {
  res.cookies.set(REFRESH_COOKIE, "", { httpOnly: true, path: "/api/session", maxAge: 0 });
}

/** Llama a la API de NestJS. El refresh token nunca se devuelve al navegador. */
export async function callApi(path: string, init: { body?: unknown; token?: string | null; ip?: string | null; userAgent?: string | null }) {
  return fetch(`${API_URL}/api/v1${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(init.token ? { Authorization: `Bearer ${init.token}` } : {}),
      ...(init.ip ? { "X-Forwarded-For": init.ip } : {}),
      ...(init.userAgent ? { "User-Agent": init.userAgent } : {}),
    },
    body: JSON.stringify(init.body ?? {}),
    cache: "no-store",
  });
}

export const clientIp = (req: Request) => req.headers.get("x-forwarded-for");
