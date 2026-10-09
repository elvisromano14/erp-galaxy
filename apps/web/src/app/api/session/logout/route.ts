import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { callApi, clearRefreshCookie, REFRESH_COOKIE } from "../_bff";

export async function POST(req: Request) {
  const store = await cookies();
  const refreshToken = store.get(REFRESH_COOKIE)?.value;
  const token = req.headers.get("authorization")?.replace(/^Bearer /, "");
  if (token) await callApi("/auth/logout", { body: { refreshToken }, token }).catch(() => undefined);
  const out = new NextResponse(null, { status: 204 });
  clearRefreshCookie(out);
  return out;
}
