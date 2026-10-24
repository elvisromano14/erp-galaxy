import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { formatRif, isValidRif, normalizeRif } from '@erp/domain';
import { AuditService } from '../../common/audit/audit.service';
import { PermissionsService } from '../../common/auth/permissions.service';
import { PrismaService } from '../../common/db/prisma.service';
import { getStore } from '../../common/db/tenant-context';
import { BusinessRuleException } from '../../common/errors/errors';
import { CATALOGS, SPECIAL_TAXPAYER_IVA_RETENTION } from '../catalogs/catalogs.config';
import { createProductSchema, ProductsService } from '../products/products.service';
import { IntegrationEventsService } from './integration-events.service';
import { ENTITY_PATHS, EntityPath, ItemResult, saintPriceListsSchema, UpsertBatch, UpsertItem } from './integration.types';
import { z } from 'zod';

type Row = { id: string; version: number; isActive: boolean; deletedAt?: Date | null; [k: string]: any };
type ZodLike = { safeParse(v: unknown): { success: true; data: Record<string, any> } | { success: false; error: { issues: Array<{ path: (string | number)[]; code: string; message: string }> } } };

/** Cómo se lee, crea y actualiza cada entidad desde la integración (siempre reutilizando las reglas del ERP). */
interface Handler {
  entity: string;
  path: EntityPath;
  permissions: { create: string; update: string; read: string };
  schema: ZodLike;
  /** El servicio de la entidad ya emite sus eventos de integración (no se duplican aquí). */
  ownEvents: boolean;
  prepare(input: Record<string, any>): { data: Record<string, any>; warnings: string[] };
  findNatural(data: Record<string, any>): Promise<Row | null>;
  load(id: string): Promise<Row | null>;
  create(data: Record<string, any>): Promise<Row>;
  update(id: string, data: Record<string, any>): Promise<Row>;
  serialize?(row: Row): Promise<unknown>;
}

class Rejected extends Error {
  constructor(readonly code: string, message: string, readonly extra: Partial<ItemResult> = {}) { super(message); }
}

/**
 * API de integración (Saint ↔ ERP). Todo pasa por la transacción de la petición (RLS por empresa) y cada elemento
 * de un lote va en su propio punto de guardado: un error en uno no tumba a los demás.
 */
@Injectable()
export class IntegrationService {
  private readonly handlers: Record<EntityPath, Handler>;

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly events: IntegrationEventsService,
    private readonly perms: PermissionsService,
    private readonly products: ProductsService,
  ) {
    this.handlers = {
      customers: this.partyHandler('customers'), suppliers: this.partyHandler('suppliers'), products: this.productHandler(),
      zones: this.simpleHandler('zones'), sellers: this.simpleHandler('sellers'), warehouses: this.simpleHandler('warehouses'), categories: this.simpleHandler('categories'),
    };
  }

  handler(path: EntityPath): Handler { return this.handlers[path]; }

  // ───────────────────────── manejadores por entidad ─────────────────────────
  private permsFor(path: EntityPath) { return { create: `admin:${path}:create`, update: `admin:${path}:update`, read: `admin:${path}:read` }; }

  private partyHandler(path: 'customers' | 'suppliers'): Handler {
    const entity = ENTITY_PATHS[path] as 'customer' | 'supplier';
    const model = () => (this.prisma.tx as any)[entity];
    const cfg = CATALOGS.find(c => c.path === path)!;
    return {
      entity, path, permissions: this.permsFor(path), schema: cfg.create as ZodLike, ownEvents: false,
      /**
       * Un RIF que no valida (pasaporte, cédula sin dígito verificador…) NO se rechaza: entra como PENDING con el
       * texto normalizado y administración lo completa.
       */
      prepare: input => {
        const data = { ...input }; const warnings: string[] = [];
        if (isValidRif(data.rif)) data.rif = formatRif(data.rif);
        else {
          data.rif = normalizeRif(String(data.rif));
          data.validationStatus = 'PENDING';
          warnings.push('RIF no válido: el registro queda PENDING hasta que administración lo confirme');
        }
        if (data.isSpecialTaxpayer === true && data.retentionIvaPct === undefined) data.retentionIvaPct = SPECIAL_TAXPAYER_IVA_RETENTION;
        return { data, warnings };
      },
      findNatural: data => model().findUnique({ where: { companyId_rif: { companyId: this.prisma.companyId, rif: data.rif } } }),
      load: id => model().findUnique({ where: { id } }),
      create: data => model().create({ data: { ...data, companyId: this.prisma.companyId } }),
      // La validación del RIF es del ERP tras la creación: solo se reevalúa si el RIF cambió.
      update: async (id, data) => {
        const d = { ...data };
        const current = await model().findUnique({ where: { id }, select: { rif: true } });
        if (current && current.rif === d.rif) delete d.validationStatus;
        else if (isValidRif(d.rif)) d.validationStatus = 'VALIDATED';
        return model().update({ where: { id }, data: { ...d, version: { increment: 1 } } });
      },
    };
  }

  /** Catálogos simples (zonas, vendedores, depósitos, categorías): clave natural = código. */
  private simpleHandler(path: 'zones' | 'sellers' | 'warehouses' | 'categories'): Handler {
    const entity = ENTITY_PATHS[path];
    const model = () => (this.prisma.tx as any)[entity];
    const cfg = CATALOGS.find(c => c.path === path)!;
    return {
      entity, path, permissions: this.permsFor(path), schema: cfg.create as ZodLike, ownEvents: false,
      prepare: input => ({ data: { ...input, code: String(input.code).trim() }, warnings: [] }),
      findNatural: data => model().findUnique({ where: { companyId_code: { companyId: this.prisma.companyId, code: data.code } } }),
      load: id => model().findUnique({ where: { id } }),
      create: data => model().create({ data: { ...data, companyId: this.prisma.companyId } }),
      update: (id, data) => model().update({ where: { id }, data }),
    };
  }

  private productHandler(): Handler {
    const tx = () => this.prisma.tx;
    return {
      entity: 'product', path: 'products', permissions: this.permsFor('products'), schema: createProductSchema as unknown as ZodLike, ownEvents: true,
      prepare: input => ({ data: { ...input, sku: String(input.sku).trim() }, warnings: [] }),
      findNatural: data => tx().product.findUnique({ where: { companyId_sku: { companyId: this.prisma.companyId, sku: data.sku } } }) as Promise<Row | null>,
      load: id => tx().product.findUnique({ where: { id } }) as Promise<Row | null>,
      create: data => this.products.create(data as z.infer<typeof createProductSchema>) as unknown as Promise<Row>,
      // El historial de precios no se llena de repeticiones: solo se agrega un precio si cambió frente al vigente.
      update: async (id, data) => {
        const current = new Map(((await this.products.get(id)).prices as Array<{ priceListId: string; price: Prisma.Decimal }>).map(p => [p.priceListId, p.price.toString()]));
        const prices = ((data.prices ?? []) as Array<{ priceListId: string; price: string }>).filter(p => current.get(p.priceListId) === undefined || Number(current.get(p.priceListId)) !== Number(p.price));
        return this.products.update(id, { ...data, prices }) as unknown as Promise<Row>;
      },
      serialize: row => this.products.get(row.id),
    };
  }

  // ───────────────────────── interruptor ─────────────────────────
  /** Interruptor por empresa: `integration.enabled = false` pausa toda la integración. */
  async isEnabled(): Promise<boolean> {
    const s = await this.prisma.tx.setting.findUnique({ where: { companyId_key: { companyId: this.prisma.companyId, key: 'integration.enabled' } } });
    return !(s && s.value === false);
  }

  async assertEnabled() {
    const companyId = this.prisma.companyId;
    const s = await this.prisma.tx.setting.findUnique({ where: { companyId_key: { companyId, key: 'integration.enabled' } } });
    if (s && s.value === false) throw new BusinessRuleException('La integración está pausada para esta empresa', 'INTEGRATION_DISABLED');
  }

  async setEnabled(enabled: boolean) {
    const companyId = this.prisma.companyId;
    await this.prisma.tx.setting.upsert({
      where: { companyId_key: { companyId, key: 'integration.enabled' } },
      update: { value: enabled }, create: { companyId, key: 'integration.enabled', value: enabled },
    });
    await this.audit.log('integration', undefined, enabled ? 'RESUME' : 'PAUSE');
    return { enabled };
  }

  // ───────────────────────── upsert por lote ─────────────────────────
  async upsertBatch(path: EntityPath, body: UpsertBatch) {
    await this.assertEnabled();
    const h = this.handler(path);
    const have = new Set(await this.havePermissions());
    const tx = this.prisma.tx;
    const seen = new Set<string>();
    const results: ItemResult[] = [];
    for (let i = 0; i < body.items.length; i++) {
      const item = body.items[i];
      if (seen.has(item.externalKey)) { results.push({ externalKey: item.externalKey, result: 'REJECTED', code: 'DUPLICATE_IN_BATCH', errors: [{ code: 'DUPLICATE_IN_BATCH', message: 'La clave externa se repite en el lote' }] }); continue; }
      seen.add(item.externalKey);
      const sp = `sp_item_${i}`;
      await tx.$executeRawUnsafe(`SAVEPOINT ${sp}`);
      try {
        results.push(await this.applyItem(h, body, item, have));
        await tx.$executeRawUnsafe(`RELEASE SAVEPOINT ${sp}`);
      } catch (e) {
        await tx.$executeRawUnsafe(`ROLLBACK TO SAVEPOINT ${sp}`);
        results.push(this.reject(item.externalKey, e));
      }
    }
    const count = (r: ItemResult['result']) => results.filter(x => x.result === r).length;
    return {
      summary: { received: results.length, created: count('CREATED'), updated: count('UPDATED'), unchanged: count('UNCHANGED'), linked: count('LINKED'), rejected: count('REJECTED') },
      results,
    };
  }

  private async applyItem(h: Handler, b: UpsertBatch, item: UpsertItem, have: Set<string>): Promise<ItemResult> {
    const tx = this.prisma.tx;
    const companyId = this.prisma.companyId;
    const parsed = h.schema.safeParse(item.data);
    if (!parsed.success) {
      throw new Rejected('VALIDATION_ERROR', 'Datos inválidos', { errors: parsed.error.issues.map(i => ({ field: i.path.join('.'), code: i.code, message: i.message })) });
    }
    const { data, warnings } = h.prepare(parsed.data);
    const refKey = { system: b.system, entity: h.entity, externalKey: item.externalKey };
    const ref = await tx.externalRef.findFirst({ where: refKey });

    // 1) Ya vinculado → actualizar (o «sin cambios»)
    if (ref) {
      this.need(have, h.permissions.update);
      const row = await h.load(ref.entityId);
      if (!row) throw new Rejected('REF_DANGLING', 'La referencia apunta a un registro que ya no existe', { erpId: ref.entityId });
      if (item.expectedVersion !== undefined && item.expectedVersion !== row.version) {
        throw new Rejected('VERSION_CONFLICT', `El registro del ERP cambió (versión ${row.version})`, { erpId: row.id, version: row.version });
      }
      if (ref.contentHash === item.hash) return { externalKey: item.externalKey, result: 'UNCHANGED', erpId: row.id, version: row.version, warnings };
      const wasActive = row.isActive;
      const updated = await h.update(row.id, data);
      await tx.externalRef.update({ where: { id: ref.id }, data: { contentHash: item.hash, externalNumber: item.externalNumber ?? ref.externalNumber, syncedAt: new Date(), connector: b.connector } });
      if (!h.ownEvents) await this.events.emit({ entity: h.entity, entityId: row.id, op: wasActive && updated.isActive === false ? 'DEACTIVATE' : 'UPDATE', version: updated.version });
      await this.audit.log(h.entity, row.id, 'UPDATE', { source: 'integration', connector: b.connector, externalKey: item.externalKey });
      return { externalKey: item.externalKey, result: 'UPDATED', erpId: row.id, version: updated.version, warnings };
    }

    // 2) Sin referencia: ¿existe ya por clave natural (RIF o SKU)?
    const existing = await h.findNatural(data);
    if (existing) {
      const other = await tx.externalRef.findFirst({ where: { system: b.system, entity: h.entity, entityId: existing.id } });
      if (other) throw new Rejected('DUPLICATE_NATURAL_KEY', 'La clave natural ya está vinculada a otra clave externa', { existingErpId: existing.id, otherExternalKey: other.externalKey });
      if (existing.deletedAt) throw new Rejected('NATURAL_KEY_DELETED', 'La clave natural pertenece a un registro dado de baja en el ERP', { existingErpId: existing.id });
      this.need(have, h.permissions.update);
      let version = existing.version;
      let contentHash: string | null = null;
      if (b.linkMode === 'REF_AND_UPDATE') {
        const updated = await h.update(existing.id, data);
        version = updated.version; contentHash = item.hash;
        if (!h.ownEvents) await this.events.emit({ entity: h.entity, entityId: existing.id, op: 'UPDATE', version });
      }
      await tx.externalRef.create({ data: { companyId, ...refKey, entityId: existing.id, connector: b.connector, externalNumber: item.externalNumber ?? null, origin: item.origin, contentHash } });
      await this.audit.log(h.entity, existing.id, 'LINK', { source: 'integration', connector: b.connector, externalKey: item.externalKey, linkMode: b.linkMode });
      return { externalKey: item.externalKey, result: 'LINKED', erpId: existing.id, version, warnings };
    }

    // 3) Nuevo
    this.need(have, h.permissions.create);
    const created = await h.create(data);
    await tx.externalRef.create({ data: { companyId, ...refKey, entityId: created.id, connector: b.connector, externalNumber: item.externalNumber ?? null, origin: item.origin, contentHash: item.hash } });
    if (!h.ownEvents) await this.events.emit({ entity: h.entity, entityId: created.id, op: 'CREATE', version: created.version });
    await this.audit.log(h.entity, created.id, 'CREATE', { source: 'integration', connector: b.connector, externalKey: item.externalKey });
    return { externalKey: item.externalKey, result: 'CREATED', erpId: created.id, version: created.version, warnings };
  }

  private reject(externalKey: string, e: unknown): ItemResult {
    if (e instanceof Rejected) return { externalKey, result: 'REJECTED', code: e.code, errors: e.extra.errors ?? [{ code: e.code, message: e.message }], ...pick(e.extra, ['erpId', 'version', 'existingErpId', 'otherExternalKey']) };
    if (e instanceof Prisma.PrismaClientKnownRequestError) {
      if (e.code === 'P2002') return { externalKey, result: 'REJECTED', code: 'CONFLICT', errors: [{ code: 'CONFLICT', message: 'Otro registro ya usa ese valor único (reintente: puede ser una carrera)' }] };
      if (e.code === 'P2003') return { externalKey, result: 'REJECTED', code: 'INVALID_REFERENCE', errors: [{ code: 'INVALID_REFERENCE', message: 'Referencia a una entidad inexistente (vendedor, zona, lista de precio, unidad, impuesto…)' }] };
    }
    const r = (e as { response?: { message?: string; error?: string; details?: Array<{ field?: string; code: string; message?: string }> } }).response;
    const code = r?.error ?? 'ERROR';
    return { externalKey, result: 'REJECTED', code, errors: r?.details?.length ? r.details : [{ code, message: r?.message ?? (e as Error).message }] };
  }

  private need(have: Set<string>, permission: string) {
    if (!have.has(permission)) throw new Rejected('FORBIDDEN_ENTITY', `La cuenta no tiene el permiso ${permission}`);
  }

  private async havePermissions(): Promise<string[]> {
    const s = getStore();
    const user = await this.prisma.db.user.findUnique({ where: { id: s.userId! }, select: { isSuperAdmin: true } });
    if (user?.isSuperAdmin) return Object.values(this.handlers).flatMap(h => Object.values(h.permissions)).concat('admin:price-lists:create');
    return this.perms.forUser(s.userId!, this.prisma.companyId);
  }

  // ───────────────────────── listas de precio de Saint (A7) ─────────────────────────
  /**
   * Crea, de forma idempotente, las listas «Precio 1» a «Precio 3» de Saint (y las «por unidad» si la empresa usa
   * empaque), cada una registrada como referencia externa (price_list / P1…) para que el integrador las halle sin
   * buscar por nombre. No toca la lista predeterminada de la empresa: solo marca SAINT-P1 si no hay ninguna.
   */
  async ensureSaintPriceLists(b: z.infer<typeof saintPriceListsSchema>) {
    await this.assertEnabled();
    const have = new Set(await this.havePermissions());
    if (!have.has('admin:price-lists:create')) throw new BusinessRuleException('La cuenta no tiene el permiso admin:price-lists:create', 'FORBIDDEN_ENTITY');
    const tx = this.prisma.tx;
    const companyId = this.prisma.companyId;
    const company = await tx.company.findUniqueOrThrow({ where: { id: companyId }, select: { baseCurrencyId: true } });
    const currencyId = b.currencyId ?? company.baseCurrencyId;
    if (!(await tx.currency.findUnique({ where: { id: currencyId } }))) throw new BusinessRuleException('Moneda inexistente', 'CURRENCY_NOT_FOUND', [{ field: 'currencyId', code: 'NOT_FOUND' }]);
    const keys = [...['P1', 'P2', 'P3'], ...(b.withUnitLists ? ['P1U', 'P2U', 'P3U'] : [])];
    let hasDefault = !!(await tx.priceList.findFirst({ where: { deletedAt: null, isDefault: true } }));
    const lists: Array<{ key: string; code: string; erpId: string; currencyId: string; status: 'CREATED' | 'LINKED' | 'EXISTING'; warnings?: string[] }> = [];
    for (const key of keys) {
      const code = `SAINT-${key}`;
      const refKey = { system: b.system, entity: 'price_list', externalKey: key };
      const ref = await tx.externalRef.findFirst({ where: refKey });
      let list = ref ? await tx.priceList.findUnique({ where: { id: ref.entityId } }) : null;
      let status: 'CREATED' | 'LINKED' | 'EXISTING' = 'EXISTING';
      if (!list) {
        list = await tx.priceList.findUnique({ where: { companyId_code: { companyId, code } } });
        if (list) status = 'LINKED';
        else {
          const n = key.slice(1, 2);
          const isDefault = key === 'P1' && !hasDefault;
          list = await tx.priceList.create({ data: { companyId, code, name: key.endsWith('U') ? `Precio ${n} por unidad (Saint)` : `Precio ${n} (Saint)`, currencyId, isDefault } });
          if (isDefault) hasDefault = true;
          status = 'CREATED';
          await this.audit.log('price_list', list.id, 'CREATE', { source: 'integration', connector: b.connector, key });
        }
        if (!ref) await tx.externalRef.create({ data: { companyId, ...refKey, entityId: list.id, connector: b.connector, origin: 'ERP' } });
      }
      lists.push({ key, code: list.code, erpId: list.id, currencyId: list.currencyId, status, ...(list.currencyId !== currencyId ? { warnings: ['La lista ya existía con otra moneda; no se modificó'] } : {}) });
    }
    return { currencyId, lists };
  }

  // ───────────────────────── consultas ─────────────────────────
  async getBatch(path: EntityPath, b: { system: 'SAINT'; ids?: string[]; externalKeys?: string[] }) {
    await this.assertEnabled();
    const h = this.handler(path);
    const tx = this.prisma.tx;
    const model = (tx as any)[h.entity];
    const ids = new Set(b.ids ?? []);
    const byKey = new Map<string, string>();
    if (b.externalKeys?.length) {
      const refs = await tx.externalRef.findMany({ where: { system: b.system, entity: h.entity, externalKey: { in: b.externalKeys } } });
      for (const r of refs) { ids.add(r.entityId); byKey.set(r.externalKey, r.entityId); }
    }
    const rows: Row[] = ids.size ? await model.findMany({ where: { id: { in: [...ids] } } }) : [];
    const refs = rows.length ? await tx.externalRef.findMany({ where: { entity: h.entity, entityId: { in: rows.map(r => r.id) } } }) : [];
    const items = [];
    for (const r of rows) {
      const base = h.serialize ? await h.serialize(r) : r;
      items.push({ ...(base as object), externalRefs: refs.filter(x => x.entityId === r.id).map(x => ({ system: x.system, connector: x.connector, key: x.externalKey, number: x.externalNumber, origin: x.origin })) });
    }
    return { items, notFound: (b.externalKeys ?? []).filter(k => !byKey.has(k)) };
  }

  async refs(q: { entity: EntityPath | 'price_lists'; system: 'SAINT'; externalKey?: string; entityId?: string }) {
    await this.assertEnabled();
    const entity = q.entity === 'price_lists' ? 'price_list' : ENTITY_PATHS[q.entity];
    const rows = await this.prisma.tx.externalRef.findMany({
      where: { entity, system: q.system, ...(q.externalKey ? { externalKey: q.externalKey } : {}), ...(q.entityId ? { entityId: q.entityId } : {}) },
      take: 200, orderBy: { createdAt: 'asc' },
    });
    return rows.map(r => ({ entityId: r.entityId, system: r.system, connector: r.connector, externalKey: r.externalKey, externalNumber: r.externalNumber, origin: r.origin, syncedAt: r.syncedAt }));
  }

  async listEvents(q: { after: number; limit: number; entity?: string; includeIntegration: boolean }) {
    await this.assertEnabled();
    const scanned = await this.prisma.tx.integrationEvent.findMany({
      where: { seq: { gt: BigInt(q.after) }, ...(q.entity ? { entity: q.entity } : {}) }, orderBy: { seq: 'asc' }, take: q.limit,
    });
    const events = scanned.filter(e => q.includeIntegration || e.origin !== 'INTEGRATION')
      .map(e => ({ seq: Number(e.seq), entity: e.entity, entityId: e.entityId, op: e.op, version: e.version, origin: e.origin, summary: e.summary, createdAt: e.createdAt }));
    // El cursor avanza sobre todo lo revisado (incluidos los eventos del propio integrador que se omiten).
    return { events, nextCursor: scanned.length ? Number(scanned[scanned.length - 1].seq) : q.after };
  }

  async status() {
    const tx = this.prisma.tx;
    const companyId = this.prisma.companyId;
    const [setting, refsByEntity, pendingCustomers, pendingSuppliers, last, accounts] = await Promise.all([
      tx.setting.findUnique({ where: { companyId_key: { companyId, key: 'integration.enabled' } } }),
      tx.externalRef.groupBy({ by: ['entity', 'system'], _count: { _all: true } }),
      tx.customer.count({ where: { validationStatus: 'PENDING', deletedAt: null } }),
      tx.supplier.count({ where: { validationStatus: 'PENDING', deletedAt: null } }),
      tx.integrationEvent.findFirst({ orderBy: { seq: 'desc' } }),
      this.prisma.db.serviceCredential.findMany({ where: { companyId }, select: { name: true, clientId: true, lastUsedAt: true, revokedAt: true } }),
    ]);
    return {
      enabled: !(setting && setting.value === false),
      refs: refsByEntity.map(r => ({ entity: r.entity, system: r.system, count: r._count._all })),
      pending: { customers: pendingCustomers, suppliers: pendingSuppliers },
      lastEvent: last ? { seq: Number(last.seq), createdAt: last.createdAt } : null,
      serviceAccounts: accounts,
    };
  }
}

function pick<T extends object, K extends keyof T>(o: T, keys: K[]): Pick<T, K> {
  const out = {} as Pick<T, K>;
  for (const k of keys) if (o[k] !== undefined) out[k] = o[k];
  return out;
}
