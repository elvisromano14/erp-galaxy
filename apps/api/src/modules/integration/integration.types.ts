import { z } from 'zod';
import { uuid } from '@erp/contracts';

/** Sistemas externos con los que el ERP intercambia datos. */
export const SYSTEMS = ['SAINT'] as const;
export const connectorId = z.string().regex(/^[a-z0-9-]{2,40}$/, 'solo minúsculas, números y guiones (2 a 40)');

/** Entidades expuestas en /integration/:entity (plural en la URL). */
export const ENTITY_PATHS = { customers: 'customer', suppliers: 'supplier', products: 'product', zones: 'zone', sellers: 'seller', warehouses: 'warehouse', categories: 'category' } as const;
export type EntityPath = keyof typeof ENTITY_PATHS;
export const entityPath = z.enum(['customers', 'suppliers', 'products', 'zones', 'sellers', 'warehouses', 'categories']);

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

// ───────────────────────── conexiones a Saint y monitoreo ─────────────────────────
/** Flujos Saint → ERP que el integrador sabe ejecutar. */
export const STREAMS = ['zones', 'sellers', 'warehouses', 'categories', 'customers', 'products'] as const;
export const OUTBOUND_STREAMS = ['customers'] as const;

const host = z.string().trim().min(1).max(255).regex(/^[A-Za-z0-9._\-\\]+$/, 'Solo nombre de servidor o IP (sin espacios ni caracteres especiales)');
const dbName = z.string().trim().min(1).max(128);

const connectionBase = z.object({
  connectorId,
  name: z.string().trim().min(2).max(80),
  host,
  port: z.number().int().min(1).max(65535).default(1433),
  databaseName: dbName,
  username: z.string().trim().min(1).max(128),
  encrypt: z.boolean().default(false),
  trustServerCertificate: z.boolean().default(true),
  mode: z.enum(['READ_ONLY', 'READ_WRITE']).default('READ_ONLY'),
  allowedWriteDatabases: z.array(dbName).max(10).default([]),
  pollIntervalSec: z.number().int().min(5).max(3600).default(30),
  streams: z.array(z.enum(STREAMS)).default(['customers']),
  outbound: z.array(z.enum(OUTBOUND_STREAMS)).default([]),
  priceCurrency: z.string().regex(/^[A-Z]{3}$/).default('USD'),
  enabled: z.boolean().default(true),
});

/** Reglas entre campos: escribir en Saint exige modo de escritura y una base permitida. */
const connectionRules = <T extends { mode: string; allowedWriteDatabases: string[]; outbound: string[]; databaseName: string }>(v: T, ctx: z.RefinementCtx) => {
  if (v.mode === 'READ_ONLY' && v.outbound.length) ctx.addIssue({ code: 'custom', path: ['outbound'], message: 'Los flujos ERP → Saint exigen el modo READ_WRITE' });
  if (v.mode === 'READ_WRITE' && !v.allowedWriteDatabases.includes(v.databaseName)) ctx.addIssue({ code: 'custom', path: ['allowedWriteDatabases'], message: 'Incluya la base de datos en las bases permitidas para escribir' });
};

export const createConnectionSchema = connectionBase.extend({ password: z.string().min(1).max(256) }).superRefine(connectionRules);
export const updateConnectionSchema = connectionBase.omit({ connectorId: true }).partial().extend({ password: z.string().min(1).max(256).optional(), version: z.number().int().min(1).optional() });

export const testResultSchema = z.object({
  ok: z.boolean(),
  message: z.string().max(1000),
  latencyMs: z.number().int().min(0).optional(),
  databases: z.array(z.string().max(128)).max(200).default([]),
  schema: z.record(z.unknown()).optional(),
});

export const reportSchema = z.object({
  connectorId,
  runs: z.array(z.object({
    stream: z.string().min(1).max(60), startedAt: z.string().datetime(), finishedAt: z.string().datetime().nullable().optional(),
    rowsRead: z.number().int().min(0), rowsApplied: z.number().int().min(0), rowsFailed: z.number().int().min(0), error: z.string().max(2000).nullable().optional(),
  })).max(200).default([]),
  conflicts: z.array(z.object({
    op: z.enum(['OPEN', 'RESOLVED']), entity: z.string().min(1).max(40), saintKey: z.string().max(200).default(''), erpId: uuid.nullable().optional(),
    kind: z.string().min(1).max(80), detail: z.unknown().optional(),
  })).max(500).default([]),
});

export const conflictsQuery = z.object({
  status: z.enum(['OPEN', 'RESOLVED', 'ACKNOWLEDGED']).optional(),
  connectorId: connectorId.optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export const runsQuery = z.object({ connectorId: connectorId.optional(), limit: z.coerce.number().int().min(1).max(200).default(50) });
export const conflictStatusSchema = z.object({ status: z.enum(['OPEN', 'ACKNOWLEDGED']), note: z.string().trim().max(500).optional() });
