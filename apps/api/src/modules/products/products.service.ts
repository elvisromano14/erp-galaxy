import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { decimalStr, paginationQuery, uuid } from '@erp/contracts';
import { D, Decimal, round } from '@erp/domain';
import { PrismaService } from '../../common/db/prisma.service';
import { AuditService } from '../../common/audit/audit.service';
import { BusinessRuleException, NotFoundError, ValidationError } from '../../common/errors/errors';
import { Paged } from '../../common/http/paged';
import { ExchangeRatesService } from '../catalogs/exchange-rates';

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const barcode = z.string().trim().min(1).max(64);
const reference = z.object({ refType: z.enum(['OEM', 'EQUIVALENT', 'ALTERNATE']).default('OEM'), code: z.string().trim().min(1).max(64), brand: z.string().trim().max(80).nullable().optional() });
const uom = z.object({ name: z.string().trim().min(1).max(50), factor: decimalStr.refine(v => Number(v) > 0, 'factor > 0'), barcode: barcode.nullable().optional() });
const price = z.object({ priceListId: uuid, price: decimalStr.refine(v => Number(v) >= 0, 'precio >= 0'), validFrom: date.optional() });

export const createProductSchema = z.object({
  sku: z.string().trim().min(1).max(60),
  name: z.string().trim().min(1).max(250),
  description: z.string().trim().max(2000).nullable().optional(),
  categoryId: uuid.nullable().optional(),
  unitId: uuid,
  taxId: uuid.nullable().optional(),
  trackingMode: z.enum(['NONE', 'LOT', 'SERIAL']).default('NONE'),
  hasExpiry: z.boolean().default(false),
  isService: z.boolean().default(false),
  minStock: decimalStr.optional(),
  maxStock: decimalStr.optional(),
  isActive: z.boolean().default(true),
  barcodes: z.array(barcode).optional(),
  references: z.array(reference).optional(),
  uoms: z.array(uom).optional(),
  prices: z.array(price).optional(),
});
export const updateProductSchema = createProductSchema.partial().extend({ version: z.number().int().optional() });
export const listProductsSchema = paginationQuery.extend({
  trackingMode: z.enum(['NONE', 'LOT', 'SERIAL']).optional(),
  categoryId: uuid.optional(), isActive: z.coerce.boolean().optional(), isService: z.coerce.boolean().optional(), includeDeleted: z.coerce.boolean().optional(),
});
export const bulkPriceSchema = z.object({
  priceListId: uuid,
  mode: z.enum(['PERCENT', 'MARGIN', 'SET']),
  /** PERCENT: variación en % (puede ser negativa) · MARGIN: margen sobre costo en % · SET: precio fijo. */
  value: decimalStr,
  sourcePriceListId: uuid.optional(),
  categoryId: uuid.optional(),
  productIds: z.array(uuid).max(5000).optional(),
  validFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  decimals: z.number().int().min(0).max(4).default(2),
  dryRun: z.boolean().default(true),
}).refine(v => v.mode !== 'SET' || Number(v.value) >= 0, { message: 'El precio fijo no puede ser negativo', path: ['value'] })
  .refine(v => v.mode === 'SET' || Number(v.value) > -100, { message: 'La variación debe ser mayor que -100 %', path: ['value'] });

export const addPriceSchema = price;

@Injectable()
export class ProductsService {
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService, private readonly rates: ExchangeRatesService) {}

  private async assertFeatures(d: { trackingMode?: string; hasExpiry?: boolean; isService?: boolean }) {
    const company = await this.prisma.company.findUniqueOrThrow({ where: { id: this.prisma.companyId } });
    const f = company.features as Record<string, boolean>;
    if (d.trackingMode === 'SERIAL' && !f.serials) throw new BusinessRuleException('La empresa no tiene habilitado el control por seriales', 'FEATURE_DISABLED', [{ field: 'trackingMode', code: 'SERIALS_DISABLED' }]);
    if (d.trackingMode === 'LOT' && !f.lots) throw new BusinessRuleException('La empresa no tiene habilitado el control por lotes', 'FEATURE_DISABLED', [{ field: 'trackingMode', code: 'LOTS_DISABLED' }]);
    if (d.hasExpiry && !f.expiry) throw new BusinessRuleException('La empresa no tiene habilitado el vencimiento', 'FEATURE_DISABLED', [{ field: 'hasExpiry', code: 'EXPIRY_DISABLED' }]);
    if (d.hasExpiry && d.trackingMode !== 'LOT') throw new BusinessRuleException('El vencimiento requiere control por lotes', 'INVALID_TRACKING');
    if (d.isService && d.trackingMode && d.trackingMode !== 'NONE') throw new BusinessRuleException('Un servicio no puede tener lotes/seriales', 'INVALID_TRACKING');
  }

  async list(q: z.infer<typeof listProductsSchema>) {
    const tx = this.prisma.tx;
    const where: any = {};
    if (!q.includeDeleted) where.deletedAt = null;
    if (q.categoryId) where.categoryId = q.categoryId;
    if (q.trackingMode) where.trackingMode = q.trackingMode;
    if (q.isActive !== undefined) where.isActive = q.isActive;
    if (q.isService !== undefined) where.isService = q.isService;
    if (q.search) {
      const [bc, refs] = await Promise.all([
        tx.productBarcode.findMany({ where: { barcode: q.search }, select: { productId: true } }),
        tx.productReference.findMany({ where: { code: { contains: q.search, mode: 'insensitive' } }, select: { productId: true }, take: 200 }),
      ]);
      where.OR = [
        { sku: { contains: q.search, mode: 'insensitive' } },
        { name: { contains: q.search, mode: 'insensitive' } },
        { id: { in: [...bc, ...refs].map(x => x.productId) } },
      ];
    }
    const sort = q.sort ?? 'name';
    const orderBy = sort.split(',').map(s => {
      const desc = s.startsWith('-'); const f = desc ? s.slice(1) : s;
      if (!['sku', 'name', 'createdAt'].includes(f)) throw new ValidationError(`Orden no permitido: ${f}`);
      return { [f]: desc ? 'desc' : 'asc' };
    });
    const [rows, total] = await Promise.all([
      tx.product.findMany({ where, orderBy, skip: (q.page - 1) * q.limit, take: q.limit }),
      tx.product.count({ where }),
    ]);
    return Paged.of(rows, total, q.page, q.limit);
  }

  async get(id: string) {
    const tx = this.prisma.tx;
    const product = await tx.product.findFirst({ where: { id } });
    if (!product) throw new NotFoundError('Producto', id);
    const [barcodes, references, uoms, prices] = await Promise.all([
      tx.productBarcode.findMany({ where: { productId: id }, orderBy: { barcode: 'asc' } }),
      tx.productReference.findMany({ where: { productId: id }, orderBy: { code: 'asc' } }),
      tx.productUom.findMany({ where: { productId: id } }),
      this.currentPrices(id),
    ]);
    return { ...product, barcodes: barcodes.map(b => b.barcode), references, uoms, prices };
  }

  /** Último precio vigente por lista (validFrom <= hoy). */
  private async currentPrices(productId: string) {
    const rows = await this.prisma.tx.productPrice.findMany({
      where: { productId, validFrom: { lte: new Date(new Date().toISOString().slice(0, 10)) } },
      orderBy: [{ priceListId: 'asc' }, { validFrom: 'desc' }],
    });
    const seen = new Set<string>();
    return rows.filter(r => !seen.has(r.priceListId) && seen.add(r.priceListId));
  }

  async create(input: z.infer<typeof createProductSchema>) {
    const tx = this.prisma.tx;
    const companyId = this.prisma.companyId;
    await this.assertFeatures(input);
    const { barcodes, references, uoms, prices, ...data } = input;
    const product = await tx.product.create({ data: { ...data, companyId, createdBy: this.prisma.userId, updatedBy: this.prisma.userId } });
    await this.replaceChildren(product.id, { barcodes, references, uoms });
    for (const p of prices ?? []) await this.addPrice(product.id, p);
    await this.audit.log('product', product.id, 'CREATE', input);
    return this.get(product.id);
  }

  async update(id: string, input: z.infer<typeof updateProductSchema>) {
    const tx = this.prisma.tx;
    const current = await tx.product.findFirst({ where: { id } });
    if (!current) throw new NotFoundError('Producto', id);
    const { barcodes, references, uoms, prices, version, ...data } = input;
    if (version !== undefined && version !== current.version) {
      throw new BusinessRuleException('El producto fue modificado por otro usuario', 'VERSION_CONFLICT', [{ field: 'version', code: 'STALE' }]);
    }
    await this.assertFeatures({
      trackingMode: data.trackingMode ?? current.trackingMode, hasExpiry: data.hasExpiry ?? current.hasExpiry, isService: data.isService ?? current.isService,
    });
    // Cambiar el control de lotes con existencias rompería el saldo por lote.
    if (data.trackingMode && data.trackingMode !== current.trackingMode) {
      const stock = await tx.inventoryStock.findFirst({ where: { productId: id, NOT: { quantity: 0 } } });
      if (stock) throw new BusinessRuleException('No se puede cambiar el control de lotes de un producto con existencias', 'TRACKING_LOCKED');
    }
    await tx.product.update({ where: { id }, data: { ...data, updatedBy: this.prisma.userId, version: { increment: 1 } } });
    await this.replaceChildren(id, { barcodes, references, uoms });
    for (const p of prices ?? []) await this.addPrice(id, p);
    await this.audit.log('product', id, 'UPDATE', input);
    return this.get(id);
  }

  private async replaceChildren(productId: string, c: { barcodes?: string[]; references?: z.infer<typeof reference>[]; uoms?: z.infer<typeof uom>[] }) {
    const tx = this.prisma.tx;
    const companyId = this.prisma.companyId;
    if (c.barcodes) {
      const uniq = [...new Set(c.barcodes)];
      await tx.productBarcode.deleteMany({ where: { productId } });
      if (uniq.length) await tx.productBarcode.createMany({ data: uniq.map(b => ({ companyId, productId, barcode: b })) });
    }
    if (c.references) {
      await tx.productReference.deleteMany({ where: { productId } });
      if (c.references.length) await tx.productReference.createMany({ data: c.references.map(r => ({ companyId, productId, refType: r.refType, code: r.code, brand: r.brand ?? null })) });
    }
    if (c.uoms) {
      await tx.productUom.deleteMany({ where: { productId } });
      if (c.uoms.length) await tx.productUom.createMany({ data: c.uoms.map(u => ({ companyId, productId, name: u.name, factor: u.factor, barcode: u.barcode ?? null })) });
    }
  }

  /** Alta de precio: si ya hay uno para (producto, lista, fecha) se actualiza; todo cambio queda auditado. */
  async addPrice(productId: string, p: z.infer<typeof price>) {
    const tx = this.prisma.tx;
    const companyId = this.prisma.companyId;
    const validFrom = new Date(p.validFrom ?? new Date().toISOString().slice(0, 10));
    const where = { companyId_productId_priceListId_validFrom: { companyId, productId, priceListId: p.priceListId, validFrom } };
    const previous = await tx.productPrice.findUnique({ where });
    const row = await tx.productPrice.upsert({
      where,
      update: { price: p.price, createdBy: this.prisma.userId },
      create: { companyId, productId, priceListId: p.priceListId, price: p.price, validFrom, createdBy: this.prisma.userId },
    });
    await this.audit.log('product_price', row.id, previous ? 'UPDATE' : 'CREATE', { productId, ...p, previous: previous?.price.toString() });
    return row;
  }

  /**
   * Actualización masiva de precios de una lista (S14). `dryRun` (por omisión) solo calcula la vista previa.
   *  PERCENT: precio vigente × (1 + valor %) · MARGIN: costo promedio × (1 + margen %) en la moneda de la lista · SET: precio fijo.
   * Productos sin base de cálculo (sin precio vigente / sin costo) se omiten y se informan.
   */
  async bulkPrices(input: z.infer<typeof bulkPriceSchema>) {
    const tx = this.prisma.tx;
    const companyId = this.prisma.companyId;
    const list = await tx.priceList.findFirst({ where: { id: input.priceListId, deletedAt: null } });
    if (!list) throw new BusinessRuleException('Lista de precios inexistente', 'PRICE_LIST_NOT_FOUND');
    const validFrom = new Date(input.validFrom ?? new Date().toISOString().slice(0, 10));
    const products = await tx.product.findMany({
      where: { deletedAt: null, isActive: true, isService: false, ...(input.categoryId ? { categoryId: input.categoryId } : {}), ...(input.productIds?.length ? { id: { in: input.productIds } } : {}) },
      select: { id: true, sku: true, name: true }, orderBy: { sku: 'asc' }, take: 5001,
    });
    if (products.length > 5000) throw new BusinessRuleException('Demasiados productos (máximo 5000); filtre por instancia', 'TOO_MANY_PRODUCTS');
    if (!products.length) throw new BusinessRuleException('Ningún producto coincide con el filtro', 'NO_PRODUCTS');
    const ids = products.map(p => p.id);
    // precio vigente (a la fecha de vigencia) por producto en la lista base
    const baseListId = input.sourcePriceListId ?? list.id;
    const current = new Map<string, Decimal>();
    for (const r of await tx.productPrice.findMany({ where: { productId: { in: ids }, priceListId: baseListId, validFrom: { lte: validFrom } }, orderBy: [{ validFrom: 'asc' }, { createdAt: 'asc' }] })) current.set(r.productId, D(r.price.toString()));
    const own = new Map<string, Decimal>();
    for (const r of await tx.productPrice.findMany({ where: { productId: { in: ids }, priceListId: list.id, validFrom: { lte: validFrom } }, orderBy: [{ validFrom: 'asc' }, { createdAt: 'asc' }] })) own.set(r.productId, D(r.price.toString()));

    let costFactor = D(1);
    const costs = new Map<string, Decimal>();
    if (input.mode === 'MARGIN') {
      const company = await tx.company.findUniqueOrThrow({ where: { id: companyId } });
      for (const c of await tx.productCost.findMany({ where: { productId: { in: ids } } })) costs.set(c.productId, D(c.avgCost.toString()));
      if (company.valuationCurrencyId !== list.currencyId) {
        const [rv, rl] = await Promise.all([this.rates.rateFor(company.valuationCurrencyId, validFrom), this.rates.rateFor(list.currencyId, validFrom)]);
        if (!rv || !rl) throw new BusinessRuleException('Falta la tasa de cambio para convertir el costo a la moneda de la lista', 'RATE_NOT_FOUND');
        costFactor = D(rv.rate).div(D(rl.rate));
      }
    }
    const factor = D(1).plus(D(input.value).div(100));
    const rows: { productId: string; sku: string; name: string; oldPrice: string | null; newPrice: string | null; skipped?: string }[] = [];
    for (const p of products) {
      let next: Decimal | null = null; let skipped: string | undefined;
      if (input.mode === 'SET') next = D(input.value);
      else if (input.mode === 'PERCENT') { const base = current.get(p.id); if (base === undefined) skipped = 'SIN_PRECIO_BASE'; else next = base.mul(factor); }
      else { const c = costs.get(p.id); if (!c || c.lte(0)) skipped = 'SIN_COSTO'; else next = c.mul(costFactor).mul(factor); }
      if (next) { next = round(next, input.decimals); if (next.isNegative()) { next = null; skipped = 'PRECIO_NEGATIVO'; } }
      const old = own.get(p.id);
      rows.push({ productId: p.id, sku: p.sku, name: p.name, oldPrice: old?.toString() ?? null, newPrice: next?.toString() ?? null, ...(skipped ? { skipped } : {}) });
    }
    const changes = rows.filter(r => r.newPrice !== null && r.newPrice !== r.oldPrice);
    if (!input.dryRun) {
      for (const r of changes) await this.addPrice(r.productId, { priceListId: list.id, price: r.newPrice!, validFrom: validFrom.toISOString().slice(0, 10) });
      await this.audit.log('price_list', list.id, 'BULK_UPDATE', { mode: input.mode, value: input.value, changed: changes.length });
    }
    return { dryRun: input.dryRun, priceListId: list.id, validFrom: validFrom.toISOString().slice(0, 10), total: rows.length, changed: changes.length, skipped: rows.filter(r => r.skipped).length, rows };
  }

  async priceHistory(productId: string) {
    await this.get(productId);
    return this.prisma.tx.productPrice.findMany({ where: { productId }, orderBy: [{ validFrom: 'desc' }, { createdAt: 'desc' }] });
  }

  async remove(id: string) {
    const p = await this.prisma.tx.product.findFirst({ where: { id } });
    if (!p) throw new NotFoundError('Producto', id);
    const stock = await this.prisma.tx.inventoryStock.findFirst({ where: { productId: id, NOT: { quantity: 0 } } });
    if (stock) throw new BusinessRuleException('No se puede eliminar un producto con existencias', 'PRODUCT_HAS_STOCK');
    await this.prisma.tx.product.update({ where: { id }, data: { deletedAt: new Date(), isActive: false } });
    await this.audit.log('product', id, 'DELETE');
  }

  async restore(id: string) {
    const p = await this.prisma.tx.product.findFirst({ where: { id } });
    if (!p) throw new NotFoundError('Producto', id);
    await this.prisma.tx.product.update({ where: { id }, data: { deletedAt: null, isActive: true } });
    await this.audit.log('product', id, 'RESTORE');
    return this.get(id);
  }
}
