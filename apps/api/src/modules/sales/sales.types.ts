import { z } from 'zod';
import { decimalStr, paginationQuery, uuid } from '@erp/contracts';

export type SalesDocType = 'QUOTE' | 'BUDGET' | 'ORDER';

export interface SalesRoute { path: string; docType: SalesDocType; seq: string; permission: string }

export const SALES_ROUTES: SalesRoute[] = [
  { path: 'sales/quotes', docType: 'QUOTE', seq: 'SALES_QUOTE', permission: 'sales:quotes' },
  { path: 'sales/budgets', docType: 'BUDGET', seq: 'SALES_BUDGET', permission: 'sales:budgets' },
  { path: 'sales/orders', docType: 'ORDER', seq: 'SALES_ORDER', permission: 'sales:orders' },
];

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Formato AAAA-MM-DD');

export const salesLineSchema = z.object({
  productId: uuid,
  description: z.string().trim().max(500).nullable().optional(),
  quantity: decimalStr.refine(v => Number(v) > 0, 'La cantidad debe ser mayor que cero'),
  /** Si se omite, se toma de la lista de precios del documento/cliente. */
  unitPrice: decimalStr.refine(v => Number(v) >= 0, 'El precio no puede ser negativo').optional(),
  discountPct: decimalStr.refine(v => Number(v) >= 0 && Number(v) <= 100, '0–100').optional(),
  taxId: uuid.nullable().optional(),
  parentLineId: uuid.nullable().optional(),
});

export const salesDocSchema = z.object({
  customerId: uuid,
  sellerId: uuid.nullable().optional(),
  warehouseId: uuid.nullable().optional(),
  priceListId: uuid.nullable().optional(),
  currencyId: uuid,
  exchangeRate: decimalStr.refine(v => Number(v) > 0, 'La tasa debe ser positiva').optional(),
  docDate: date.optional(),
  validUntil: date.nullable().optional(),
  paymentCondition: z.enum(['CASH', 'CREDIT']).default('CASH'),
  creditDays: z.number().int().min(0).max(365).default(0),
  reservesStock: z.boolean().default(false),
  notes: z.string().max(1000).nullable().optional(),
  parentId: uuid.nullable().optional(),
  lines: z.array(salesLineSchema).min(1, 'Se requiere al menos una línea'),
});
export const salesDocUpdateSchema = salesDocSchema.partial().extend({ version: z.number().int().optional() });

export const salesListSchema = paginationQuery.extend({
  status: z.string().optional(), customerId: uuid.optional(), sellerId: uuid.optional(), dateFrom: date.optional(), dateTo: date.optional(),
});
export const salesCancelSchema = z.object({ reason: z.string().trim().min(3, 'El motivo es obligatorio').max(500) });

export type SalesDocInput = z.infer<typeof salesDocSchema>;
export type SalesLineInput = z.infer<typeof salesLineSchema>;
/** Quién consulta: `all` = puede ver documentos de todos los vendedores. */
export interface Viewer { userId: string; all: boolean }
