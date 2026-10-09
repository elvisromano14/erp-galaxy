import { Injectable, Logger, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../common/db/prisma.service';
import { RedisService } from '../../common/db/redis.service';
import { env } from '../../config/env';
import { caracasToday } from '../inventory/inventory-docs.service';

export interface Alert { code: string; severity: 'info' | 'warning' | 'critical'; count: number; amountBase?: string; link: string; sample: Record<string, unknown>[] }

const DAY = 86_400_000;
const addDays = (iso: string, n: number) => new Date(new Date(iso).getTime() + n * DAY).toISOString().slice(0, 10);

/** Alertas operativas de la empresa activa, filtradas por los permisos de quien consulta. */
@Injectable()
export class AlertsService {
  constructor(private readonly prisma: PrismaService) {}

  async summary(can: (perm: string) => boolean): Promise<Alert[]> {
    const tx = this.prisma.tx;
    const cid = Prisma.sql`${this.prisma.companyId}::uuid`;
    const today = caracasToday();
    const out: Alert[] = [];
    const company = await tx.company.findFirst({ where: { id: this.prisma.companyId }, select: { features: true } });
    const features = (company?.features ?? {}) as Record<string, boolean>;

    if (can('inventory:stock:read')) {
      const rows = await tx.$queryRaw<Record<string, unknown>[]>`
        SELECT p.sku, p.name, COALESCE(s.q, 0)::text AS stock, p.min_stock::text AS "minStock"
        FROM products p LEFT JOIN (SELECT product_id, SUM(quantity) AS q FROM inventory_stock WHERE company_id = ${cid} GROUP BY product_id) s ON s.product_id = p.id
        WHERE p.company_id = ${cid} AND p.deleted_at IS NULL AND p.is_active AND p.min_stock > 0 AND COALESCE(s.q, 0) < p.min_stock
        ORDER BY (COALESCE(s.q, 0) / p.min_stock) ASC LIMIT 200`;
      if (rows.length) out.push({ code: 'LOW_STOCK', severity: rows.some(r => Number(r.stock) <= 0) ? 'critical' : 'warning', count: rows.length, link: '/reports/inventory/replenishment', sample: rows.slice(0, 5) });
    }

    if (can('inventory:stock:read') && features.lots && features.expiry) {
      const soon = addDays(today, 30);
      const rows = await tx.$queryRaw<Record<string, unknown>[]>`
        SELECT p.sku, p.name, l.lot_no AS "lotNo", l.expiry_date::text AS "expiryDate", SUM(b.quantity)::text AS quantity
        FROM inventory_lot_balances b JOIN lots l ON l.id = b.lot_id AND l.company_id = b.company_id JOIN products p ON p.id = b.product_id AND p.company_id = b.company_id
        WHERE b.company_id = ${cid} AND b.quantity > 0 AND l.expiry_date IS NOT NULL AND l.expiry_date <= ${soon}::date
        GROUP BY p.sku, p.name, l.lot_no, l.expiry_date ORDER BY l.expiry_date LIMIT 200`;
      if (rows.length) out.push({ code: 'EXPIRING_LOTS', severity: rows.some(r => String(r.expiryDate) < today) ? 'critical' : 'warning', count: rows.length, link: '/reports/inventory/lots-expiry', sample: rows.slice(0, 5) });
    }

    if (can('payables:entries:read') || can('reports:suppliers:read') || can('treasury:payments:read')) {
      const [r] = await tx.$queryRaw<{ overdue: number; overdue_bs: string; soon: number; soon_bs: string }[]>`
        SELECT COUNT(*) FILTER (WHERE due_date < ${today}::date)::int AS overdue,
               COALESCE(SUM(balance * exchange_rate) FILTER (WHERE due_date < ${today}::date), 0)::text AS overdue_bs,
               COUNT(*) FILTER (WHERE due_date >= ${today}::date AND due_date <= ${addDays(today, 7)}::date)::int AS soon,
               COALESCE(SUM(balance * exchange_rate) FILTER (WHERE due_date >= ${today}::date AND due_date <= ${addDays(today, 7)}::date), 0)::text AS soon_bs
        FROM payable_entries WHERE company_id = ${cid} AND status IN ('OPEN', 'PARTIALLY_PAID') AND balance > 0`;
      if (r.overdue) out.push({ code: 'PAYABLES_OVERDUE', severity: 'critical', count: r.overdue, amountBase: r.overdue_bs, link: '/reports/suppliers/aging', sample: [] });
      if (r.soon) out.push({ code: 'PAYABLES_DUE_SOON', severity: 'warning', count: r.soon, amountBase: r.soon_bs, link: '/reports/suppliers/payables', sample: [] });
    }

    if (can('treasury:receivables:read')) {
      const [r] = await tx.$queryRaw<{ n: number; bs: string }[]>`
        SELECT COUNT(*)::int AS n, COALESCE(SUM(balance * exchange_rate), 0)::text AS bs FROM receivable_entries
        WHERE company_id = ${cid} AND status IN ('OPEN', 'PARTIALLY_PAID') AND balance > 0 AND due_date < ${today}::date`;
      if (r.n) out.push({ code: 'RECEIVABLES_OVERDUE', severity: 'warning', count: r.n, amountBase: r.bs, link: '/reports/customers/aging', sample: [] });
    }

    if (can('sales:quotes:read')) {
      const rows = await tx.$queryRaw<Record<string, unknown>[]>`
        SELECT q.number, q.valid_until::text AS "validUntil", c.legal_name AS customer, q.total::text AS total
        FROM sales_documents q JOIN customers c ON c.id = q.customer_id AND c.company_id = q.company_id
        WHERE q.company_id = ${cid} AND q.doc_type = 'QUOTE' AND q.status = 'SENT' AND q.valid_until IS NOT NULL AND q.valid_until <= ${addDays(today, 3)}::date
        ORDER BY q.valid_until LIMIT 200`;
      if (rows.length) out.push({ code: 'QUOTES_EXPIRING', severity: 'info', count: rows.length, link: '/sales/quotes', sample: rows.slice(0, 5) });
    }

    if (can('treasury:movements:read')) {
      const [r] = await tx.$queryRaw<{ n: number }[]>`
        SELECT COUNT(*)::int AS n FROM bank_movements m
        WHERE m.company_id = ${cid} AND m.movement_date < ${addDays(today, -30)}::date
          AND NOT EXISTS (SELECT 1 FROM bank_reconciliation_items i WHERE i.company_id = m.company_id AND i.movement_id = m.id)`;
      if (r.n) out.push({ code: 'BANK_UNRECONCILED', severity: 'info', count: r.n, link: '/treasury/accounts', sample: [] });
    }
    return out;
  }
}

/**
 * Tareas periódicas de mantenimiento (candado en Redis para que solo una instancia corra a la vez):
 * vence las cotizaciones enviadas cuya vigencia pasó (ventas y compras).
 */
@Injectable()
export class HousekeepingService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly log = new Logger('Housekeeping');
  private timer?: NodeJS.Timeout;
  constructor(private readonly prisma: PrismaService, private readonly redis: RedisService) {}

  /** Marca como vencidas las cotizaciones SENT con vigencia anterior a hoy en TODAS las empresas. Devuelve cuántas. */
  async expireQuotes(): Promise<number> {
    const today = caracasToday();
    const companies = await this.prisma.company.findMany({ where: { isActive: true }, select: { id: true } });
    let n = 0;
    for (const c of companies) {
      await this.prisma.runWithTenant(c.id, async tx => {
        const a = await tx.salesDocument.updateMany({ where: { docType: 'QUOTE', status: 'SENT', validUntil: { lt: new Date(today) } }, data: { status: 'EXPIRED' } });
        const b = await tx.purchaseDocument.updateMany({ where: { docType: 'QUOTE', status: 'SENT', expiresAt: { lt: new Date(today) } }, data: { status: 'EXPIRED' } });
        n += a.count + b.count;
      });
    }
    return n;
  }

  onApplicationBootstrap() {
    if (!env.JOBS_ENABLED) return;
    const tick = async () => {
      const ok = await this.redis.client.set('lock:housekeeping', '1', 'EX', 600, 'NX').catch(() => null);
      if (!ok) return;
      try {
        const n = await this.expireQuotes();
        if (n) this.log.log(`Cotizaciones vencidas: ${n}`);
      } catch (e) { this.log.warn((e as Error).message); }
    };
    setTimeout(tick, 20_000).unref();
    this.timer = setInterval(tick, 60 * 60_000);
    this.timer.unref();
  }
  onApplicationShutdown() { if (this.timer) clearInterval(this.timer); }
}
