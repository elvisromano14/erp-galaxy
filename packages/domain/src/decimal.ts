import Decimal from 'decimal.js';

// Redondeo half-up (el que usa la contabilidad comercial), precisión holgada para intermedios.
Decimal.set({ precision: 40, rounding: Decimal.ROUND_HALF_UP });

export { Decimal };
export type DecimalLike = Decimal | string | number;

export const D = (v: DecimalLike): Decimal => (v instanceof Decimal ? v : new Decimal(v));
export const ZERO = new Decimal(0);

/** Redondea a `dp` decimales (half-up). */
export const round = (v: DecimalLike, dp: number): Decimal => D(v).toDecimalPlaces(dp, Decimal.ROUND_HALF_UP);

export const MONEY_DP = 4;
export const QTY_DP = 4;
export const COST_DP = 6;
export const RATE_DP = 8;
