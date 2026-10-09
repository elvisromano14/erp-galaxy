import { z } from 'zod';
import { decimalStr, paginationQuery, uuid } from '@erp/contracts';

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Formato AAAA-MM-DD');
const nonZero = decimalStr.refine(v => Number(v) !== 0, 'El monto no puede ser cero');
const positive = decimalStr.refine(v => Number(v) > 0, 'El monto debe ser mayor que cero');

export const paymentSchema = z.object({
  supplierId: uuid,
  paymentMethodId: uuid,
  bankAccountId: uuid.nullable().optional(),
  currencyId: uuid,
  exchangeRate: decimalStr.refine(v => Number(v) > 0, 'La tasa debe ser positiva').optional(),
  paymentDate: date.optional(),
  reference: z.string().trim().max(60).nullable().optional(),
  notes: z.string().max(1000).nullable().optional(),
  /** Monto a aplicar a cada cuenta por pagar, en la moneda de ESA cuenta (negativo para compensar saldos a favor). */
  applications: z.array(z.object({ payableEntryId: uuid, amount: nonZero })).min(1, 'Indique al menos una cuenta por pagar'),
});
export const paymentListSchema = paginationQuery.extend({ supplierId: uuid.optional(), status: z.string().optional(), dateFrom: date.optional(), dateTo: date.optional() });
export const cancelPaymentSchema = z.object({ reason: z.string().trim().min(3, 'El motivo es obligatorio').max(500) });
export const openPayablesQuery = z.object({ supplierId: uuid });

export const movementSchema = z.object({
  bankAccountId: uuid,
  kind: z.enum(['DEPOSIT', 'WITHDRAWAL', 'FEE', 'ADJUSTMENT']),
  /** DEPOSIT suma; WITHDRAWAL y FEE restan (monto positivo); ADJUSTMENT lleva signo. */
  amount: nonZero,
  movementDate: date.optional(),
  reference: z.string().trim().max(60).nullable().optional(),
  description: z.string().trim().max(300).nullable().optional(),
});
export const transferSchema = z.object({
  fromAccountId: uuid, toAccountId: uuid,
  amountOut: positive,
  /** Obligatorio si las cuentas son de distinta moneda. */
  amountIn: positive.optional(),
  movementDate: date.optional(),
  reference: z.string().trim().max(60).nullable().optional(),
});
export const ledgerQuery = paginationQuery.extend({ dateFrom: date.optional(), dateTo: date.optional(), onlyUnreconciled: z.coerce.boolean().optional() });
export const reconcileSchema = z.object({
  bankAccountId: uuid, statementDate: date, statementBalance: decimalStr,
  movementIds: z.array(uuid).min(1, 'Seleccione al menos un movimiento'), notes: z.string().max(500).nullable().optional(),
});
export type PaymentInput = z.infer<typeof paymentSchema>;

export const receiptSchema = z.object({
  customerId: uuid,
  paymentMethodId: uuid,
  bankAccountId: uuid.nullable().optional(),
  currencyId: uuid,
  exchangeRate: decimalStr.refine(v => Number(v) > 0, 'La tasa debe ser positiva').optional(),
  receiptDate: date.optional(),
  reference: z.string().trim().max(60).nullable().optional(),
  notes: z.string().max(1000).nullable().optional(),
  /** Monto a aplicar a cada cuenta por cobrar, en la moneda de ESA cuenta (negativo para compensar notas de crédito). */
  applications: z.array(z.object({ receivableEntryId: uuid, amount: nonZero })).min(1, 'Indique al menos una cuenta por cobrar'),
});
export const receiptListSchema = paginationQuery.extend({ customerId: uuid.optional(), status: z.string().optional(), dateFrom: date.optional(), dateTo: date.optional() });
export const openReceivablesQuery = z.object({ customerId: uuid });
export const receivableListSchema = paginationQuery.extend({ customerId: uuid.optional(), status: z.string().optional(), onlyOpen: z.coerce.boolean().optional() });
export const openingReceivableSchema = z.object({
  customerId: uuid,
  documentNo: z.string().trim().min(1).max(60),
  issueDate: date,
  dueDate: date.optional(),
  currencyId: uuid,
  exchangeRate: decimalStr.refine(v => Number(v) > 0, 'La tasa debe ser positiva').optional(),
  /** Positivo = el cliente debe; negativo = saldo a favor del cliente. */
  amount: nonZero,
  notes: z.string().max(500).nullable().optional(),
});
export type ReceiptInput = z.infer<typeof receiptSchema>;
export type NewReceivable = {
  customerId: string; entryType: 'OPENING' | 'INVOICE' | 'CREDIT_NOTE' | 'DEBIT_NOTE'; sourceType?: string; sourceId?: string; documentNo: string;
  issueDate: Date; dueDate: Date; currencyId: string; exchangeRate: string; amount: string; notes?: string | null;
};
