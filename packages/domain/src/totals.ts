import { D, Decimal, DecimalLike, MONEY_DP, round, ZERO } from './decimal';

export interface LineInput {
  quantity: DecimalLike;
  unitPrice: DecimalLike;
  discountPct?: DecimalLike;
  /** Alícuota en % (16 = 16 %). 0 para exento. */
  taxRate: DecimalLike;
  /** Exento/exonerado se reporta aparte de la base imponible. */
  taxExempt?: boolean;
}

export interface LineResult {
  gross: Decimal;
  discount: Decimal;
  net: Decimal; // base imponible (o monto exento)
  taxRate: Decimal;
  tax: Decimal;
  total: Decimal;
  exempt: boolean;
}

export interface DocumentTotals {
  lines: LineResult[];
  subtotal: Decimal; // suma de net
  taxableBase: Decimal;
  exemptBase: Decimal;
  taxTotal: Decimal;
  total: Decimal;
  /** Base e impuesto agrupados por alícuota (insumo del libro fiscal). */
  byRate: { taxRate: Decimal; base: Decimal; tax: Decimal }[];
}

/** El impuesto se calcula POR LÍNEA y se redondea por línea (decisión documentada: evita discrepancias con el libro). */
export function calcLine(l: LineInput): LineResult {
  const qty = D(l.quantity);
  const price = D(l.unitPrice);
  const disc = D(l.discountPct ?? 0);
  if (qty.isNegative()) throw new Error('La cantidad no puede ser negativa');
  if (disc.lt(0) || disc.gt(100)) throw new Error('Descuento fuera de rango');
  const gross = round(qty.mul(price), MONEY_DP);
  const discount = round(gross.mul(disc).div(100), MONEY_DP);
  const net = gross.minus(discount);
  const exempt = !!l.taxExempt || D(l.taxRate).isZero();
  const taxRate = exempt ? ZERO : D(l.taxRate);
  const tax = exempt ? ZERO : round(net.mul(taxRate).div(100), MONEY_DP);
  return { gross, discount, net, taxRate, tax, total: net.plus(tax), exempt };
}

export function calcDocument(inputs: LineInput[]): DocumentTotals {
  const lines = inputs.map(calcLine);
  let subtotal = ZERO, taxableBase = ZERO, exemptBase = ZERO, taxTotal = ZERO;
  const groups = new Map<string, { taxRate: Decimal; base: Decimal; tax: Decimal }>();
  for (const r of lines) {
    subtotal = subtotal.plus(r.net);
    taxTotal = taxTotal.plus(r.tax);
    if (r.exempt) { exemptBase = exemptBase.plus(r.net); continue; }
    taxableBase = taxableBase.plus(r.net);
    const k = r.taxRate.toString();
    const g = groups.get(k) ?? { taxRate: r.taxRate, base: ZERO, tax: ZERO };
    g.base = g.base.plus(r.net);
    g.tax = g.tax.plus(r.tax);
    groups.set(k, g);
  }
  return {
    lines, subtotal, taxableBase, exemptBase, taxTotal,
    total: subtotal.plus(taxTotal),
    byRate: [...groups.values()].sort((a, b) => a.taxRate.cmp(b.taxRate)),
  };
}

/** Conversión a Bs con la tasa congelada del documento. */
export function toBase(amount: DecimalLike, rate: DecimalLike): Decimal {
  return round(D(amount).mul(D(rate)), MONEY_DP);
}

/** IGTF: porcentaje sobre el pago en divisas, expresado en Bs. */
export function calcIgtf(paymentBs: DecimalLike, ratePct: DecimalLike): Decimal {
  return round(D(paymentBs).mul(D(ratePct)).div(100), MONEY_DP);
}
