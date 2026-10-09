import { COST_DP, D, Decimal, DecimalLike, round, ZERO } from './decimal';

/**
 * Costeo promedio ponderado móvil (erp-v3 §7.2).
 * Estado por (empresa, producto): Q = existencia total, C = costo promedio.
 * Todas las funciones son puras y devuelven el nuevo estado + costo unitario del movimiento.
 */
export interface CostState { qty: Decimal; avgCost: Decimal }

export interface CostMove {
  state: CostState;
  /** Costo unitario con que se valora el movimiento. */
  unitCost: Decimal;
}

const state = (qty: Decimal, avg: Decimal): CostState => ({ qty, avgCost: round(avg, COST_DP) });

/** Compra / cargo / devolución de venta: entrada con costo `c`. */
export function applyEntry(s: CostState, q: DecimalLike, c: DecimalLike): CostMove {
  const qty = D(q), cost = D(c);
  if (qty.lte(0)) throw new Error('La cantidad de entrada debe ser positiva');
  if (cost.isNegative()) throw new Error('El costo no puede ser negativo');
  const newQty = s.qty.plus(qty);
  // Si no había existencia (Q ≤ 0) el promedio se reinicia en el costo de la entrada.
  const avg = s.qty.gt(0) ? s.qty.mul(s.avgCost).plus(qty.mul(cost)).div(newQty) : cost;
  return { state: state(newQty, avg), unitCost: round(cost, COST_DP) };
}

/** Venta / descargo / ajuste negativo / pata de salida de traslado: se valora a C, C no cambia. */
export function applyExit(s: CostState, q: DecimalLike): CostMove {
  const qty = D(q);
  if (qty.lte(0)) throw new Error('La cantidad de salida debe ser positiva');
  return { state: state(s.qty.minus(qty), s.avgCost), unitCost: s.avgCost };
}

/** Devolución de compra / anulación de compra: sale al costo original c0 y recalcula el promedio. */
export function applyPurchaseReturn(s: CostState, q: DecimalLike, originalCost: DecimalLike): CostMove {
  const qty = D(q), c0 = D(originalCost);
  if (qty.lte(0)) throw new Error('La cantidad debe ser positiva');
  const newQty = s.qty.minus(qty);
  let avg = s.avgCost;
  if (newQty.gt(0)) {
    const candidate = s.qty.mul(s.avgCost).minus(qty.mul(c0)).div(newQty);
    if (!candidate.isNegative()) avg = candidate;
  }
  return { state: state(newQty, avg), unitCost: round(c0, COST_DP) };
}

/** Ajuste de costo (documento COST_ADJUSTMENT): devuelve el valor del movimiento de valor (qty = 0). */
export function applyCostAdjustment(s: CostState, newAvg: DecimalLike): { state: CostState; valueDelta: Decimal } {
  const target = round(newAvg, COST_DP);
  const delta = target.minus(s.avgCost).mul(s.qty.gt(0) ? s.qty : ZERO);
  return { state: { qty: s.qty, avgCost: target }, valueDelta: round(delta, 4) };
}

export const emptyCost = (): CostState => ({ qty: ZERO, avgCost: ZERO });
