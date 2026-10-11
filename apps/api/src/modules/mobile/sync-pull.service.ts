import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../common/db/prisma.service';
import { AuthUser } from '../../common/auth/decorators';
import { BusinessRuleException } from '../../common/errors/errors';
import { DevicesService } from './devices.service';
import { PullEntity } from './mobile.types';

export interface PullPage { entity: PullEntity; items: unknown[]; nextCursor: string | null; hasMore: boolean; fullRefresh: boolean; serverTime: string }

const SIXTY_DAYS = 60;
type Row = Record<string, any> & { id: string; _ts: string };

/**
 * Lectura incremental para la app móvil. Las tablas grandes (clientes, productos, precios, existencias, documentos) se
 * paginan con un cursor `(marca de tiempo con microsegundos, id)`; los catálogos pequeños se envían completos
 * (`fullRefresh`: la app reemplaza la tabla local). Las filas borradas se envían con `deletedAt` (lápidas).
 */
@Injectable()
export class SyncPullService {
  constructor(private readonly prisma: PrismaService, private readonly devices: DevicesService) {}

  async pull(user: AuthUser, q: { entity: PullEntity; cursor?: string; limit: number; overlapSeconds: number }): Promise<PullPage> {
    const serverTime = new Date().toISOString();
    const done = (items: unknown[], extra: Partial<PullPage> = {}): PullPage => ({ entity: q.entity, items, nextCursor: null, hasMore: false, fullRefresh: true, serverTime, ...extra });
    switch (q.entity) {
      case 'app_settings': return done([await this.settings(user)]);
      case 'taxes': return done((await this.prisma.db.tax.findMany({ orderBy: [{ code: 'asc' }, { validFrom: 'asc' }] })).map(t => ({
        id: t.id, code: t.code, name: t.name, kind: t.kind, rate: t.rate, validFrom: t.validFrom, validTo: t.validTo, isActive: t.isActive, deletedAt: t.deletedAt })));
      case 'price_lists': return done((await this.prisma.db.priceList.findMany({ orderBy: { code: 'asc' } })).map(p => ({
        id: p.id, code: p.code, name: p.name, currencyId: p.currencyId, isDefault: p.isDefault, deletedAt: p.deletedAt })));
      case 'warehouses': return done((await this.prisma.db.warehouse.findMany({ orderBy: { code: 'asc' } })).map(w => ({
        id: w.id, code: w.code, name: w.name, isActive: w.isActive, deletedAt: w.deletedAt })));
      case 'exchange_rates': {
        const since = new Date(Date.now() - 120 * 86_400_000);
        const rows = await this.prisma.db.exchangeRate.findMany({ where: { date: { gte: since }, OR: [{ companyId: null }, { companyId: this.prisma.companyId }] }, orderBy: [{ date: 'desc' }, { createdAt: 'desc' }] });
        return done(rows.map(r => ({ id: r.id, currencyId: r.currencyId, rate: r.rate, date: r.date, source: r.source, companyOnly: r.companyId !== null })));
      }
      case 'customers': return this.customers(user, q);
      case 'products': return this.products(q);
      case 'product_prices': return this.prices(q);
      case 'stock_snapshots': return this.stock(q);
      case 'my_documents': return this.documents(user, q);
    }
  }

  // ───────────────── ajustes y políticas del vendedor ─────────────────
  private async settings(user: AuthUser) {
    const tx = this.prisma.db;
    const [company, seller, all] = await Promise.all([
      tx.company.findUniqueOrThrow({ where: { id: this.prisma.companyId } }),
      this.devices.sellerOf(user.userId), this.devices.canSeeAll(user),
    ]);
    const warehouse = await tx.warehouse.findFirst({ where: { deletedAt: null, isActive: true }, orderBy: { code: 'asc' }, select: { id: true } });
    return {
      company: { id: company.id, rif: company.rif, legalName: company.legalName, tradeName: company.tradeName, baseCurrencyId: company.baseCurrencyId, valuationCurrencyId: company.valuationCurrencyId },
      seller: seller ? { id: seller.id, code: seller.code, name: seller.name } : null,
      sellerScope: all ? 'ALL' : 'OWN',
      defaultWarehouseId: warehouse?.id ?? null,
      allowPriceEdit: seller?.allowPriceEdit ?? false,
      maxDiscountPct: seller?.maxDiscountPct ?? 0,
      allowCustomerCreate: seller?.allowCustomerCreate ?? false,
      /** Política de precios al sincronizar: el servidor respeta el precio de la lista vigente (el pactado solo si el vendedor puede editarlo). */
      pricePolicy: 'SERVER_LIST',
    };
  }

  // ───────────────── paginación con cursor (marca de tiempo con microsegundos, id) ─────────────────
  private parseCursor(cursor?: string): { ts: string; id: string } | null {
    if (!cursor) return null;
    const i = cursor.lastIndexOf('|');
    if (i < 1) throw new BusinessRuleException('Cursor inválido', 'INVALID_CURSOR');
    return { ts: cursor.slice(0, i), id: cursor.slice(i + 1) };
  }

  /** Condición del cursor: avance estricto por (ts, id); con `overlapSeconds` (primera página) se relee una ventana hacia atrás. */
  private after(tsCol: string, cur: { ts: string; id: string } | null, overlap: number): Prisma.Sql {
    const col = Prisma.raw(tsCol);
    if (!cur) return Prisma.sql`TRUE`;
    if (overlap > 0) return Prisma.sql`${col} > ${cur.ts}::timestamptz - make_interval(secs => ${overlap}::double precision)`;
    return Prisma.sql`(${col}, id) > (${cur.ts}::timestamptz, ${cur.id}::uuid)`;
  }

  private async page<T extends { id: string; _ts: string }>(rows: T[], limit: number) {
    const hasMore = rows.length > limit;
    const items = hasMore ? rows.slice(0, limit) : rows;
    const last = items[items.length - 1];
    return { items, hasMore, nextCursor: last ? `${last._ts}|${last.id}` : null };
  }

  private async customers(user: AuthUser, q: { cursor?: string; limit: number; overlapSeconds: number }): Promise<PullPage> {
    const tx = this.prisma.db;
    const [seller, all] = await Promise.all([this.devices.sellerOf(user.userId), this.devices.canSeeAll(user)]);
    if (!seller && !all) throw new BusinessRuleException('Su usuario no está ligado a un vendedor', 'SELLER_REQUIRED');
    const scope = all ? Prisma.sql`TRUE` : Prisma.sql`(seller_id = ${seller!.id}::uuid OR (${seller!.zoneId}::uuid IS NOT NULL AND zone_id = ${seller!.zoneId}::uuid))`;
    const cur = this.parseCursor(q.cursor);
    const rows = await tx.$queryRaw<Row[]>`
      SELECT id, rif, legal_name, trade_name, person_type, is_special_taxpayer, retention_iva_pct, price_list_id, credit_limit, credit_days,
             seller_id, email, phone, address, is_active, validation_status, version, deleted_at, updated_at, updated_at::text AS _ts
      FROM customers WHERE ${scope} AND ${this.after('updated_at', cur, q.overlapSeconds)}
      ORDER BY updated_at, id LIMIT ${q.limit + 1}`;
    const { items, hasMore, nextCursor } = await this.page(rows, q.limit);
    // Saldo y vencido en la moneda base (Bs): instantánea indicativa al momento de la sincronización.
    const ids = items.map(r => r.id as string);
    const balances = ids.length ? await tx.$queryRaw<{ customer_id: string; balance: Prisma.Decimal; overdue: Prisma.Decimal }[]>`
      SELECT customer_id, COALESCE(SUM(balance * exchange_rate), 0) AS balance,
             COALESCE(SUM(CASE WHEN due_date < (now() AT TIME ZONE 'America/Caracas')::date THEN balance * exchange_rate ELSE 0 END), 0) AS overdue
      FROM receivable_entries WHERE customer_id = ANY(${ids}::uuid[]) AND status IN ('OPEN', 'PARTIALLY_PAID') GROUP BY customer_id` : [];
    const bal = new Map(balances.map(b => [b.customer_id, b]));
    return {
      entity: 'customers', nextCursor, hasMore, fullRefresh: false, serverTime: new Date().toISOString(),
      items: items.map(r => ({
        id: r.id, rif: r.rif, legalName: r.legal_name, tradeName: r.trade_name, personType: r.person_type, isSpecialTaxpayer: r.is_special_taxpayer,
        retentionIvaPct: r.retention_iva_pct, priceListId: r.price_list_id, creditLimit: r.credit_limit, creditDays: r.credit_days, sellerId: r.seller_id,
        email: r.email, phone: r.phone, address: r.address, isActive: r.is_active, validationStatus: r.validation_status, version: r.version, deletedAt: r.deleted_at,
        updatedAt: r.updated_at, balanceSnapshot: bal.get(r.id)?.balance ?? '0', overdueSnapshot: bal.get(r.id)?.overdue ?? '0',
      })),
    };
  }

  private async products(q: { cursor?: string; limit: number; overlapSeconds: number }): Promise<PullPage> {
    const tx = this.prisma.db;
    const cur = this.parseCursor(q.cursor);
    const rows = await tx.$queryRaw<Row[]>`
      SELECT id, sku, name, description, category_id, unit_id, tax_id, tracking_mode, has_expiry, is_service, is_active, version, deleted_at, updated_at, updated_at::text AS _ts
      FROM products WHERE ${this.after('updated_at', cur, q.overlapSeconds)} ORDER BY updated_at, id LIMIT ${q.limit + 1}`;
    const { items, hasMore, nextCursor } = await this.page(rows, q.limit);
    const ids = items.map(r => r.id as string);
    const [refs, barcodes, units, cats] = await Promise.all([
      tx.productReference.findMany({ where: { productId: { in: ids } }, select: { productId: true, refType: true, code: true, brand: true } }),
      tx.productBarcode.findMany({ where: { productId: { in: ids } }, select: { productId: true, barcode: true } }),
      tx.unit.findMany({ select: { id: true, code: true } }), tx.category.findMany({ select: { id: true, name: true } }),
    ]);
    const unit = new Map(units.map(u => [u.id, u.code])), cat = new Map(cats.map(c => [c.id, c.name]));
    const group = <T extends { productId: string }>(list: T[]) => { const m = new Map<string, T[]>(); for (const x of list) (m.get(x.productId) ?? m.set(x.productId, []).get(x.productId)!).push(x); return m; };
    const refMap = group(refs), barMap = group(barcodes);
    return {
      entity: 'products', nextCursor, hasMore, fullRefresh: false, serverTime: new Date().toISOString(),
      items: items.map(r => ({
        id: r.id, sku: r.sku, name: r.name, description: r.description, categoryName: r.category_id ? cat.get(r.category_id) ?? null : null,
        unitCode: unit.get(r.unit_id) ?? null, taxId: r.tax_id, trackingMode: r.tracking_mode, isService: r.is_service, isActive: r.is_active, version: r.version,
        deletedAt: r.deleted_at, updatedAt: r.updated_at,
        refs: (refMap.get(r.id) ?? []).map(x => ({ kind: x.refType, code: x.code, brand: x.brand })),
        barcodes: (barMap.get(r.id) ?? []).map(x => x.barcode),
      })),
    };
  }

  /** Precios: solo de lectura y sin costos. El precio vigente de cada (producto, lista) es el de mayor `validFrom` ≤ hoy: lo resuelve la app. */
  private async prices(q: { cursor?: string; limit: number; overlapSeconds: number }): Promise<PullPage> {
    const cur = this.parseCursor(q.cursor);
    const rows = await this.prisma.db.$queryRaw<Row[]>`
      SELECT id, product_id, price_list_id, price, valid_from, created_at::text AS _ts
      FROM product_prices WHERE ${this.after('created_at', cur, q.overlapSeconds)} ORDER BY created_at, id LIMIT ${q.limit + 1}`;
    const { items, hasMore, nextCursor } = await this.page(rows, q.limit);
    return {
      entity: 'product_prices', nextCursor, hasMore, fullRefresh: false, serverTime: new Date().toISOString(),
      items: items.map(r => ({ id: r.id, productId: r.product_id, priceListId: r.price_list_id, price: r.price, validFrom: r.valid_from })),
    };
  }

  private async stock(q: { cursor?: string; limit: number; overlapSeconds: number }): Promise<PullPage> {
    const cur = this.parseCursor(q.cursor);
    const rows = await this.prisma.db.$queryRaw<Row[]>`
      SELECT id, product_id, warehouse_id, quantity, reserved_qty, updated_at, updated_at::text AS _ts
      FROM inventory_stock WHERE ${this.after('updated_at', cur, q.overlapSeconds)} ORDER BY updated_at, id LIMIT ${q.limit + 1}`;
    const { items, hasMore, nextCursor } = await this.page(rows, q.limit);
    return {
      entity: 'stock_snapshots', nextCursor, hasMore, fullRefresh: false, serverTime: new Date().toISOString(),
      items: items.map(r => ({ id: r.id, productId: r.product_id, warehouseId: r.warehouse_id, quantity: r.quantity, reserved: r.reserved_qty, asOf: r.updated_at })),
    };
  }

  /** Documentos del vendedor (últimos 60 días): estado, número definitivo y facturación, tanto los creados en el móvil como en la web. */
  private async documents(user: AuthUser, q: { cursor?: string; limit: number; overlapSeconds: number }): Promise<PullPage> {
    const tx = this.prisma.db;
    const [seller, all] = await Promise.all([this.devices.sellerOf(user.userId), this.devices.canSeeAll(user)]);
    if (!seller && !all) throw new BusinessRuleException('Su usuario no está ligado a un vendedor', 'SELLER_REQUIRED');
    const scope = all ? Prisma.sql`TRUE` : Prisma.sql`seller_id = ${seller!.id}::uuid`;
    const cur = this.parseCursor(q.cursor);
    const rows = await tx.$queryRaw<Row[]>`
      SELECT id, doc_type, number, status, customer_id, seller_id, warehouse_id, currency_id, exchange_rate, doc_date, valid_until, payment_condition, credit_days,
             subtotal, tax_total, total, total_base, notes, reserves_stock, version, updated_at, updated_at::text AS _ts
      FROM sales_documents
      WHERE doc_type IN ('QUOTE', 'BUDGET', 'ORDER', 'INVOICE') AND ${scope} AND updated_at > now() - make_interval(days => ${SIXTY_DAYS}::int)
        AND ${this.after('updated_at', cur, q.overlapSeconds)}
      ORDER BY updated_at, id LIMIT ${q.limit + 1}`;
    const { items, hasMore, nextCursor } = await this.page(rows, q.limit);
    const ids = items.map(r => r.id as string);
    const [lines, links] = await Promise.all([
      tx.salesDocumentLine.findMany({ where: { documentId: { in: ids } }, orderBy: [{ documentId: 'asc' }, { lineNo: 'asc' }] }),
      tx.documentLink.findMany({ where: { childId: { in: ids } }, select: { childId: true, parentId: true, parentType: true } }),
    ]);
    const skus = new Map((await tx.product.findMany({ where: { id: { in: [...new Set(lines.map(l => l.productId))] } }, select: { id: true, sku: true } })).map(p => [p.id, p.sku]));
    return {
      entity: 'my_documents', nextCursor, hasMore, fullRefresh: false, serverTime: new Date().toISOString(),
      items: items.map(r => ({
        id: r.id, docType: r.doc_type, number: r.number, status: r.status, customerId: r.customer_id, sellerId: r.seller_id, warehouseId: r.warehouse_id,
        currencyId: r.currency_id, exchangeRate: r.exchange_rate, docDate: r.doc_date, validUntil: r.valid_until, paymentCondition: r.payment_condition,
        creditDays: r.credit_days, subtotal: r.subtotal, taxTotal: r.tax_total, total: r.total, totalBase: r.total_base, notes: r.notes,
        reservesStock: r.reserves_stock, version: r.version, updatedAt: r.updated_at,
        parent: links.find(l => l.childId === r.id) ? { id: links.find(l => l.childId === r.id)!.parentId, type: links.find(l => l.childId === r.id)!.parentType } : null,
        lines: lines.filter(l => l.documentId === r.id).map(l => ({
          id: l.id, productId: l.productId, sku: skus.get(l.productId) ?? null, description: l.description, quantity: l.quantity, unitPrice: l.unitPrice,
          discountPct: l.discountPct, taxId: l.taxId, taxRate: l.taxRate, net: l.net,
        })),
      })),
    };
  }
}
