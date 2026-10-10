import { NextResponse } from "next/server";

/** Salud de la web (para el healthcheck del contenedor); no depende de la API ni del middleware de idioma. */
export const dynamic = "force-dynamic";
export function GET() {
  return NextResponse.json({ status: "ok" });
}
