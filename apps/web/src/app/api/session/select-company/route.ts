import { NextResponse } from "next/server";
import { callApi, clientIp, setRefreshCookie } from "../_bff";

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  const token = req.headers.get("authorization")?.replace(/^Bearer /, "");
  const res = await callApi("/auth/select-company", { body, token, ip: clientIp(req), userAgent: req.headers.get("user-agent") });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) return NextResponse.json(json, { status: res.status });
  const { refreshToken, ...data } = json.data;
  const out = NextResponse.json(data);
  setRefreshCookie(out, refreshToken);
  return out;
}
