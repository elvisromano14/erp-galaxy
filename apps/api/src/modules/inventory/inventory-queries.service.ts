import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { paginationQuery, uuid } from '@erp/contracts';
import { PrismaService } from '../../common/db/prisma.service';
import { AuditService } from '../../common/audit/audit.service';
import { BusinessRuleException, NotFoundError } from '../../common/errors/errors';
import { CursorPage, Paged } from '../../common/http/paged';

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
export const stockQuerySchema = paginationQuery.extend({
  productId: uuid.optional(), warehouseId: uuid.optional(), categoryId: uuid.optional(),
  onlyPositive: z.coerce.boolean().optional(), belowMin: z.coerce.boolean().optional(),
});
export const kardexQuerySchema = z.object({
  productId: uuid.optional(), warehouseId: uuid.optional(), docType: z.string().optional(), docId: uuid.optional(),
  dateFrom: date.optional(), dateTo: date.optional(),
  cursor: z.string().regex(/^\d+$/).optional(), limit: z.coerce.number().int().min(1).max(200).default(50),
});
export const serialsQuerySchema = paginationQuery.extend({
  productId: uuid.optional(), warehouseId: uuid.optional(), status: z.enum(['IN_STOCK', 'SOLD', 'RETURNED', 'SCRAPPED']).optional(),
});
export const serialHistorySchema = z.object({ productId: uuid, serialNo: z.string().min(1) });
export const valuationQuerySchema = z.object({ asOf: date.optional(), warehouseId: uuid.optional(), categoryId: uuid.optional() });
export const periodSchema = z.object({ year: z.number().int().min(2000).max(2100), month: z.number().int().min(1).max(12) });

@Injectable()
export class InventoryQueriesService {
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService) {}

  async stock(q: z.infer<typeof stockQuerySchema>) {
    const companyId = this.prisma.companyId;
    const conds: Prisma.Sql[] = [Prisma.sql`s.company_id = ${companyId}::uuid`, Prisma.sql`p.deleted_at IS NULL`];
    if (q.productId) conds.push(Prisma.sql`s.product_id = ${q.productId}::uuid`);
    if (q.warehouseId) conds.push(Prisma.sql`s.warehouse_id = ${q.warehouseId}::uuid`);
    if (q.categoryId) conds.push(Prisma.sql`p.category_id = ${q.categoryId}::uuid`);
    if (q.onlyPositive) conds.push(Prisma.sql`s.quantity > 0`);
    if (q.belowMin) conds.push(Prisma.sql`s.quantity < p.min_stock AND p.min_stock > 0`);
    if (q.search) conds.push(Prisma.sql`(p.sku ILIKE ${'%' + q.search + '%'} OR p.name ILIKE ${'%' + q.search + '%'})`);
    const where = Prisma.join(conds, ' AND ');
    const rows = await this.prisma.tx.$queryRaw<any[]>`
      SELECT s.product_id AS "productId", p.sku, p.name, s.warehouse_id AS "warehouseId", w.code AS "warehouseCode",
             s.quantity::text AS quantity, s.reserved_qty::text AS "reservedQty",
             COALESCE(c.avg_cost, 0)::text AS "avgCost", round(s.quantity * COALESCE(c.avg_cost, 0), 4)::text AS value,
             p.min_stock::text AS "minStock", p.max_stock::text AS "maxStock"
      FROM inventory_stock s
      JOIN products p ON p.id = s.product_id AND p.company_id = s.company_id
      JOIN warehouses w ON w.id = s.warehouse_id AND w.company_id = s.company_id
      LEFT JOIN product_costs c ON c.product_id = s.product_id AND c.company_id = s.company_id
      WHERE ${where}
      ORDER BY p.name, w.code
      LIMIT ${q.limit} OFFSET ${(q.page - 1) * q.limit}`;
    const [{ count }] = await this.prisma.tx.$queryRaw<{ count: bigint }[]>`
      SELECT count(*) AS count FROM inventory_stock s JOIN products p ON p.id = s.product_id AND p.company_id = s.company_id WHERE ${where}`;
    return Paged.of(rows, Number(count), q.page, q.limit);
  }

  /** Seriales (una fila por unidad) con su estado y ubicación actual. */
  async serials(q: z.infer<typeof serialsQuerySchema>) {
    const where: Prisma.ProductSerialWhereInput = {
      ...(q.productId ? { productId: q.productId } : {}), ...(q.warehouseId ? { warehouseId: q.warehouseId } : {}), ...(q.status ? { status: q.status } : {}),
      ...(q.search ? { serialNo: { contains: q.search, mode: 'insensitive' } } : {}),
    };
    const tx = this.prisma.tx;
    const [rows, total] = await Promise.all([
      tx.productSerial.findMany({ where, orderBy: [{ updatedAt: 'desc' }, { serialNo: 'asc' }], skip: (q.page - 1) * q.limit, take: q.limit }),
      tx.productSerial.count({ where }),
    ]);
    const products = new Map((await tx.product.findMany({ where: { id: { in: [...new Set(rows.map(r => r.productId))] } }, select: { id: true, sku: true, name: true } })).map(p => [p.id, p]));
    return Paged.of(rows.map(r => ({ ...r, product: products.get(r.productId) })), total, q.page, q.limit);
  }

  /** Trazabilidad de un serial: todos los movimientos del kardex en que participó. */
  async serialHistory(q: z.infer<typeof serialHistorySchema>) {
    const tx = this.prisma.tx;
    const serial = await tx.productSerial.findUnique({ where: { companyId_productId_serialNo: { companyId: this.prisma.companyId, productId: q.productId, serialNo: q.serialNo } } });
    if (!serial) throw new NotFoundError('Serial', q.serialNo);
    const links = await tx.movementSerial.findMany({ where: { serialId: serial.id } });
    const moves = await tx.inventoryMovement.findMany({ where: { id: { in: links.map(l => l.movementId) } }, orderBy: { seq: 'asc' } });
    return { serial, movements: moves };
  }

  async productStock(productId: string) {
    const tx = this.prisma.tx;
    const product = await tx.product.findFirst({ where: { id: productId } });
    if (!product) throw new NotFoundError('Producto', productId);
    const [stock, cost, whs] = await Promise.all([
      tx.inventoryStock.findMany({ where: { productId } }),
      tx.productCost.findFirst({ where: { productId } }),
      tx.warehouse.findMany({ where: { deletedAt: null } }),
    ]);
    const wm = new Map(whs.map(w => [w.id, w]));
    const total = stock.reduce((a, s) => a + Number(s.quantity), 0);
    return {
      productId, sku: product.sku, name: product.name, totalQuantity: total.toString(), avgCost: cost?.avgCost.toString() ?? '0', costPending: cost?.costPending ?? false,
      warehouses: stock.map(s => ({ warehouseId: s.warehouseId, code: wm.get(s.warehouseId)?.code, quantity: s.quantity.toString(), reservedQty: s.reservedQty.toString() })),
    };
  }

  /** Kardex con paginación por cursor (seq descendente). */
  async kardex(q: z.infer<typeof kardexQuerySchema>) {
    const tx = this.prisma.tx;
    const where: Prisma.InventoryMovementWhereInput = {};
    if (q.productId) where.productId = q.productId;
    if (q.warehouseId) where.warehouseId = q.warehouseId;
    if (q.docType) where.docType = q.docType;
    if (q.docId) where.docId = q.docId;
    if (q.dateFrom || q.dateTo) where.postedAt = { ...(q.dateFrom ? { gte: new Date(q.dateFrom + 'T00:00:00-04:00') } : {}), ...(q.dateTo ? { lt: new Date(new Date(q.dateTo + 'T00:00:00-04:00').getTime() + 86_400_000) } : {}) };
    if (q.cursor) where.seq = { lt: BigInt(q.cursor) };
    const rows = await tx.inventoryMovement.findMany({ where, orderBy: { seq: 'desc' }, take: q.limit + 1 });
    const page = rows.slice(0, q.limit);
    const products = new Map((await tx.product.findMany({ where: { id: { in: [...new Set(page.map(r => r.productId))] } }, select: { id: true, sku: true, name: true } })).map(p => [p.id, p]));
    const data = page.map(r => ({ ...r, product: products.get(r.productId) }));
    return new CursorPage(data, { limit: q.limit, nextCursor: rows.length > q.limit ? page[page.length - 1].seq.toString() : null });
  }

  /**
   * Inventario valorizado. Sin `asOf`: estado actual. Con `asOf`: reconstruido desde el kardex
   * (nunca desde product_costs actual, para que el histórico no cambie).
   */
  async valuation(q: z.infer<typeof valuationQuerySchema>) {
    const companyId = this.prisma.companyId;
    const end = q.asOf ? new Date(new Date(q.asOf + 'T00:00:00-04:00').getTime() + 86_400_000) : new Date(Date.now() + 1000);
    const whFilter = q.warehouseId ? Prisma.sql`AND warehouse_id = ${q.warehouseId}::uuid` : Prisma.empty;
    const catFilter = q.categoryId ? Prisma.sql`AND p.category_id = ${q.categoryId}::uuid` : Prisma.empty;
    const rows = await this.prisma.tx.$queryRaw<any[]>`
      WITH last_wh AS (
        SELECT DISTINCT ON (product_id, warehouse_id) product_id, warehouse_id, warehouse_qty_after AS qty
        FROM inventory_movements
        WHERE company_id = ${companyId}::uuid AND posted_at < ${end} ${whFilter}
        ORDER BY product_id, warehouse_id, seq DESC),
      last_cost AS (
        SELECT DISTINCT ON (product_id) product_id, avg_cost_after AS avg_cost
        FROM inventory_movements
        WHERE company_id = ${companyId}::uuid AND posted_at < ${end}
        ORDER BY product_id, seq DESC)
      SELECT p.id AS "productId", p.sku, p.name, p.category_id AS "categoryId", l.warehouse_id AS "warehouseId", w.code AS "warehouseCode",
             l.qty::text AS quantity, c.avg_cost::text AS "avgCost", round(l.qty * c.avg_cost, 4)::text AS value
      FROM last_wh l
      JOIN last_cost c ON c.product_id = l.product_id
      JOIN products p ON p.id = l.product_id AND p.company_id = ${companyId}::uuid
      JOIN warehouses w ON w.id = l.warehouse_id AND w.company_id = ${companyId}::uuid
      WHERE l.qty <> 0 ${catFilter}
      ORDER BY p.name, w.code`;
    const total = rows.reduce((a, r) => a + Number(r.value), 0);
    return { asOf: q.asOf ?? new Date().toISOString().slice(0, 10), rows, totalValue: total.toFixed(4) };
  }

  // ───────── períodos de inventario ─────────
  async periods() {
    return this.prisma.tx.inventoryPeriod.findMany({ orderBy: [{ year: 'desc' }, { month: 'desc' }] });
  }

  async closePeriod(p: z.infer<typeof periodSchema>) {
    const tx = this.prisma.tx;
    const companyId = this.prisma.companyId;
    const today = new Date(new Date().toLocaleDateString('en-CA', { timeZone: 'America/Caracas' }));
    if (p.year * 12 + p.month >= today.getUTCFullYear() * 12 + (today.getUTCMonth() + 1)) {
      throw new BusinessRuleException('Solo se pueden cerrar meses ya terminados', 'PERIOD_NOT_FINISHED');
    }
    const last = await tx.inventoryPeriod.findFirst({ where: { status: 'CLOSED' }, orderBy: [{ year: 'desc' }, { month: 'desc' }] });
    if (last && p.year * 12 + p.month !== last.year * 12 + last.month + 1) {
      throw new BusinessRuleException('Los períodos se cierran en orden consecutivo', 'PERIOD_ORDER');
    }
    const existing = await tx.inventoryPeriod.findUnique({ where: { companyId_year_month: { companyId, year: p.year, month: p.month } } });
    if (existing?.status === 'CLOSED') throw new BusinessRuleException('El período ya está cerrado', 'PERIOD_CLOSED');
    const monthEnd = new Date(Date.UTC(p.year, p.month, 1, 4, 0, 0)); // 00:00 del mes siguiente en Caracas (UTC-4)
    const period = existing
      ? await tx.inventoryPeriod.update({ where: { id: existing.id }, data: { status: 'CLOSED', closedAt: new Date(), closedBy: this.prisma.userId } })
      : await tx.inventoryPeriod.create({ data: { companyId, year: p.year, month: p.month, status: 'CLOSED', closedAt: new Date(), closedBy: this.prisma.userId } });
    await tx.$executeRaw`
      INSERT INTO inventory_period_snapshots (company_id, period_id, product_id, qty, avg_cost, value)
      SELECT ${companyId}::uuid, ${period.id}::uuid, t.product_id, t.qty_after, t.avg_cost_after, round(t.qty_after * t.avg_cost_after, 4)
      FROM (SELECT DISTINCT ON (product_id) product_id, qty_after, avg_cost_after FROM inventory_movements
            WHERE company_id = ${companyId}::uuid AND posted_at < ${monthEnd} ORDER BY product_id, seq DESC) t
      ON CONFLICT (company_id, period_id, product_id) DO UPDATE SET qty = EXCLUDED.qty, avg_cost = EXCLUDED.avg_cost, value = EXCLUDED.value`;
    await this.audit.log('inventory_period', period.id, 'CLOSE', p);
    return period;
  }

  async reopenPeriod(p: z.infer<typeof periodSchema>) {
    const tx = this.prisma.tx;
    const last = await tx.inventoryPeriod.findFirst({ where: { status: 'CLOSED' }, orderBy: [{ year: 'desc' }, { month: 'desc' }] });
    if (!last || last.year !== p.year || last.month !== p.month) {
      throw new BusinessRuleException('Solo se puede reabrir el último período cerrado', 'PERIOD_ORDER');
    }
    await tx.inventoryPeriodSnapshot.deleteMany({ where: { periodId: last.id } });
    const reopened = await tx.inventoryPeriod.update({ where: { id: last.id }, data: { status: 'OPEN', closedAt: null, closedBy: null } });
    await this.audit.log('inventory_period', last.id, 'REOPEN', p);
    return reopened;
  }

  async periodSnapshot(year: number, month: number) {
    const tx = this.prisma.tx;
    const period = await tx.inventoryPeriod.findFirst({ where: { year, month } });
    if (!period) throw new NotFoundError('Período');
    const rows = await tx.inventoryPeriodSnapshot.findMany({ where: { periodId: period.id } });
    return { period, rows };
  }
}
