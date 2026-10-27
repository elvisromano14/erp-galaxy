import { z } from 'zod';
import { decimalStr, uuid } from '@erp/contracts';

export const registerDeviceSchema = z.object({
  deviceKey: z.string().trim().min(16).max(100),
  name: z.string().trim().min(2).max(100),
  platform: z.enum(['android', 'ios']).default('android'),
  appVersion: z.string().trim().max(30).optional(),
});

export const PULL_ENTITIES = [
  'app_settings', 'currencies', 'taxes', 'exchange_rates', 'price_lists', 'warehouses', 'locations', 'units', 'categories', 'customers', 'products', 'product_prices', 'stock_snapshots', 'my_documents',
] as const;
export type PullEntity = (typeof PULL_ENTITIES)[number];

export const pullQuery = z.object({
  entity: z.enum(PULL_ENTITIES),
  /** Cursor opaco devuelto por la página anterior (vacío = desde el principio). */
  cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(2000).default(1000),
  /** Solo en la primera página de cada sincronización: relee los últimos N segundos (transacciones que confirmaron tarde). */
  overlapSeconds: z.coerce.number().int().min(0).max(600).default(0),
});

export const SYNC_ENTITIES = ['customer', 'product', 'sales_quote', 'sales_order'] as const;
export const SYNC_ACTIONS = ['create', 'update'] as const;

/** Sobre de una operación: el `data` se valida por tipo al procesarla, para que una operación inválida no tumbe todo el lote. */
export const pushSchema = z.object({
  operations: z.array(z.object({
    clientOpId: uuid,
    clientSeq: z.number().int().nonnegative(),
    entity: z.enum(SYNC_ENTITIES),
    action: z.enum(SYNC_ACTIONS),
    /** Id local de la entidad en el dispositivo (UUID). */
    entityId: uuid,
    data: z.record(z.string(), z.unknown()),
  })).min(1).max(50),
});
export type PushOperation = z.infer<typeof pushSchema>['operations'][number];

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const optText = (max: number) => z.string().trim().max(max).nullable().optional();

export const customerData = z.object({
  rif: z.string().trim().min(5).max(20),
  legalName: z.string().trim().min(2).max(200),
  tradeName: optText(200), phone: optText(40), email: z.string().email().nullable().optional(), address: optText(500),
  personType: z.enum(['LEGAL', 'NATURAL']).optional(), priceListId: uuid.nullable().optional(),
});
export const customerUpdateData = customerData.omit({ rif: true }).partial();

/** Alta de producto desde el móvil: solo productos simples (sin lotes ni seriales); precio inicial en la lista predeterminada. */
export const productData = z.object({
  sku: z.string().trim().min(1).max(60),
  name: z.string().trim().min(1).max(250),
  description: optText(2000),
  categoryId: uuid.nullable().optional(), unitId: uuid, taxId: uuid.nullable().optional(),
  brand: optText(80), locationId: uuid.nullable().optional(),
  minStock: decimalStr.optional(), maxStock: decimalStr.optional(),
  isService: z.boolean().optional(),
  barcodes: z.array(z.string().trim().min(1).max(64)).max(20).optional(),
  /** Precio en la lista predeterminada (moneda de la lista). */
  price: decimalStr.refine(v => Number(v) >= 0, 'El precio no puede ser negativo').optional(),
});
/** `version` es obligatoria: el servidor rechaza la edición si el producto cambió desde la versión que vio la app. */
export const productUpdateData = productData.omit({ sku: true }).partial().extend({ version: z.number().int().min(1) });

const lineData = z.object({
  productId: uuid, quantity: decimalStr.refine(v => Number(v) > 0, 'La cantidad debe ser mayor que cero'),
  unitPrice: decimalStr.optional(), discountPct: decimalStr.refine(v => Number(v) >= 0 && Number(v) <= 100, '0–100').optional(),
  description: optText(500),
});
export const docData = z.object({
  /** Id del servidor o id local de un cliente creado sin conexión en el mismo dispositivo. */
  customerId: uuid,
  warehouseId: uuid.nullable().optional(), currencyId: uuid.optional(), exchangeRate: decimalStr.optional(),
  validUntil: date.nullable().optional(),
  paymentCondition: z.enum(['CASH', 'CREDIT']).optional(), creditDays: z.number().int().min(0).max(365).optional(),
  notes: optText(1000), reservesStock: z.boolean().optional(),
  lines: z.array(lineData).min(1, 'Se requiere al menos una línea'),
});
export const quoteCreateData = docData.extend({ send: z.boolean().optional() });
export const quoteUpdateData = docData.partial().extend({ send: z.boolean().optional() });
export const orderCreateData = docData.extend({ sourceQuoteId: uuid.optional() });

export type OpStatus = 'APPLIED' | 'DUPLICATE' | 'REJECTED' | 'NEEDS_REVIEW' | 'BLOCKED' | 'RETRY';
export type OpResult = {
  clientOpId: string;
  /** DUPLICATE = ya estaba aplicada (mismo resultado). BLOCKED/RETRY: no se guardó nada; la app conserva la operación pendiente. */
  status: OpStatus;
  errorCode?: string; message?: string;
  serverId?: string; serverNumber?: string | null; serverStatus?: string;
  /** El cliente ya existía por RIF y se vinculó al existente. */
  linked?: boolean;
};
