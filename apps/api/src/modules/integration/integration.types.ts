import { z } from 'zod';
import { uuid } from '@erp/contracts';

/** Sistemas externos con los que el ERP intercambia datos. */
export const SYSTEMS = ['SAINT'] as const;
export const connectorId = z.string().regex(/^[a-z0-9-]{2,40}$/, 'solo minúsculas, números y guiones (2 a 40)');

/** Entidades expuestas en /integration/:entity (plural en la URL). */
export const ENTITY_PATHS = { customers: 'customer', suppliers: 'supplier', products: 'product' } as const;
export type EntityPath = keyof typeof ENTITY_PATHS;
export const entityPath = z.enum(['customers', 'suppliers', 'products']);

export const upsertItemSchema = z.object({
  externalKey: z.string().trim().min(1).max(120),
  /** Número de documento del otro sistema (p. ej. el de una factura). */
  externalNumber: z.string().trim().max(60).nullable().optional(),
  /** Dónde nació el registro. */
  origin: z.enum(['SAINT', 'ERP']),
  /** Huella del contenido que envía el integrador: si coincide con la última aplicada, no se escribe nada. */
  hash: z.string().min(8).max(128),
  /** Bloqueo optimista: si el registro del ERP cambió después, se rechaza con VERSION_CONFLICT. */
  expectedVersion: z.number().int().min(1).optional(),
  data: z.record(z.unknown()),
});

export const upsertBatchSchema = z.object({
  system: z.enum(SYSTEMS).default('SAINT'),
  connector: connectorId,
  /**
   * Qué hacer cuando el registro ya existe en el ERP por su clave natural (RIF) pero sin referencia externa:
   * REF_ONLY solo crea la referencia (no toca datos); REF_AND_UPDATE además aplica los datos recibidos.
   */
  linkMode: z.enum(['REF_ONLY', 'REF_AND_UPDATE']).default('REF_ONLY'),
  items: z.array(upsertItemSchema).min(1).max(200),
});
export type UpsertBatch = z.infer<typeof upsertBatchSchema>;
export type UpsertItem = z.infer<typeof upsertItemSchema>;

export const getBatchSchema = z.object({
  system: z.enum(SYSTEMS).default('SAINT'),
  ids: z.array(uuid).max(200).optional(),
  externalKeys: z.array(z.string().min(1).max(120)).max(200).optional(),
}).refine(v => (v.ids?.length ?? 0) + (v.externalKeys?.length ?? 0) > 0, 'Indique ids o externalKeys');

export const refsQuery = z.object({
  entity: z.enum(['customers', 'suppliers', 'products', 'price_lists']),
  system: z.enum(SYSTEMS).default('SAINT'),
  externalKey: z.string().optional(),
  entityId: uuid.optional(),
});

export const eventsQuery = z.object({
  after: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(1000).default(500),
  entity: z.string().optional(),
  /** Por defecto se omiten los eventos que provocó el propio integrador (evita rebotes). */
  includeIntegration: z.coerce.boolean().default(false),
});

export type ItemResult = {
  externalKey: string;
  result: 'CREATED' | 'UPDATED' | 'UNCHANGED' | 'LINKED' | 'REJECTED';
  erpId?: string;
  version?: number;
  code?: string;
  errors?: Array<{ field?: string; code: string; message?: string }>;
  existingErpId?: string;
  otherExternalKey?: string;
  warnings?: string[];
};

/** Alta idempotente de las listas de precio de Saint («Precio 1» a «Precio 3» y, si usa empaque, las «por unidad»). */
export const saintPriceListsSchema = z.object({
  system: z.enum(SYSTEMS).default('SAINT'),
  connector: connectorId,
  /** Moneda de las listas; si no se indica, la moneda base de la empresa. */
  currencyId: uuid.optional(),
  /** Crea también SAINT-P1U a SAINT-P3U (precio por unidad cuando el producto usa empaque). */
  withUnitLists: z.boolean().default(false),
});
