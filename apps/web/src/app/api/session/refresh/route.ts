import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { callApi, clearRefreshCookie, clientIp, REFRESH_COOKIE, setRefreshCookie } from "../_bff";

export async function POST(req: Request) {
  const store = await cookies();
  const refreshToken = store.get(REFRESH_COOKIE)?.value;
  if (!refreshToken) return NextResponse.json({ error: "NO_SESSION", message: "Sin sesión" }, { status: 401 });
  const res = await callApi("/auth/refresh", { body: { refreshToken }, ip: clientIp(req), userAgent: req.headers.get("user-agent") });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const out = NextResponse.json(json, { status: res.status });
    clearRefreshCookie(out);
    return out;
  }
  const { refreshToken: next, ...data } = json.data;
  const out = NextResponse.json(data);
  setRefreshCookie(out, next);
  return out;
}
