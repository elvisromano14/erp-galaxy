import { z } from "zod";

const required = (msg: string) => z.string().trim().min(1, msg);
const optionalPositive = (msg: string) => z.string().refine((v) => v.trim() === "" || Number(v) > 0, msg);

interface LineRules {
  /** Nombre de la columna de precio/costo (si la hay) para validar que no sea negativa. */
  priceKey?: "unitPrice" | "unitCost";
  /** El % de descuento (0–100). */
  discount?: boolean;
  /** Cantidad exigida mayor que cero (por omisión, sí). */
  quantity?: boolean;
}

/**
 * Regla común de la rejilla de líneas: la fila vacía final se ignora; debe quedar al menos una línea con producto y cada una
 * con cantidad positiva, precio no negativo y descuento 0–100. Mismos criterios que valida la API (los mensajes nombran la línea).
 */
export function linesRule(rules: LineRules = {}) {
  return z.array(z.object({ _key: z.string() }).passthrough()).superRefine((lines, ctx) => {
    const real = lines.map((l, i) => [l as Record<string, any>, i] as const).filter(([l]) => !!l.productId);
    if (!real.length) ctx.addIssue({ code: "custom", message: "Agregue al menos una línea con producto", path: [] });
    for (const [l, i] of real) {
      const n = i + 1;
      if (rules.quantity !== false && !(Number(l.quantity) > 0)) ctx.addIssue({ code: "custom", message: `Línea ${n}: la cantidad debe ser mayor que cero`, path: [i, "quantity"] });
      const price = rules.priceKey ? l[rules.priceKey] : undefined;
      if (price !== undefined && price !== "" && Number(price) < 0) ctx.addIssue({ code: "custom", message: `Línea ${n}: el precio no puede ser negativo`, path: [i, rules.priceKey!] });
      if (rules.discount && l.discountPct !== undefined && l.discountPct !== "" && (Number(l.discountPct) < 0 || Number(l.discountPct) > 100)) ctx.addIssue({ code: "custom", message: `Línea ${n}: el descuento debe estar entre 0 y 100`, path: [i, "discountPct"] });
    }
  });
}

/** Cabecera + líneas de un documento de venta (cotización, presupuesto, pedido, factura). */
export const salesDocSchema = (type: string) => z.object({
  customerId: required("Seleccione el cliente"),
  currencyId: required("Seleccione la moneda"),
  docDate: required("Indique la fecha"),
  warehouseId: type === "INVOICE" ? required("Seleccione el depósito") : z.string(),
  exchangeRate: optionalPositive("La tasa debe ser positiva"),
  creditDays: z.string().refine((v) => v.trim() === "" || (Number.isInteger(Number(v)) && Number(v) >= 0 && Number(v) <= 365), "Entre 0 y 365 días"),
  lines: linesRule({ priceKey: "unitPrice", discount: true }),
}).passthrough().superRefine((d, ctx) => {
  if (d.reservesStock === true && !d.warehouseId) ctx.addIssue({ code: "custom", message: "Para reservar existencias indique el depósito", path: ["warehouseId"] });
});

/** Cabecera + líneas de un documento de compra (cotización, orden, nota de entrega, compra, devoluciones). */
export const purchaseDocSchema = (type: string) => z.object({
  supplierId: required("Seleccione el proveedor"),
  currencyId: required("Seleccione la moneda"),
  docDate: required("Indique la fecha"),
  warehouseId: ["DELIVERY_NOTE", "PURCHASE", "DELIVERY_NOTE_RETURN", "PURCHASE_RETURN"].includes(type) ? z.string() : z.string(),
  exchangeRate: optionalPositive("La tasa debe ser positiva"),
  creditDays: z.string().refine((v) => v.trim() === "" || (Number.isInteger(Number(v)) && Number(v) >= 0 && Number(v) <= 365), "Entre 0 y 365 días"),
  lines: linesRule({ priceKey: "unitCost", discount: true }),
}).passthrough();

/** Documentos de inventario (cargo, descargo, traslado, ajuste, ajuste de costo). */
export const inventoryDocSchema = (type: string) => z.object({
  warehouseId: required("Seleccione el depósito"),
  toWarehouseId: type === "TRANSFER" ? required("Seleccione el depósito de destino") : z.string().optional(),
  lines: linesRule({ quantity: type !== "ADJUSTMENT" && type !== "COST_ADJUSTMENT" }),
}).passthrough().superRefine((d, ctx) => {
  if (type === "TRANSFER" && d.toWarehouseId && d.toWarehouseId === d.warehouseId) ctx.addIssue({ code: "custom", message: "El depósito de destino debe ser distinto del de origen", path: ["toWarehouseId"] });
});
