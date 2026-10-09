import { z } from 'zod';
import { decimalStr, paginationQuery, uuid } from '@erp/contracts';

export type SalesDocType = 'QUOTE' | 'BUDGET' | 'ORDER' | 'INVOICE' | 'CREDIT_NOTE' | 'DEBIT_NOTE';

export interface SalesRoute { path: string; docType: SalesDocType; seq: string; permission: string }

export const SALES_ROUTES: SalesRoute[] = [
  { path: 'sales/quotes', docType: 'QUOTE', seq: 'SALES_QUOTE', permission: 'sales:quotes' },
  { path: 'sales/budgets', docType: 'BUDGET', seq: 'SALES_BUDGET', permission: 'sales:budgets' },
  { path: 'sales/orders', docType: 'ORDER', seq: 'SALES_ORDER', permission: 'sales:orders' },
  { path: 'sales/invoices', docType: 'INVOICE', seq: 'SALES_INVOICE', permission: 'sales:invoices' },
  { path: 'sales/credit-notes', docType: 'CREDIT_NOTE', seq: 'SALES_CREDIT_NOTE', permission: 'sales:credit-notes' },
  { path: 'sales/debit-notes', docType: 'DEBIT_NOTE', seq: 'SALES_DEBIT_NOTE', permission: 'sales:debit-notes' },
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
  /** Facturas con productos por serial: seriales que se venden (cantidad = nº de seriales). */
  serials: z.array(z.string().trim().min(1).max(100)).max(5000).optional(),
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
export interface Viewer { userId: string; all: boolean; /** puede confirmar por encima del límite de crédito */ creditOverride?: boolean }
export const confirmSchema = z.object({ overrideCredit: z.boolean().optional() }).default({});

export const invoicePaymentSchema = z.object({
  paymentMethodId: uuid,
  bankAccountId: uuid.nullable().optional(),
  currencyId: uuid,
  exchangeRate: decimalStr.refine(v => Number(v) > 0, 'La tasa debe ser positiva').optional(),
  /** Monto entregado en la moneda del pago. */
  amount: decimalStr.refine(v => Number(v) > 0, 'El monto debe ser mayor que cero'),
  reference: z.string().trim().max(60).nullable().optional(),
});
/** Emisión de factura: si es de contado se registran los pagos (cuadrar con total + IGTF); si es a crédito nace la cuenta por cobrar. */
export const confirmInvoiceSchema = z.object({ overrideCredit: z.boolean().optional(), payments: z.array(invoicePaymentSchema).max(10).optional() }).default({});
export const creditNoteSchema = z.object({
  lines: z.array(z.object({ parentLineId: uuid, quantity: decimalStr.refine(v => Number(v) > 0, 'La cantidad debe ser mayor que cero'), serials: z.array(z.string().trim().min(1).max(100)).optional() })).min(1, 'Indique al menos una línea'),
  notes: z.string().max(1000).nullable().optional(),
  /** Devolución de dinero: solo si la nota deja saldo a favor del cliente (p. ej. factura de contado). Sale de esta cuenta bancaria o caja. */
  refund: z.object({ bankAccountId: uuid }).optional(),
});
export const debitNoteSchema = z.object({
  concept: z.string().trim().min(3, 'Indique el concepto').max(300),
  amount: decimalStr.refine(v => Number(v) > 0, 'El monto debe ser mayor que cero'),
  taxId: uuid.nullable().optional(),
  notes: z.string().max(1000).nullable().optional(),
});
export const pdfQuery = z.object({ format: z.enum(['a4', 'ticket']).default('a4') });
export type InvoicePaymentInput = z.infer<typeof invoicePaymentSchema>;
