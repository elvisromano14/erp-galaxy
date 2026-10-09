import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { uuid } from '@erp/contracts';
import { D } from '@erp/domain';
import { ReportColumn } from './report-export';

type Tx = Prisma.TransactionClient;
type Row = Record<string, unknown>;

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Formato AAAA-MM-DD');
const bool = z.union([z.boolean(), z.enum(['true', 'false']).transform(v => v === 'true')]);

/** Filtros que puede usar un reporte (todos opcionales; cada reporte declara cuáles aplican). */
export const filterSchema = z.object({
  dateFrom: date.optional(), dateTo: date.optional(), asOf: date.optional(),
  warehouseId: uuid.optional(), categoryId: uuid.optional(), supplierId: uuid.optional(), productId: uuid.optional(),
  priceListId: uuid.optional(), status: z.string().max(60).optional(), search: z.string().trim().max(100).optional(),
  onlyWithStock: bool.optional(), docType: z.string().max(40).optional(),
});
export type Filters = z.infer<typeof filterSchema>;
export type FilterKey = keyof Filters;

export interface ReportCtx { tx: Tx; companyId: string; f: Filters; features: Record<string, boolean>; today: string }
export interface ReportResult { rows: Row[]; totals?: Row }

export interface ReportDef {
  category: string; id: string; title: string; description: string;
  filters: FilterKey[]; required?: FilterKey[];
  /** Solo disponible si la empresa activó esta función (lotes / seriales). */
  feature?: 'lots' | 'serials';
  columns: ReportColumn[];
  run: (c: ReportCtx) => Promise<ReportResult>;
}

export const CATEGORIES: Record<string, string> = {
  inventory: 'Inventario', categories: 'Instancias', suppliers: 'Proveedores', purchases: 'Compras', customers: 'Clientes', sellers: 'Vendedores',
};

const cid = (c: ReportCtx) => Prisma.sql`${c.companyId}::uuid`;
const when = (cond: unknown, frag: Prisma.Sql) => (cond ? frag : Prisma.empty);
const col = (key: string, header: string, type: ReportColumn['type'] = 'text'): ReportColumn => ({ key, header, type });
const sum = (rows: Row[], key: string) => rows.reduce((a, r) => a.plus(D(String(r[key] ?? 0))), D(0)).toString();
const raw = <T = Row>(tx: Tx, sql: Prisma.Sql) => tx.$queryRaw<T[]>(sql);

const stockSub = (c: ReportCtx) => Prisma.sql`
  (SELECT product_id, SUM(quantity) AS q FROM inventory_stock WHERE company_id = ${cid(c)}
     ${when(c.f.warehouseId, Prisma.sql`AND warehouse_id = ${c.f.warehouseId}::uuid`)} GROUP BY product_id)`;

/** Clasificación ABC por valor acumulado (A ≤ 80 %, B ≤ 95 %, C resto). */
function abc(rows: Row[], valueKey: string): Row[] {
  const sorted = [...rows].sort((a, b) => Number(b[valueKey]) - Number(a[valueKey]));
  const total = sorted.reduce((a, r) => a + Math.max(Number(r[valueKey]), 0), 0);
  let acc = 0;
  return sorted.map(r => {
    acc += Math.max(Number(r[valueKey]), 0);
    const pct = total > 0 ? (acc / total) * 100 : 100;
    return { ...r, share_pct: total > 0 ? ((Math.max(Number(r[valueKey]), 0) / total) * 100).toFixed(2) : '0', abc: pct <= 80 ? 'A' : pct <= 95 ? 'B' : 'C' };
  });
}

export const REPORTS: ReportDef[] = [
  // ════════════════════════ INVENTARIO ════════════════════════
  {
    category: 'inventory', id: 'products', title: 'Listado de productos', description: 'Maestro de productos con existencia y costo promedio.',
    filters: ['categoryId', 'warehouseId', 'search', 'onlyWithStock'],
    columns: [col('sku', 'SKU'), col('name', 'Producto'), col('category', 'Instancia'), col('unit', 'Unidad'), col('tax', 'Impuesto'), col('tracking', 'Control'),
      col('min_stock', 'Mínimo', 'qty'), col('max_stock', 'Máximo', 'qty'), col('stock', 'Existencia', 'qty'), col('avg_cost', 'Costo prom.', 'cost'), col('is_active', 'Activo', 'bool')],
    async run(c) {
      const rows = await raw(c.tx, Prisma.sql`
        SELECT p.sku, p.name, cat.name AS category, u.code AS unit, t.name AS tax, CASE p.tracking_mode WHEN 'LOT' THEN 'Por lote' WHEN 'SERIAL' THEN 'Por serial' ELSE 'Sin control' END AS tracking,
               p.min_stock::text AS min_stock, p.max_stock::text AS max_stock, COALESCE(st.q, 0)::text AS stock,
               COALESCE(pc.avg_cost, 0)::text AS avg_cost, p.is_active
        FROM products p
        LEFT JOIN categories cat ON cat.id = p.category_id AND cat.company_id = p.company_id
        LEFT JOIN units u ON u.id = p.unit_id AND u.company_id = p.company_id
        LEFT JOIN taxes t ON t.id = p.tax_id AND t.company_id = p.company_id
        LEFT JOIN product_costs pc ON pc.product_id = p.id AND pc.company_id = p.company_id
        LEFT JOIN ${stockSub(c)} st ON st.product_id = p.id
        WHERE p.company_id = ${cid(c)} AND p.deleted_at IS NULL
          ${when(c.f.categoryId, Prisma.sql`AND p.category_id = ${c.f.categoryId}::uuid`)}
          ${when(c.f.search, Prisma.sql`AND (p.sku ILIKE ${'%' + c.f.search + '%'} OR p.name ILIKE ${'%' + c.f.search + '%'})`)}
          ${when(c.f.onlyWithStock, Prisma.sql`AND COALESCE(st.q, 0) > 0`)}
        ORDER BY p.name`);
      return { rows };
    },
  },
  {
    category: 'inventory', id: 'replenishment', title: 'Reposición de inventario', description: 'Productos bajo su mínimo; sugerido = máximo − (existencia + pedido en tránsito).',
    filters: ['warehouseId', 'categoryId'],
    columns: [col('sku', 'SKU'), col('name', 'Producto'), col('stock', 'Existencia', 'qty'), col('in_transit', 'En tránsito', 'qty'), col('min_stock', 'Mínimo', 'qty'), col('max_stock', 'Máximo', 'qty'),
      col('suggested', 'Sugerido', 'qty'), col('avg_cost', 'Costo prom.', 'cost'), col('suggested_value', 'Valor sugerido', 'money')],
    async run(c) {
      const rows = await raw(c.tx, Prisma.sql`
        WITH received AS (
          SELECT ll.parent_line_id, SUM(ll.quantity) AS q FROM document_link_lines ll
          JOIN document_links k ON k.id = ll.link_id
          JOIN purchase_documents dn ON dn.id = k.child_id AND dn.doc_type = 'DELIVERY_NOTE' AND dn.status IN ('CONFIRMED', 'INVOICED')
          WHERE ll.company_id = ${cid(c)} GROUP BY ll.parent_line_id),
        transit AS (
          SELECT l.product_id, SUM(GREATEST(l.quantity - COALESCE(r.q, 0), 0)) AS q
          FROM purchase_document_lines l
          JOIN purchase_documents d ON d.id = l.document_id AND d.doc_type = 'ORDER' AND d.status IN ('CONFIRMED', 'PARTIALLY_FULFILLED')
          LEFT JOIN received r ON r.parent_line_id = l.id
          WHERE l.company_id = ${cid(c)} GROUP BY l.product_id)
        SELECT x.* , round(x.suggested * x.avg_cost_n, 4)::text AS suggested_value FROM (
          SELECT p.sku, p.name, COALESCE(st.q, 0)::text AS stock, COALESCE(tr.q, 0)::text AS in_transit, p.min_stock::text AS min_stock, p.max_stock::text AS max_stock,
                 GREATEST((CASE WHEN p.max_stock > 0 THEN p.max_stock ELSE p.min_stock * 2 END) - (COALESCE(st.q, 0) + COALESCE(tr.q, 0)), 0) AS suggested,
                 COALESCE(pc.avg_cost, 0) AS avg_cost_n, COALESCE(pc.avg_cost, 0)::text AS avg_cost
          FROM products p
          LEFT JOIN ${stockSub(c)} st ON st.product_id = p.id
          LEFT JOIN transit tr ON tr.product_id = p.id
          LEFT JOIN product_costs pc ON pc.product_id = p.id AND pc.company_id = p.company_id
          WHERE p.company_id = ${cid(c)} AND p.deleted_at IS NULL AND p.is_active AND NOT p.is_service AND p.min_stock > 0
            AND COALESCE(st.q, 0) < p.min_stock
            ${when(c.f.categoryId, Prisma.sql`AND p.category_id = ${c.f.categoryId}::uuid`)}
        ) x ORDER BY x.name`);
      const out = rows.map(r => ({ ...r, suggested: String(r.suggested) }));
      return { rows: out, totals: { suggested_value: sum(out, 'suggested_value') } };
    },
  },
  {
    category: 'inventory', id: 'price-list', title: 'Lista de precios', description: 'Precio vigente de cada producto en una lista (por defecto, la lista predeterminada).',
    filters: ['priceListId', 'categoryId', 'search'],
    columns: [col('sku', 'SKU'), col('name', 'Producto'), col('category', 'Instancia'), col('list', 'Lista'), col('currency', 'Moneda'), col('price', 'Precio', 'money'), col('valid_from', 'Vigente desde', 'date')],
    async run(c) {
      const rows = await raw(c.tx, Prisma.sql`
        SELECT p.sku, p.name, cat.name AS category, pl.name AS list, cu.code AS currency, pr.price::text AS price, pr.valid_from
        FROM products p
        JOIN price_lists pl ON pl.company_id = p.company_id AND pl.deleted_at IS NULL
          AND ${c.f.priceListId ? Prisma.sql`pl.id = ${c.f.priceListId}::uuid` : Prisma.sql`pl.is_default`}
        JOIN currencies cu ON cu.id = pl.currency_id
        LEFT JOIN categories cat ON cat.id = p.category_id AND cat.company_id = p.company_id
        LEFT JOIN LATERAL (SELECT price, valid_from FROM product_prices x WHERE x.company_id = p.company_id AND x.product_id = p.id AND x.price_list_id = pl.id
                           AND x.valid_from <= ${c.today}::date ORDER BY x.valid_from DESC LIMIT 1) pr ON true
        WHERE p.company_id = ${cid(c)} AND p.deleted_at IS NULL AND p.is_active AND NOT p.is_service
          ${when(c.f.categoryId, Prisma.sql`AND p.category_id = ${c.f.categoryId}::uuid`)}
          ${when(c.f.search, Prisma.sql`AND (p.sku ILIKE ${'%' + c.f.search + '%'} OR p.name ILIKE ${'%' + c.f.search + '%'})`)}
        ORDER BY p.name`);
      return { rows };
    },
  },
  {
    category: 'inventory', id: 'physical-count', title: 'Hoja de inventario físico', description: 'Existencias del sistema por depósito para llenar el conteo.',
    filters: ['warehouseId', 'categoryId'], required: ['warehouseId'],
    columns: [col('sku', 'SKU'), col('name', 'Producto'), col('category', 'Instancia'), col('system_qty', 'Existencia sistema', 'qty'), col('counted', 'Contado'), col('notes', 'Observaciones')],
    async run(c) {
      const rows = await raw(c.tx, Prisma.sql`
        SELECT p.sku, p.name, cat.name AS category, s.quantity::text AS system_qty, '' AS counted, '' AS notes
        FROM inventory_stock s JOIN products p ON p.id = s.product_id AND p.company_id = s.company_id AND p.deleted_at IS NULL
        LEFT JOIN categories cat ON cat.id = p.category_id AND cat.company_id = p.company_id
        WHERE s.company_id = ${cid(c)} AND s.warehouse_id = ${c.f.warehouseId}::uuid AND s.quantity <> 0
          ${when(c.f.categoryId, Prisma.sql`AND p.category_id = ${c.f.categoryId}::uuid`)}
        ORDER BY cat.name NULLS LAST, p.name`);
      return { rows };
    },
  },
  {
    category: 'inventory', id: 'stock-valuation', title: 'Existencias valorizadas', description: 'Inventario por producto y depósito al costo promedio (con fecha: reconstruido desde el kardex).',
    filters: ['asOf', 'warehouseId', 'categoryId'],
    columns: [col('sku', 'SKU'), col('name', 'Producto'), col('warehouse', 'Depósito'), col('quantity', 'Cantidad', 'qty'), col('avg_cost', 'Costo prom.', 'cost'), col('value', 'Valor', 'money')],
    async run(c) {
      const end = c.f.asOf ? new Date(new Date(c.f.asOf + 'T00:00:00-04:00').getTime() + 86_400_000) : new Date(Date.now() + 1000);
      const rows = await raw(c.tx, Prisma.sql`
        WITH last_wh AS (
          SELECT DISTINCT ON (product_id, warehouse_id) product_id, warehouse_id, warehouse_qty_after AS qty FROM inventory_movements
          WHERE company_id = ${cid(c)} AND posted_at < ${end} ${when(c.f.warehouseId, Prisma.sql`AND warehouse_id = ${c.f.warehouseId}::uuid`)}
          ORDER BY product_id, warehouse_id, seq DESC),
        last_cost AS (
          SELECT DISTINCT ON (product_id) product_id, avg_cost_after AS avg_cost FROM inventory_movements
          WHERE company_id = ${cid(c)} AND posted_at < ${end} ORDER BY product_id, seq DESC)
        SELECT p.sku, p.name, w.code AS warehouse, l.qty::text AS quantity, lc.avg_cost::text AS avg_cost, round(l.qty * lc.avg_cost, 4)::text AS value
        FROM last_wh l JOIN last_cost lc ON lc.product_id = l.product_id
        JOIN products p ON p.id = l.product_id AND p.company_id = ${cid(c)}
        JOIN warehouses w ON w.id = l.warehouse_id AND w.company_id = ${cid(c)}
        WHERE l.qty <> 0 ${when(c.f.categoryId, Prisma.sql`AND p.category_id = ${c.f.categoryId}::uuid`)}
        ORDER BY p.name, w.code`);
      return { rows, totals: { value: sum(rows, 'value') } };
    },
  },
  {
    category: 'inventory', id: 'product-analysis', title: 'Análisis de productos', description: 'Valor de existencia, última compra y clasificación ABC.',
    filters: ['categoryId', 'warehouseId'],
    columns: [col('sku', 'SKU'), col('name', 'Producto'), col('stock', 'Existencia', 'qty'), col('avg_cost', 'Costo prom.', 'cost'), col('value', 'Valor', 'money'),
      col('share_pct', '% del valor', 'pct'), col('abc', 'ABC'), col('last_purchase', 'Última compra', 'date'), col('last_cost', 'Último costo', 'cost')],
    async run(c) {
      const rows = await raw(c.tx, Prisma.sql`
        SELECT p.sku, p.name, COALESCE(st.q, 0)::text AS stock, COALESCE(pc.avg_cost, 0)::text AS avg_cost,
               round(COALESCE(st.q, 0) * COALESCE(pc.avg_cost, 0), 4)::text AS value, lp.posted_at AS last_purchase, lp.unit_cost::text AS last_cost
        FROM products p
        LEFT JOIN ${stockSub(c)} st ON st.product_id = p.id
        LEFT JOIN product_costs pc ON pc.product_id = p.id AND pc.company_id = p.company_id
        LEFT JOIN LATERAL (SELECT posted_at, unit_cost FROM inventory_movements m WHERE m.company_id = p.company_id AND m.product_id = p.id
                           AND m.doc_type IN ('PURCHASE', 'DELIVERY_NOTE', 'CHARGE') AND m.quantity > 0 AND m.reversal_of IS NULL ORDER BY m.seq DESC LIMIT 1) lp ON true
        WHERE p.company_id = ${cid(c)} AND p.deleted_at IS NULL AND NOT p.is_service
          ${when(c.f.categoryId, Prisma.sql`AND p.category_id = ${c.f.categoryId}::uuid`)}`);
      const out = abc(rows, 'value');
      return { rows: out, totals: { value: sum(out, 'value') } };
    },
  },
  {
    category: 'inventory', id: 'kardex', title: 'Kardex por producto', description: 'Movimientos de un producto con saldos y costo promedio.',
    filters: ['productId', 'warehouseId', 'dateFrom', 'dateTo'], required: ['productId'],
    columns: [col('posted_at', 'Fecha', 'datetime'), col('warehouse', 'Depósito'), col('doc_type', 'Documento'), col('reversal', 'Reverso', 'bool'), col('quantity', 'Cantidad', 'qty'),
      col('unit_cost', 'Costo unit.', 'cost'), col('total_cost', 'Costo total', 'money'), col('wh_after', 'Saldo depósito', 'qty'), col('qty_after', 'Saldo total', 'qty'), col('avg_after', 'Costo prom.', 'cost')],
    async run(c) {
      const rows = await raw(c.tx, Prisma.sql`
        SELECT m.posted_at, w.code AS warehouse, m.doc_type, (m.reversal_of IS NOT NULL) AS reversal, m.quantity::text AS quantity, m.unit_cost::text AS unit_cost,
               m.total_cost::text AS total_cost, m.warehouse_qty_after::text AS wh_after, m.qty_after::text AS qty_after, m.avg_cost_after::text AS avg_after
        FROM inventory_movements m JOIN warehouses w ON w.id = m.warehouse_id AND w.company_id = m.company_id
        WHERE m.company_id = ${cid(c)} AND m.product_id = ${c.f.productId}::uuid
          ${when(c.f.warehouseId, Prisma.sql`AND m.warehouse_id = ${c.f.warehouseId}::uuid`)}
          ${when(c.f.dateFrom, Prisma.sql`AND m.posted_at >= ${new Date(c.f.dateFrom + 'T00:00:00-04:00')}`)}
          ${when(c.f.dateTo, Prisma.sql`AND m.posted_at < ${new Date(new Date(c.f.dateTo + 'T00:00:00-04:00').getTime() + 86_400_000)}`)}
        ORDER BY m.seq`);
      return { rows };
    },
  },
  {
    category: 'inventory', id: 'lots-expiry', title: 'Lotes y vencimientos', description: 'Saldos por lote ordenados por fecha de vencimiento.',
    filters: ['warehouseId', 'categoryId'], feature: 'lots',
    columns: [col('sku', 'SKU'), col('name', 'Producto'), col('warehouse', 'Depósito'), col('lot_no', 'Lote'), col('expiry_date', 'Vence', 'date'), col('days_left', 'Días restantes', 'int'), col('quantity', 'Cantidad', 'qty')],
    async run(c) {
      const rows = await raw(c.tx, Prisma.sql`
        SELECT p.sku, p.name, w.code AS warehouse, l.lot_no, l.expiry_date, (l.expiry_date - ${c.today}::date) AS days_left, b.quantity::text AS quantity
        FROM inventory_lot_balances b
        JOIN lots l ON l.id = b.lot_id AND l.company_id = b.company_id
        JOIN products p ON p.id = b.product_id AND p.company_id = b.company_id
        JOIN warehouses w ON w.id = b.warehouse_id AND w.company_id = b.company_id
        WHERE b.company_id = ${cid(c)} AND b.quantity > 0
          ${when(c.f.warehouseId, Prisma.sql`AND b.warehouse_id = ${c.f.warehouseId}::uuid`)}
          ${when(c.f.categoryId, Prisma.sql`AND p.category_id = ${c.f.categoryId}::uuid`)}
        ORDER BY l.expiry_date NULLS LAST, p.name`);
      return { rows };
    },
  },
  {
    category: 'inventory', id: 'serials', title: 'Seriales', description: 'Una fila por unidad con su estado y ubicación.',
    filters: ['productId', 'warehouseId', 'status'], feature: 'serials',
    columns: [col('sku', 'SKU'), col('name', 'Producto'), col('serial_no', 'Serial'), col('status', 'Estado'), col('warehouse', 'Depósito'), col('updated_at', 'Actualizado', 'datetime')],
    async run(c) {
      const rows = await raw(c.tx, Prisma.sql`
        SELECT p.sku, p.name, s.serial_no, s.status, w.code AS warehouse, s.updated_at
        FROM product_serials s JOIN products p ON p.id = s.product_id AND p.company_id = s.company_id
        LEFT JOIN warehouses w ON w.id = s.warehouse_id AND w.company_id = s.company_id
        WHERE s.company_id = ${cid(c)}
          ${when(c.f.productId, Prisma.sql`AND s.product_id = ${c.f.productId}::uuid`)}
          ${when(c.f.warehouseId, Prisma.sql`AND s.warehouse_id = ${c.f.warehouseId}::uuid`)}
          ${when(c.f.status, Prisma.sql`AND s.status = ${c.f.status}`)}
        ORDER BY p.name, s.serial_no`);
      return { rows };
    },
  },

  // ════════════════════════ INSTANCIAS ════════════════════════
  {
    category: 'categories', id: 'inventory', title: 'Inventario por instancia', description: 'Existencia y valor por instancia (categoría).',
    filters: ['warehouseId'],
    columns: [col('code', 'Código'), col('name', 'Instancia'), col('products', 'Productos', 'int'), col('quantity', 'Existencia', 'qty'), col('value', 'Valor', 'money')],
    async run(c) {
      const rows = await raw(c.tx, Prisma.sql`
        SELECT COALESCE(cat.code, '—') AS code, COALESCE(cat.name, 'Sin instancia') AS name, count(DISTINCT p.id)::int AS products,
               COALESCE(SUM(s.quantity), 0)::text AS quantity, round(COALESCE(SUM(s.quantity * COALESCE(pc.avg_cost, 0)), 0), 4)::text AS value
        FROM products p
        LEFT JOIN categories cat ON cat.id = p.category_id AND cat.company_id = p.company_id
        LEFT JOIN inventory_stock s ON s.product_id = p.id AND s.company_id = p.company_id ${when(c.f.warehouseId, Prisma.sql`AND s.warehouse_id = ${c.f.warehouseId}::uuid`)}
        LEFT JOIN product_costs pc ON pc.product_id = p.id AND pc.company_id = p.company_id
        WHERE p.company_id = ${cid(c)} AND p.deleted_at IS NULL AND NOT p.is_service
        GROUP BY cat.code, cat.name ORDER BY cat.name NULLS LAST`);
      return { rows, totals: { products: rows.reduce((a, r) => a + Number(r.products), 0), quantity: sum(rows, 'quantity'), value: sum(rows, 'value') } };
    },
  },
  {
    category: 'categories', id: 'inventory-consolidated', title: 'Consolidado de inventario', description: 'Valor por instancia y depósito.',
    filters: [],
    columns: [col('category', 'Instancia'), col('warehouse', 'Depósito'), col('quantity', 'Existencia', 'qty'), col('value', 'Valor', 'money')],
    async run(c) {
      const rows = await raw(c.tx, Prisma.sql`
        SELECT COALESCE(cat.name, 'Sin instancia') AS category, w.code AS warehouse, SUM(s.quantity)::text AS quantity,
               round(SUM(s.quantity * COALESCE(pc.avg_cost, 0)), 4)::text AS value
        FROM inventory_stock s
        JOIN products p ON p.id = s.product_id AND p.company_id = s.company_id AND p.deleted_at IS NULL
        JOIN warehouses w ON w.id = s.warehouse_id AND w.company_id = s.company_id
        LEFT JOIN categories cat ON cat.id = p.category_id AND cat.company_id = p.company_id
        LEFT JOIN product_costs pc ON pc.product_id = p.id AND pc.company_id = p.company_id
        WHERE s.company_id = ${cid(c)} GROUP BY cat.name, w.code HAVING SUM(s.quantity) <> 0 ORDER BY cat.name NULLS LAST, w.code`);
      return { rows, totals: { quantity: sum(rows, 'quantity'), value: sum(rows, 'value') } };
    },
  },
  {
    category: 'categories', id: 'inventory-statistics', title: 'Estadística de inventario', description: 'Participación en el valor, productos sin existencia y bajo mínimo por instancia.',
    filters: [],
    columns: [col('name', 'Instancia'), col('products', 'Productos', 'int'), col('no_stock', 'Sin existencia', 'int'), col('below_min', 'Bajo mínimo', 'int'), col('value', 'Valor', 'money'), col('share_pct', '% del valor', 'pct')],
    async run(c) {
      const rows = await raw(c.tx, Prisma.sql`
        SELECT COALESCE(cat.name, 'Sin instancia') AS name, count(*)::int AS products,
               count(*) FILTER (WHERE COALESCE(st.q, 0) <= 0)::int AS no_stock,
               count(*) FILTER (WHERE p.min_stock > 0 AND COALESCE(st.q, 0) < p.min_stock)::int AS below_min,
               round(COALESCE(SUM(COALESCE(st.q, 0) * COALESCE(pc.avg_cost, 0)), 0), 4)::text AS value
        FROM products p
        LEFT JOIN categories cat ON cat.id = p.category_id AND cat.company_id = p.company_id
        LEFT JOIN ${stockSub(c)} st ON st.product_id = p.id
        LEFT JOIN product_costs pc ON pc.product_id = p.id AND pc.company_id = p.company_id
        WHERE p.company_id = ${cid(c)} AND p.deleted_at IS NULL AND p.is_active AND NOT p.is_service
        GROUP BY cat.name ORDER BY 5 DESC`);
      const total = rows.reduce((a, r) => a + Number(r.value), 0);
      const out: Row[] = rows.map(r => ({ ...r, share_pct: total > 0 ? ((Number(r.value) / total) * 100).toFixed(2) : '0' }));
      return { rows: out, totals: { products: out.reduce((a, r) => a + Number(r.products), 0), value: String(total.toFixed(4)) } };
    },
  },

  // ════════════════════════ PROVEEDORES ════════════════════════
  {
    category: 'suppliers', id: 'list', title: 'Listado de proveedores', description: 'Maestro de proveedores.',
    filters: ['search'],
    columns: [col('rif', 'RIF'), col('legal_name', 'Razón social'), col('trade_name', 'Nombre comercial'), col('special', 'Contrib. especial', 'bool'), col('retention', 'Retención IVA', 'pct'),
      col('credit_days', 'Días crédito', 'int'), col('email', 'Correo'), col('phone', 'Teléfono'), col('is_active', 'Activo', 'bool')],
    async run(c) {
      const rows = await raw(c.tx, Prisma.sql`
        SELECT rif, legal_name, trade_name, is_special_taxpayer AS special, retention_iva_pct::text AS retention, credit_days, email, phone, is_active
        FROM suppliers WHERE company_id = ${cid(c)} AND deleted_at IS NULL
          ${when(c.f.search, Prisma.sql`AND (rif ILIKE ${'%' + c.f.search + '%'} OR legal_name ILIKE ${'%' + c.f.search + '%'})`)}
        ORDER BY legal_name`);
      return { rows };
    },
  },
  {
    category: 'suppliers', id: 'payables', title: 'Cuentas por pagar', description: 'Documentos con saldo abierto. Importes en moneda del documento y en Bs a la tasa del documento.',
    filters: ['supplierId', 'asOf'],
    columns: [col('supplier', 'Proveedor'), col('number', 'Documento'), col('supplier_doc', 'Factura prov.'), col('doc_date', 'Fecha', 'date'), col('due_date', 'Vence', 'date'), col('currency', 'Moneda'),
      col('amount', 'Monto', 'money'), col('balance', 'Saldo', 'money'), col('balance_bs', 'Saldo Bs', 'money'), col('days_overdue', 'Días vencido', 'int')],
    async run(c) {
      const asOf = c.f.asOf ?? c.today;
      const rows = await raw(c.tx, Prisma.sql`
        SELECT s.legal_name AS supplier, d.number, d.supplier_doc_no AS supplier_doc, d.doc_date, e.due_date, cu.code AS currency, e.amount::text AS amount, e.balance::text AS balance,
               round(e.balance * e.exchange_rate, 4)::text AS balance_bs, GREATEST((${asOf}::date - e.due_date), 0) AS days_overdue
        FROM payable_entries e
        JOIN purchase_documents d ON d.id = e.purchase_document_id AND d.company_id = e.company_id
        JOIN suppliers s ON s.id = e.supplier_id AND s.company_id = e.company_id
        JOIN currencies cu ON cu.id = e.currency_id
        WHERE e.company_id = ${cid(c)} AND e.status IN ('OPEN', 'PARTIALLY_PAID') AND e.balance <> 0 AND d.doc_date <= ${asOf}::date
          ${when(c.f.supplierId, Prisma.sql`AND e.supplier_id = ${c.f.supplierId}::uuid`)}
        ORDER BY s.legal_name, e.due_date`);
      return { rows, totals: { balance_bs: sum(rows, 'balance_bs') } };
    },
  },
  {
    category: 'suppliers', id: 'aging', title: 'Análisis de vencimiento (CxP)', description: 'Saldos por proveedor en tramos de antigüedad, en Bs a la tasa de cada documento.',
    filters: ['supplierId', 'asOf'],
    columns: [col('supplier', 'Proveedor'), col('current', 'Por vencer', 'money'), col('d1_30', '1–30', 'money'), col('d31_60', '31–60', 'money'), col('d61_90', '61–90', 'money'), col('d90', '+90', 'money'), col('total', 'Total', 'money')],
    async run(c) {
      const asOf = c.f.asOf ?? c.today;
      const rows = await raw(c.tx, Prisma.sql`
        WITH x AS (SELECT s.legal_name AS supplier, e.balance * e.exchange_rate AS bs, (${asOf}::date - e.due_date) AS late
          FROM payable_entries e JOIN suppliers s ON s.id = e.supplier_id AND s.company_id = e.company_id
          JOIN purchase_documents d ON d.id = e.purchase_document_id AND d.company_id = e.company_id
          WHERE e.company_id = ${cid(c)} AND e.status IN ('OPEN', 'PARTIALLY_PAID') AND e.balance <> 0 AND d.doc_date <= ${asOf}::date
            ${when(c.f.supplierId, Prisma.sql`AND e.supplier_id = ${c.f.supplierId}::uuid`)})
        SELECT supplier,
          round(COALESCE(SUM(bs) FILTER (WHERE late <= 0), 0), 4)::text AS current,
          round(COALESCE(SUM(bs) FILTER (WHERE late BETWEEN 1 AND 30), 0), 4)::text AS d1_30,
          round(COALESCE(SUM(bs) FILTER (WHERE late BETWEEN 31 AND 60), 0), 4)::text AS d31_60,
          round(COALESCE(SUM(bs) FILTER (WHERE late BETWEEN 61 AND 90), 0), 4)::text AS d61_90,
          round(COALESCE(SUM(bs) FILTER (WHERE late > 90), 0), 4)::text AS d90,
          round(COALESCE(SUM(bs), 0), 4)::text AS total
        FROM x GROUP BY supplier ORDER BY supplier`);
      return { rows, totals: { current: sum(rows, 'current'), d1_30: sum(rows, 'd1_30'), d31_60: sum(rows, 'd31_60'), d61_90: sum(rows, 'd61_90'), d90: sum(rows, 'd90'), total: sum(rows, 'total') } };
    },
  },
  {
    category: 'suppliers', id: 'statement', title: 'Estado de cuenta de proveedor', description: 'Facturas y devoluciones con saldo acumulado en Bs (los pagos se incorporan con el módulo de pagos).',
    filters: ['supplierId', 'dateFrom', 'dateTo'], required: ['supplierId'],
    columns: [col('doc_date', 'Fecha', 'date'), col('type', 'Tipo'), col('number', 'Documento'), col('supplier_doc', 'Factura prov.'), col('currency', 'Moneda'),
      col('amount', 'Monto', 'money'), col('debit_bs', 'Cargo Bs', 'money'), col('credit_bs', 'Abono Bs', 'money'), col('balance_bs', 'Saldo Bs', 'money')],
    async run(c) {
      const rows = await raw<Row>(c.tx, Prisma.sql`
        SELECT d.doc_date, e.entry_type AS type, d.number, d.supplier_doc_no AS supplier_doc, cu.code AS currency, e.amount::text AS amount,
               round(GREATEST(e.amount, 0) * e.exchange_rate, 4)::text AS debit_bs, round(GREATEST(-e.amount, 0) * e.exchange_rate, 4)::text AS credit_bs
        FROM payable_entries e JOIN purchase_documents d ON d.id = e.purchase_document_id AND d.company_id = e.company_id
        JOIN currencies cu ON cu.id = e.currency_id
        WHERE e.company_id = ${cid(c)} AND e.supplier_id = ${c.f.supplierId}::uuid AND e.status <> 'CANCELLED'
          ${when(c.f.dateFrom, Prisma.sql`AND d.doc_date >= ${c.f.dateFrom}::date`)} ${when(c.f.dateTo, Prisma.sql`AND d.doc_date <= ${c.f.dateTo}::date`)}
        ORDER BY d.doc_date, d.created_at`);
      let bal = D(0);
      const out = rows.map(r => { bal = bal.plus(D(String(r.debit_bs))).minus(D(String(r.credit_bs))); return { ...r, type: r.type === 'INVOICE' ? 'Factura' : 'Devolución', balance_bs: bal.toFixed(4) }; });
      return { rows: out, totals: { debit_bs: sum(out, 'debit_bs'), credit_bs: sum(out, 'credit_bs'), balance_bs: bal.toFixed(4) } };
    },
  },
  {
    category: 'suppliers', id: 'pending-transactions', title: 'Transacciones pendientes', description: 'Órdenes sin recibir completas, notas de entrega sin facturar y compras con saldo.',
    filters: ['supplierId'],
    columns: [col('kind', 'Pendiente'), col('supplier', 'Proveedor'), col('number', 'Documento'), col('doc_date', 'Fecha', 'date'), col('status', 'Estado'), col('currency', 'Moneda'), col('total', 'Total', 'money'), col('detail', 'Detalle')],
    async run(c) {
      const rows = await raw(c.tx, Prisma.sql`
        SELECT 'Orden por recibir' AS kind, s.legal_name AS supplier, d.number, d.doc_date, d.status, cu.code AS currency, d.total::text AS total, '' AS detail
        FROM purchase_documents d JOIN suppliers s ON s.id = d.supplier_id AND s.company_id = d.company_id JOIN currencies cu ON cu.id = d.currency_id
        WHERE d.company_id = ${cid(c)} AND d.doc_type = 'ORDER' AND d.status IN ('CONFIRMED', 'PARTIALLY_FULFILLED') ${when(c.f.supplierId, Prisma.sql`AND d.supplier_id = ${c.f.supplierId}::uuid`)}
        UNION ALL
        SELECT 'Nota de entrega sin facturar', s.legal_name, d.number, d.doc_date, d.status, cu.code, d.total::text, ''
        FROM purchase_documents d JOIN suppliers s ON s.id = d.supplier_id AND s.company_id = d.company_id JOIN currencies cu ON cu.id = d.currency_id
        WHERE d.company_id = ${cid(c)} AND d.doc_type = 'DELIVERY_NOTE' AND d.status = 'CONFIRMED' ${when(c.f.supplierId, Prisma.sql`AND d.supplier_id = ${c.f.supplierId}::uuid`)}
        UNION ALL
        SELECT 'Compra con saldo', s.legal_name, d.number, d.doc_date, e.status, cu.code, e.balance::text, 'Vence ' || to_char(e.due_date, 'DD/MM/YYYY')
        FROM payable_entries e JOIN purchase_documents d ON d.id = e.purchase_document_id AND d.company_id = e.company_id
        JOIN suppliers s ON s.id = e.supplier_id AND s.company_id = e.company_id JOIN currencies cu ON cu.id = e.currency_id
        WHERE e.company_id = ${cid(c)} AND e.entry_type = 'INVOICE' AND e.status IN ('OPEN', 'PARTIALLY_PAID') ${when(c.f.supplierId, Prisma.sql`AND e.supplier_id = ${c.f.supplierId}::uuid`)}
        ORDER BY 1, 2, 4`);
      return { rows };
    },
  },
  {
    category: 'suppliers', id: 'product-purchases', title: 'Compras por producto y proveedor', description: 'Cantidades y montos comprados (compras confirmadas y notas de entrega sin facturar).',
    filters: ['dateFrom', 'dateTo', 'supplierId', 'productId'],
    columns: [col('supplier', 'Proveedor'), col('sku', 'SKU'), col('name', 'Producto'), col('quantity', 'Cantidad', 'qty'), col('amount_bs', 'Monto Bs', 'money'), col('avg_unit_bs', 'Costo unit. prom. Bs', 'cost')],
    async run(c) {
      const rows = await raw(c.tx, Prisma.sql`
        SELECT s.legal_name AS supplier, p.sku, p.name, SUM(l.quantity)::text AS quantity, round(SUM(l.net * d.exchange_rate), 4)::text AS amount_bs,
               round(SUM(l.net * d.exchange_rate) / NULLIF(SUM(l.quantity), 0), 6)::text AS avg_unit_bs
        FROM purchase_document_lines l
        JOIN purchase_documents d ON d.id = l.document_id AND d.company_id = l.company_id
        JOIN suppliers s ON s.id = d.supplier_id AND s.company_id = d.company_id
        JOIN products p ON p.id = l.product_id AND p.company_id = l.company_id
        WHERE d.company_id = ${cid(c)}
          AND ((d.doc_type = 'PURCHASE' AND d.status = 'CONFIRMED') OR (d.doc_type = 'DELIVERY_NOTE' AND d.status = 'CONFIRMED'))
          ${when(c.f.dateFrom, Prisma.sql`AND d.doc_date >= ${c.f.dateFrom}::date`)} ${when(c.f.dateTo, Prisma.sql`AND d.doc_date <= ${c.f.dateTo}::date`)}
          ${when(c.f.supplierId, Prisma.sql`AND d.supplier_id = ${c.f.supplierId}::uuid`)} ${when(c.f.productId, Prisma.sql`AND l.product_id = ${c.f.productId}::uuid`)}
        GROUP BY s.legal_name, p.sku, p.name ORDER BY s.legal_name, p.name`);
      return { rows, totals: { amount_bs: sum(rows, 'amount_bs') } };
    },
  },
  {
    category: 'suppliers', id: 'statistics', title: 'Estadísticas de compras por proveedor', description: 'Volumen, ticket promedio y participación por proveedor en el período.',
    filters: ['dateFrom', 'dateTo'],
    columns: [col('supplier', 'Proveedor'), col('docs', 'Documentos', 'int'), col('total_bs', 'Total Bs', 'money'), col('avg_bs', 'Ticket prom. Bs', 'money'), col('share_pct', 'Participación', 'pct'), col('last_purchase', 'Última compra', 'date')],
    async run(c) {
      const rows = await raw(c.tx, Prisma.sql`
        SELECT s.legal_name AS supplier, count(*)::int AS docs, round(SUM(d.total_base), 4)::text AS total_bs, round(AVG(d.total_base), 4)::text AS avg_bs, MAX(d.doc_date) AS last_purchase
        FROM purchase_documents d JOIN suppliers s ON s.id = d.supplier_id AND s.company_id = d.company_id
        WHERE d.company_id = ${cid(c)} AND d.doc_type = 'PURCHASE' AND d.status = 'CONFIRMED'
          ${when(c.f.dateFrom, Prisma.sql`AND d.doc_date >= ${c.f.dateFrom}::date`)} ${when(c.f.dateTo, Prisma.sql`AND d.doc_date <= ${c.f.dateTo}::date`)}
        GROUP BY s.legal_name ORDER BY SUM(d.total_base) DESC`);
      const total = rows.reduce((a, r) => a + Number(r.total_bs), 0);
      const out: Row[] = rows.map(r => ({ ...r, share_pct: total > 0 ? ((Number(r.total_bs) / total) * 100).toFixed(2) : '0' }));
      return { rows: out, totals: { docs: out.reduce((a, r) => a + Number(r.docs), 0), total_bs: total.toFixed(4) } };
    },
  },
  {
    category: 'suppliers', id: 'analysis', title: 'Análisis de proveedores', description: 'Volumen, plazo de crédito y última actividad.',
    filters: ['dateFrom', 'dateTo'],
    columns: [col('supplier', 'Proveedor'), col('credit_days', 'Días crédito', 'int'), col('purchases', 'Compras', 'int'), col('total_bs', 'Total Bs', 'money'), col('orders', 'Órdenes', 'int'), col('returns', 'Devoluciones', 'int'), col('last_activity', 'Última actividad', 'date')],
    async run(c) {
      const rows = await raw(c.tx, Prisma.sql`
        SELECT s.legal_name AS supplier, s.credit_days,
               count(*) FILTER (WHERE d.doc_type = 'PURCHASE' AND d.status = 'CONFIRMED')::int AS purchases,
               round(COALESCE(SUM(d.total_base) FILTER (WHERE d.doc_type = 'PURCHASE' AND d.status = 'CONFIRMED'), 0), 4)::text AS total_bs,
               count(*) FILTER (WHERE d.doc_type = 'ORDER' AND d.status <> 'CANCELLED')::int AS orders,
               count(*) FILTER (WHERE d.doc_type IN ('PURCHASE_RETURN', 'DELIVERY_NOTE_RETURN') AND d.status = 'CONFIRMED')::int AS returns,
               MAX(d.doc_date) FILTER (WHERE d.status <> 'CANCELLED') AS last_activity
        FROM suppliers s LEFT JOIN purchase_documents d ON d.supplier_id = s.id AND d.company_id = s.company_id
          ${when(c.f.dateFrom, Prisma.sql`AND d.doc_date >= ${c.f.dateFrom}::date`)} ${when(c.f.dateTo, Prisma.sql`AND d.doc_date <= ${c.f.dateTo}::date`)}
        WHERE s.company_id = ${cid(c)} AND s.deleted_at IS NULL GROUP BY s.id, s.legal_name, s.credit_days ORDER BY 4 DESC, 1`);
      return { rows, totals: { purchases: rows.reduce((a, r) => a + Number(r.purchases), 0), total_bs: sum(rows, 'total_bs') } };
    },
  },

  // ════════════════════════ COMPRAS ════════════════════════
  {
    category: 'purchases', id: 'list', title: 'Relación de compras', description: 'Documentos de compra del período.',
    filters: ['dateFrom', 'dateTo', 'supplierId', 'docType', 'status'],
    columns: [col('doc_date', 'Fecha', 'date'), col('type', 'Tipo'), col('number', 'Número'), col('supplier', 'Proveedor'), col('supplier_doc', 'Factura prov.'), col('status', 'Estado'), col('currency', 'Moneda'),
      col('rate', 'Tasa', 'cost'), col('subtotal', 'Subtotal', 'money'), col('tax', 'Impuesto', 'money'), col('total', 'Total', 'money'), col('total_bs', 'Total Bs', 'money')],
    async run(c) {
      const rows = await raw(c.tx, Prisma.sql`
        SELECT d.doc_date, d.doc_type AS type, d.number, s.legal_name AS supplier, d.supplier_doc_no AS supplier_doc, d.status, cu.code AS currency, d.exchange_rate::text AS rate,
               d.subtotal::text AS subtotal, d.tax_total::text AS tax, d.total::text AS total, d.total_base::text AS total_bs
        FROM purchase_documents d JOIN suppliers s ON s.id = d.supplier_id AND s.company_id = d.company_id JOIN currencies cu ON cu.id = d.currency_id
        WHERE d.company_id = ${cid(c)} AND d.status <> 'DRAFT'
          ${when(c.f.dateFrom, Prisma.sql`AND d.doc_date >= ${c.f.dateFrom}::date`)} ${when(c.f.dateTo, Prisma.sql`AND d.doc_date <= ${c.f.dateTo}::date`)}
          ${when(c.f.supplierId, Prisma.sql`AND d.supplier_id = ${c.f.supplierId}::uuid`)} ${when(c.f.docType, Prisma.sql`AND d.doc_type = ${c.f.docType}`)} ${when(c.f.status, Prisma.sql`AND d.status = ${c.f.status}`)}
        ORDER BY d.doc_date, d.number`);
      const typeName: Record<string, string> = { QUOTE: 'Cotización', ORDER: 'Orden', DELIVERY_NOTE: 'Nota de entrega', DELIVERY_NOTE_RETURN: 'Dev. nota', PURCHASE: 'Compra', PURCHASE_RETURN: 'Dev. compra' };
      const out = rows.map(r => ({ ...r, type: typeName[String(r.type)] ?? r.type }));
      return { rows: out, totals: { total_bs: sum(out.filter(r => r.type === 'Compra'), 'total_bs') } };
    },
  },
  {
    category: 'purchases', id: 'by-category', title: 'Compras por instancia', description: 'Cantidad y monto comprado por instancia (compras confirmadas y notas sin facturar).',
    filters: ['dateFrom', 'dateTo', 'supplierId'],
    columns: [col('category', 'Instancia'), col('quantity', 'Cantidad', 'qty'), col('amount_bs', 'Monto Bs', 'money'), col('share_pct', '% del total', 'pct')],
    async run(c) {
      const rows = await raw(c.tx, Prisma.sql`
        SELECT COALESCE(cat.name, 'Sin instancia') AS category, SUM(l.quantity)::text AS quantity, round(SUM(l.net * d.exchange_rate), 4)::text AS amount_bs
        FROM purchase_document_lines l
        JOIN purchase_documents d ON d.id = l.document_id AND d.company_id = l.company_id
        JOIN products p ON p.id = l.product_id AND p.company_id = l.company_id
        LEFT JOIN categories cat ON cat.id = p.category_id AND cat.company_id = p.company_id
        WHERE d.company_id = ${cid(c)}
          AND ((d.doc_type = 'PURCHASE' AND d.status = 'CONFIRMED') OR (d.doc_type = 'DELIVERY_NOTE' AND d.status = 'CONFIRMED'))
          ${when(c.f.dateFrom, Prisma.sql`AND d.doc_date >= ${c.f.dateFrom}::date`)} ${when(c.f.dateTo, Prisma.sql`AND d.doc_date <= ${c.f.dateTo}::date`)}
          ${when(c.f.supplierId, Prisma.sql`AND d.supplier_id = ${c.f.supplierId}::uuid`)}
        GROUP BY cat.name ORDER BY SUM(l.net * d.exchange_rate) DESC`);
      const total = rows.reduce((a, r) => a + Number(r.amount_bs), 0);
      const out: Row[] = rows.map(r => ({ ...r, share_pct: total > 0 ? ((Number(r.amount_bs) / total) * 100).toFixed(2) : '0' }));
      return { rows: out, totals: { amount_bs: total.toFixed(4) } };
    },
  },

  // ════════════════════════ CLIENTES / VENDEDORES ════════════════════════
  {
    category: 'customers', id: 'list', title: 'Listado de clientes', description: 'Maestro de clientes.',
    filters: ['search'],
    columns: [col('rif', 'RIF'), col('legal_name', 'Razón social'), col('trade_name', 'Nombre comercial'), col('special', 'Contrib. especial', 'bool'), col('retention', 'Retención IVA', 'pct'),
      col('credit_limit', 'Límite crédito', 'money'), col('credit_days', 'Días crédito', 'int'), col('seller', 'Vendedor'), col('email', 'Correo'), col('phone', 'Teléfono'), col('is_active', 'Activo', 'bool')],
    async run(c) {
      const rows = await raw(c.tx, Prisma.sql`
        SELECT cu.rif, cu.legal_name, cu.trade_name, cu.is_special_taxpayer AS special, cu.retention_iva_pct::text AS retention, cu.credit_limit::text AS credit_limit, cu.credit_days,
               se.name AS seller, cu.email, cu.phone, cu.is_active
        FROM customers cu LEFT JOIN sellers se ON se.id = cu.seller_id AND se.company_id = cu.company_id
        WHERE cu.company_id = ${cid(c)} AND cu.deleted_at IS NULL
          ${when(c.f.search, Prisma.sql`AND (cu.rif ILIKE ${'%' + c.f.search + '%'} OR cu.legal_name ILIKE ${'%' + c.f.search + '%'})`)}
        ORDER BY cu.legal_name`);
      return { rows };
    },
  },
  {
    category: 'sellers', id: 'list', title: 'Listado de vendedores', description: 'Maestro de vendedores con comisión y meta.',
    filters: [],
    columns: [col('code', 'Código'), col('name', 'Nombre'), col('zone', 'Zona'), col('commission', 'Comisión', 'pct'), col('goal', 'Meta mensual', 'money'), col('is_active', 'Activo', 'bool')],
    async run(c) {
      const rows = await raw(c.tx, Prisma.sql`
        SELECT s.code, s.name, z.name AS zone, s.commission_rate::text AS commission, s.monthly_goal::text AS goal, s.is_active
        FROM sellers s LEFT JOIN zones z ON z.id = s.zone_id AND z.company_id = s.company_id
        WHERE s.company_id = ${cid(c)} AND s.deleted_at IS NULL ORDER BY s.name`);
      return { rows };
    },
  },
];

export const findReport = (category: string, id: string) => REPORTS.find(r => r.category === category && r.id === id);
