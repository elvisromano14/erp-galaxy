import { z } from 'zod';
import { decimalStr, paginationQuery, uuid } from '@erp/contracts';

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Formato AAAA-MM-DD');
const pct = decimalStr.refine(v => Number(v) > 0 && Number(v) <= 100, 'El porcentaje debe estar entre 0 y 100');

/** Retención que PRACTICAMOS a un proveedor sobre una compra confirmada. */
export const issueWithholdingSchema = z.object({
  kind: z.enum(['IVA', 'ISLR']),
  purchaseDocumentId: uuid,
  /** IVA: por omisión el % de retención del proveedor. ISLR: obligatorio (según el concepto). */
  percentage: pct.optional(),
  /** Base en Bs. IVA: por omisión el IVA de la compra. ISLR: por omisión la base imponible + exento de la compra. */
  baseBs: decimalStr.refine(v => Number(v) >= 0, 'La base no puede ser negativa').optional(),
  concept: z.string().trim().max(200).nullable().optional(),
  voucherDate: date.optional(),
  notes: z.string().max(500).nullable().optional(),
});

/** Retención que un cliente NOS practica sobre una factura emitida (comprobante del cliente). */
export const receiveWithholdingSchema = z.object({
  kind: z.enum(['IVA', 'ISLR']),
  salesDocumentId: uuid,
  externalNumber: z.string().trim().min(1, 'El número del comprobante es obligatorio').max(60),
  percentage: pct.optional(),
  baseBs: decimalStr.refine(v => Number(v) >= 0, 'La base no puede ser negativa').optional(),
  concept: z.string().trim().max(200).nullable().optional(),
  voucherDate: date.optional(),
  notes: z.string().max(500).nullable().optional(),
});

export const withholdingListSchema = paginationQuery.extend({
  direction: z.enum(['ISSUED', 'RECEIVED']).optional(), kind: z.enum(['IVA', 'ISLR']).optional(), status: z.string().optional(),
  dateFrom: date.optional(), dateTo: date.optional(),
});
export const cancelWithholdingSchema = z.object({ reason: z.string().trim().min(3, 'El motivo es obligatorio').max(500) });
export const eligibleQuery = z.object({ direction: z.enum(['ISSUED', 'RECEIVED']), partyId: uuid });
