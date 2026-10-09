/** Formato regional es-VE: separador decimal coma, miles con punto. Los importes llegan como cadenas decimales de la API. */
const num = (min: number, max: number) => new Intl.NumberFormat("es-VE", { minimumFractionDigits: min, maximumFractionDigits: max });
const cache = new Map<string, Intl.NumberFormat>();

export function fmtNumber(value: string | number | null | undefined, min = 0, max = 4): string {
  if (value === null || value === undefined || value === "") return "—";
  const n = typeof value === "number" ? value : Number(value);
  if (Number.isNaN(n)) return String(value);
  const key = `${min}-${max}`;
  if (!cache.has(key)) cache.set(key, num(min, max));
  return cache.get(key)!.format(n);
}

export const fmtMoney = (value: string | number | null | undefined, decimals = 2) => fmtNumber(value, decimals, Math.max(decimals, 4));
export const fmtQty = (value: string | number | null | undefined) => fmtNumber(value, 0, 4);

export function fmtDate(value: string | Date | null | undefined): string {
  if (!value) return "—";
  const s = typeof value === "string" ? value : value.toISOString();
  // Fechas de negocio (date) llegan como ISO; se muestran sin desfase de zona.
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : s;
}

export function fmtDateTime(value: string | null | undefined): string {
  if (!value) return "—";
  return new Date(value).toLocaleString("es-VE", { timeZone: "America/Caracas", dateStyle: "short", timeStyle: "short" });
}

export const todayCaracas = () => new Date().toLocaleDateString("en-CA", { timeZone: "America/Caracas" });
