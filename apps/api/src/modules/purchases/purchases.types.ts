import { z } from 'zod';
import { decimalStr, paginationQuery, uuid } from '@erp/contracts';

export type PurchaseDocType = 'QUOTE' | 'ORDER' | 'DELIVERY_NOTE' | 'DELIVERY_NOTE_RETURN' | 'PURCHASE' | 'PURCHASE_RETURN';

export interface PurchaseRoute {
  path: string; docType: PurchaseDocType; seq: string; permission: string;
}

/** `purchases` (compras) va ÚLTIMO para que `/purchases/:id` no capture `/purchases/quotes`. */
export const PURCHASE_ROUTES: PurchaseRoute[] = [
  { path: 'purchases/quotes', docType: 'QUOTE', seq: 'PURCHASE_QUOTE', permission: 'purchases:quotes' },
  { path: 'purchases/orders', docType: 'ORDER', seq: 'PURCHASE_ORDER', permission: 'purchases:orders' },
  { path: 'purchases/delivery-notes', docType: 'DELIVERY_NOTE', seq: 'PURCHASE_DELIVERY_NOTE', permission: 'purchases:delivery-notes' },
  { path: 'purchases/delivery-note-returns', docType: 'DELIVERY_NOTE_RETURN', seq: 'PURCHASE_DELIVERY_NOTE_RETURN', permission: 'purchases:delivery-note-returns' },
  { path: 'purchases/returns', docType: 'PURCHASE_RETURN', seq: 'PURCHASE_RETURN', permission: 'purchases:returns' },
  { path: 'purchases', docType: 'PURCHASE', seq: 'PURCHASE', permission: 'purchases:invoices' },
];

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Formato AAAA-MM-DD');

export const purchaseLineSchema = z.object({
  productId: uuid,
  description: z.string().trim().max(500).nullable().optional(),
  quantity: decimalStr.refine(v => Number(v) > 0, 'La cantidad debe ser mayor que cero'),
  unitCost: decimalStr.refine(v => Number(v) >= 0, 'El costo no puede ser negativo'),
  discountPct: decimalStr.refine(v => Number(v) >= 0 && Number(v) <= 100, '0–100').optional(),
  taxId: uuid.nullable().optional(),
  lotNo: z.string().trim().min(1).max(60).nullable().optional(),
  expiryDate: date.nullable().optional(),
  parentLineId: uuid.nullable().optional(),
  /** Productos con control por serial: lista de seriales (cantidad = cantidad de seriales). */
  serials: z.array(z.string().trim().min(1).max(100)).max(5000).optional(),
});

export const purchaseDocSchema = z.object({
  supplierId: uuid,
  warehouseId: uuid.nullable().optional(),
  currencyId: uuid,
  exchangeRate: decimalStr.refine(v => Number(v) > 0, 'La tasa debe ser positiva').optional(),
  docDate: date.optional(),
  expiresAt: date.nullable().optional(),
  paymentCondition: z.enum(['CASH', 'CREDIT']).default('CASH'),
  creditDays: z.number().int().min(0).max(365).default(0),
  supplierDocNo: z.string().trim().max(60).nullable().optional(),
  supplierControlNo: z.string().trim().max(60).nullable().optional(),
  notes: z.string().max(1000).nullable().optional(),
  parentId: uuid.nullable().optional(),
  lines: z.array(purchaseLineSchema).min(1, 'Se requiere al menos una línea'),
});
export const purchaseDocUpdateSchema = purchaseDocSchema.partial().extend({ version: z.number().int().optional() });

export const purchaseListSchema = paginationQuery.extend({
  status: z.string().optional(), supplierId: uuid.optional(), dateFrom: date.optional(), dateTo: date.optional(),
});
export const cancelSchema = z.object({ reason: z.string().trim().min(3, 'El motivo es obligatorio').max(500) });

export const receiveSchema = z.object({
  warehouseId: uuid.optional(),
  supplierDocNo: z.string().trim().max(60).nullable().optional(),
  notes: z.string().max(1000).nullable().optional(),
  lines: z.array(z.object({
    orderLineId: uuid, quantity: decimalStr.refine(v => Number(v) > 0, 'La cantidad debe ser mayor que cero'),
    lotNo: z.string().trim().min(1).nullable().optional(), expiryDate: date.nullable().optional(),
    serials: z.array(z.string().trim().min(1).max(100)).optional(),
  })).min(1),
});

export type PurchaseDocInput = z.infer<typeof purchaseDocSchema>;
export type PurchaseLineInput = z.infer<typeof purchaseLineSchema>;
