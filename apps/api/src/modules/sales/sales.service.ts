import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { calcDocument, D, round, toBase, ZERO } from '@erp/domain';
import { PrismaService } from '../../common/db/prisma.service';
import { AuditService } from '../../common/audit/audit.service';
import { SequenceService } from '../../common/db/sequence.service';
import { BusinessRuleException, ConflictError, NotFoundError } from '../../common/errors/errors';
import { Paged } from '../../common/http/paged';
import { ExchangeRatesService } from '../catalogs/exchange-rates';
import { ReceivablesService } from '../treasury/receivables.service';
import { caracasToday } from '../inventory/inventory-docs.service';
import { SalesDocInput, SalesDocType, salesListSchema, SALES_ROUTES, Viewer } from './sales.types';

/** Estados en los que el documento "cuenta" (para validar hijos activos). */
const ACTIVE = ['DRAFT', 'SENT', 'ACCEPTED', 'CONFIRMED', 'CONVERTED'];
/** Estados de pedido/factura que "consumen" cantidades de su documento origen (borradores incluidos al validar). */
const QTY_STATES = ['DRAFT', 'CONFIRMED'];
/** Orígenes permitidos por tipo de documento. */
const PARENTS_OF: Partial<Record<SalesDocType, SalesDocType[]>> = { BUDGET: ['QUOTE'], ORDER: ['QUOTE', 'BUDGET'], INVOICE: ['ORDER'], CREDIT_NOTE: ['INVOICE'] };
const QTY_TYPES: SalesDocType[] = ['INVOICE', 'CREDIT_NOTE'];

@Injectable()
export class SalesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly seq: SequenceService,
    private readonly rates: ExchangeRatesService,
    private readonly receivables: ReceivablesService,
  ) {}

  entity(t: SalesDocType) { return `sales_${t.toLowerCase()}`; }
  route(t: SalesDocType) { return SALES_ROUTES.find(r => r.docType === t)!; }

  // ═════════════════════════ visibilidad ═════════════════════════

  /** Sin `sales:documents:read-all` solo se ven los documentos propios o de los vendedores ligados al usuario. */
  private async viewerWhere(v: Viewer): Promise<Prisma.SalesDocumentWhereInput> {
    if (v.all) return {};
    const mine = await this.prisma.tx.seller.findMany({ where: { userId: v.userId }, select: { id: true } });
    return { OR: [{ createdBy: v.userId }, ...(mine.length ? [{ sellerId: { in: mine.map(s => s.id) } }] : [])] };
  }

  async find(docType: SalesDocType, id: string, v: Viewer, lock = false) {
    const tx = this.prisma.tx;
    if (lock) await tx.$queryRaw`SELECT id FROM sales_documents WHERE id = ${id}::uuid AND company_id = ${this.prisma.companyId}::uuid FOR UPDATE`;
    const doc = await tx.salesDocument.findFirst({ where: { AND: [{ id, docType }, await this.viewerWhere(v)] } });
    if (!doc) throw new NotFoundError('Documento', id);
    return doc;
  }

  // ═════════════════════════ consultas ═════════════════════════

  async get(docType: SalesDocType, id: string, v: Viewer) {
    const tx = this.prisma.tx;
    const doc = await this.find(docType, id, v);
    const lines = await tx.salesDocumentLine.findMany({ where: { documentId: id }, orderBy: { lineNo: 'asc' } });
    const lineLinks = await tx.documentLinkLine.findMany({ where: { childLineId: { in: lines.map(l => l.id) } } });
    const parentLineOf = new Map(lineLinks.map(x => [x.childLineId, x.parentLineId]));
    const [products, customer, seller, parents, children] = await Promise.all([
      tx.product.findMany({ where: { id: { in: lines.map(l => l.productId) } }, select: { id: true, sku: true, name: true } }),
      tx.customer.findFirst({ where: { id: doc.customerId }, select: { id: true, rif: true, legalName: true } }),
      doc.sellerId ? tx.seller.findFirst({ where: { id: doc.sellerId }, select: { id: true, code: true, name: true } }) : null,
      tx.documentLink.findMany({ where: { childId: id } }),
      tx.documentLink.findMany({ where: { parentId: id } }),
    ]);
    const pm = new Map(products.map(p => [p.id, p]));
    const extra: Record<string, unknown> = {};
    if (docType === 'ORDER') {
      const inv = await this.consumed(lines.map(l => l.id), ['INVOICE'], ['CONFIRMED']);
      extra.lineStatus = lines.map(l => ({ lineId: l.id, ordered: l.quantity.toString(), invoiced: (inv.get(l.id) ?? ZERO).toString(), pending: D(l.quantity.toString()).minus(inv.get(l.id) ?? ZERO).toString() }));
    }
    if (docType === 'INVOICE') {
      const cn = await this.consumed(lines.map(l => l.id), ['CREDIT_NOTE'], ['CONFIRMED']);
      extra.lineStatus = lines.map(l => ({ lineId: l.id, quantity: l.quantity.toString(), credited: (cn.get(l.id) ?? ZERO).toString(), available: D(l.quantity.toString()).minus(cn.get(l.id) ?? ZERO).toString() }));
      extra.payments = await tx.salesDocumentPayment.findMany({ where: { documentId: id }, orderBy: { createdAt: 'asc' } });
      extra.receivable = await tx.receivableEntry.findMany({ where: { sourceType: 'SALES_INVOICE', sourceId: id } });
    }
    return {
      ...doc, ...extra, customer, seller,
      lines: lines.map(l => ({ ...l, parentLineId: parentLineOf.get(l.id) ?? null, product: pm.get(l.productId) })),
      links: { parents: parents.map(p => ({ type: p.parentType, id: p.parentId })), children: children.map(c => ({ type: c.childType, id: c.childId })) },
    };
  }

  async list(docType: SalesDocType, q: z.infer<typeof salesListSchema>, v: Viewer) {
    const tx = this.prisma.tx;
    const and: Prisma.SalesDocumentWhereInput[] = [{ docType }, await this.viewerWhere(v)];
    if (q.status) and.push({ status: { in: q.status.split(',') } });
    if (q.customerId) and.push({ customerId: q.customerId });
    if (q.sellerId) and.push({ sellerId: q.sellerId });
    if (q.dateFrom || q.dateTo) and.push({ docDate: { ...(q.dateFrom ? { gte: new Date(q.dateFrom) } : {}), ...(q.dateTo ? { lte: new Date(q.dateTo) } : {}) } });
    if (q.search) {
      const cust = await tx.customer.findMany({
        where: { OR: [{ legalName: { contains: q.search, mode: 'insensitive' } }, { rif: { contains: q.search, mode: 'insensitive' } }] }, select: { id: true }, take: 200,
      });
      and.push({ OR: [{ number: { contains: q.search, mode: 'insensitive' } }, { customerId: { in: cust.map(c => c.id) } }] });
    }
    const where = { AND: and };
    const [rows, total] = await Promise.all([
      tx.salesDocument.findMany({ where, orderBy: [{ createdAt: 'desc' }], skip: (q.page - 1) * q.limit, take: q.limit }),
      tx.salesDocument.count({ where }),
    ]);
    const cust = new Map((await tx.customer.findMany({ where: { id: { in: [...new Set(rows.map(r => r.customerId))] } }, select: { id: true, legalName: true, rif: true } })).map(c => [c.id, c]));
    return Paged.of(rows.map(r => ({ ...r, customer: cust.get(r.customerId) ?? null })), total, q.page, q.limit);
  }

  // ═════════════════════════ precios y líneas ═════════════════════════

  async rateOf(currencyId: string, date: Date) {
    const r = await this.rates.rateFor(currencyId, date);
    if (!r) throw new BusinessRuleException('No hay tasa de cambio para la moneda y fecha del documento', 'RATE_NOT_FOUND');
    return D(r.rate);
  }

  async resolveRate(input: { currencyId: string; exchangeRate?: string }, docDate: Date) {
    if (input.exchangeRate) {
      const cur = await this.prisma.db.currency.findUnique({ where: { id: input.currencyId } });
      if (!cur) throw new BusinessRuleException('Moneda inexistente', 'CURRENCY_NOT_FOUND');
      return cur.code === 'VES' ? '1' : input.exchangeRate;
    }
    return (await this.rateOf(input.currencyId, docDate)).toString();
  }

  /** Lista de precios efectiva: la del documento, la del cliente o la predeterminada de la empresa. */
  private async effectivePriceList(input: SalesDocInput, customerPriceListId: string | null) {
    const tx = this.prisma.tx;
    const where = input.priceListId ?? customerPriceListId
      ? { id: (input.priceListId ?? customerPriceListId)!, deletedAt: null }
      : { isDefault: true, deletedAt: null };
    const list = await tx.priceList.findFirst({ where });
    if (input.priceListId && !list) throw new BusinessRuleException('Lista de precios inexistente', 'PRICE_LIST_NOT_FOUND');
    return list;
  }

  async buildLines(docType: SalesDocType, input: SalesDocInput, docDate: Date, exchangeRate: string, customerPriceListId: string | null) {
    const tx = this.prisma.tx;
    const productIds = [...new Set(input.lines.map(l => l.productId))];
    const products = new Map((await tx.product.findMany({ where: { id: { in: productIds }, deletedAt: null } })).map(p => [p.id, p]));
    const taxIds = [...new Set(input.lines.map(l => l.taxId ?? products.get(l.productId)?.taxId).filter(Boolean) as string[])];
    const taxes = new Map((await tx.tax.findMany({ where: { id: { in: taxIds }, deletedAt: null } })).map(t => [t.id, t]));
    const list = await this.effectivePriceList(input, customerPriceListId);
    // Factor de conversión lista → moneda del documento (ambas pasan por bolívares).
    let factor = D(1);
    if (list && list.currencyId !== input.currencyId) {
      factor = (await this.rateOf(list.currencyId, docDate)).div(D(exchangeRate));
    }

    const resolved = [] as { l: SalesDocInput['lines'][number]; price: string; taxId: string | null; serials: string[]; tax?: (typeof taxes extends Map<string, infer T> ? T : never) }[];
    for (const [i, l] of input.lines.entries()) {
      const bad = (code: string, msg: string) => new BusinessRuleException(msg, code, [{ field: `lines[${i}]`, code }]);
      const p = products.get(l.productId);
      if (!p) throw bad('PRODUCT_NOT_FOUND', 'Producto inexistente');
      if (!p.isActive) throw bad('PRODUCT_INACTIVE', `El producto ${p.sku} está inactivo`);
      const taxId = l.taxId ?? p.taxId ?? null;
      const tax = taxId ? taxes.get(taxId) : undefined;
      if (taxId && !tax) throw bad('TAX_NOT_FOUND', 'Impuesto inexistente');
      if (tax && (tax.validFrom > docDate || (tax.validTo && tax.validTo < docDate))) throw bad('TAX_NOT_VALID', `El impuesto ${tax.code} no está vigente en la fecha del documento`);
      let price = l.unitPrice;
      if (price === undefined) {
        const pp = list ? await tx.productPrice.findFirst({ where: { productId: p.id, priceListId: list.id, validFrom: { lte: docDate } }, orderBy: { validFrom: 'desc' } }) : null;
        if (!pp) throw bad('PRICE_NOT_FOUND', `El producto ${p.sku} no tiene precio en la lista${list ? ` ${list.code}` : ''}: indique el precio`);
        price = round(D(pp.price.toString()).mul(factor), 6).toString();
      }
      // Series: solo facturas/notas; el producto por serial exige tantos seriales como unidades.
      const nos = (l.serials ?? []).map(x => x.trim());
      if (QTY_TYPES.includes(docType)) {
        if (p.trackingMode !== 'SERIAL' && nos.length) throw bad('SERIALS_NOT_ALLOWED', `El producto ${p.sku} no se controla por seriales`);
        if (p.trackingMode === 'SERIAL' && (docType === 'INVOICE' || docType === 'CREDIT_NOTE')) {
          if (new Set(nos).size !== nos.length) throw bad('DUPLICATE_SERIAL', `Hay seriales repetidos para ${p.sku}`);
          // En borrador pueden faltar (se exigen al emitir); si vienen, deben cuadrar con la cantidad.
          if (nos.length && !D(l.quantity).eq(nos.length)) throw bad('SERIAL_COUNT_MISMATCH', `La cantidad (${l.quantity}) no coincide con los seriales indicados (${nos.length}) para ${p.sku}`);
        }
      }
      resolved.push({ l, price, taxId, tax, serials: QTY_TYPES.includes(docType) ? nos : [] });
    }

    const totals = calcDocument(resolved.map(r => ({
      quantity: r.l.quantity, unitPrice: r.price, discountPct: r.l.discountPct ?? 0,
      taxRate: r.tax?.rate.toString() ?? '0', taxExempt: !r.tax || r.tax.kind === 'EXEMPT' || r.tax.kind === 'EXONERATED',
    })));
    const lines = resolved.map((r, i) => ({
      productId: r.l.productId, description: r.l.description ?? null, quantity: r.l.quantity, unitPrice: r.price,
      discountPct: r.l.discountPct ?? '0', taxId: r.taxId, taxRate: totals.lines[i].taxRate.toString(),
      net: totals.lines[i].net.toFixed(4), tax: totals.lines[i].tax.toFixed(4), total: totals.lines[i].total.toFixed(4),
      parentLineId: r.l.parentLineId ?? null, serials: r.serials,
    }));
    return { lines, totals, priceListId: list?.id ?? null };
  }

  async validateHeader(docType: SalesDocType, input: SalesDocInput) {
    const tx = this.prisma.tx;
    const customer = await tx.customer.findFirst({ where: { id: input.customerId, deletedAt: null } });
    if (!customer) throw new BusinessRuleException('Cliente inexistente', 'CUSTOMER_NOT_FOUND');
    if (!customer.isActive) throw new BusinessRuleException('El cliente está inactivo', 'CUSTOMER_INACTIVE');
    if (input.sellerId) {
      const s = await tx.seller.findFirst({ where: { id: input.sellerId, deletedAt: null, isActive: true } });
      if (!s) throw new BusinessRuleException('Vendedor inexistente o inactivo', 'SELLER_NOT_FOUND');
    }
    if (input.warehouseId) {
      const wh = await tx.warehouse.findFirst({ where: { id: input.warehouseId, deletedAt: null, isActive: true } });
      if (!wh) throw new BusinessRuleException('Depósito inexistente o inactivo', 'WAREHOUSE_NOT_FOUND');
    }
    if ((docType === 'INVOICE' || docType === 'CREDIT_NOTE') && !input.warehouseId) throw new BusinessRuleException('La factura requiere depósito', 'WAREHOUSE_REQUIRED', [{ field: 'warehouseId', code: 'REQUIRED' }]);
    if (input.reservesStock) {
      if (docType === 'QUOTE' || QTY_TYPES.includes(docType)) throw new BusinessRuleException('Las cotizaciones no reservan existencias', 'RESERVE_NOT_ALLOWED');
      if (!input.warehouseId) throw new BusinessRuleException('Para reservar existencias indique el depósito', 'WAREHOUSE_REQUIRED');
    }
    if (input.paymentCondition === 'CREDIT' && input.creditDays === 0) input.creditDays = customer.creditDays;
    return customer;
  }

  /** Valida el documento origen (tipo, estado, cliente, líneas y cantidades) y que no tenga otro hijo activo. */
  async validateParent(docType: SalesDocType, input: SalesDocInput, excludeDocId?: string) {
    const allowed = PARENTS_OF[docType];
    const withParent = input.lines.filter(l => l.parentLineId);
    if (!allowed) {
      if (input.parentId || withParent.length) throw new BusinessRuleException('Este documento no admite documento origen', 'PARENT_NOT_ALLOWED');
      return null;
    }
    if (!input.parentId) {
      if (withParent.length) throw new BusinessRuleException('Las líneas con origen requieren parentId', 'PARENT_REQUIRED');
      return null;
    }
    const tx = this.prisma.tx;
    const parent = await tx.salesDocument.findFirst({ where: { id: input.parentId, docType: { in: allowed } } });
    if (!parent) throw new BusinessRuleException(`El documento origen debe ser ${allowed.join(' o ')}`, 'INVALID_PARENT');
    const okState = (parent.docType === 'QUOTE' && parent.status === 'ACCEPTED') || (parent.docType === 'BUDGET' && ['CONFIRMED', 'CONVERTED'].includes(parent.status))
      || (parent.docType === 'ORDER' && ['CONFIRMED', 'PARTIALLY_INVOICED'].includes(parent.status)) || (parent.docType === 'INVOICE' && parent.status === 'CONFIRMED');
    if (!okState) throw new BusinessRuleException(`El documento origen está ${parent.status}`, 'INVALID_PARENT_STATE');
    if (parent.customerId !== input.customerId) throw new BusinessRuleException('El cliente no coincide con el documento origen', 'CUSTOMER_MISMATCH');
    const sibling = QTY_TYPES.includes(docType) ? [] : await tx.documentLink.findMany({ where: { parentId: parent.id, childId: excludeDocId ? { not: excludeDocId } : undefined } });
    if (sibling.length) {
      const alive = await tx.salesDocument.count({ where: { id: { in: sibling.map(s => s.childId) }, status: { not: 'CANCELLED' } } });
      if (alive) throw new ConflictError('El documento origen ya fue convertido', 'ALREADY_CONVERTED');
    }
    const parentLines = new Map((await tx.salesDocumentLine.findMany({ where: { documentId: parent.id } })).map(l => [l.id, l]));
    const asked = new Map<string, ReturnType<typeof D>>();
    input.lines.forEach((l, i) => {
      if (!l.parentLineId) return;
      const pl = parentLines.get(l.parentLineId);
      if (!pl) throw new BusinessRuleException('La línea origen no pertenece al documento origen', 'INVALID_PARENT_LINE', [{ field: `lines[${i}]`, code: 'INVALID_PARENT_LINE' }]);
      if (pl.productId !== l.productId) throw new BusinessRuleException('El producto no coincide con la línea origen', 'PRODUCT_MISMATCH', [{ field: `lines[${i}]`, code: 'PRODUCT_MISMATCH' }]);
      asked.set(pl.id, (asked.get(pl.id) ?? ZERO).plus(D(l.quantity)));
    });
    if (docType === 'CREDIT_NOTE' && withParent.length !== input.lines.length) throw new BusinessRuleException('Toda línea de una nota de crédito debe indicar parentLineId', 'PARENT_LINE_REQUIRED');
    const used = QTY_TYPES.includes(docType) ? await this.consumed([...parentLines.keys()], [docType], QTY_STATES, excludeDocId) : new Map<string, ReturnType<typeof D>>();
    for (const [lineId, qty] of asked) {
      const available = D(parentLines.get(lineId)!.quantity.toString()).minus(used.get(lineId) ?? ZERO);
      if (qty.gt(available)) throw new BusinessRuleException(`Cantidad excede lo disponible del documento origen (${available.toString()})`, 'EXCEEDS_PARENT_QUANTITY', [{ code: 'EXCEEDS_PARENT_QUANTITY', message: lineId }]);
    }
    return parent;
  }

  /** Σ cantidades de líneas hijas por línea padre (solo hijos de los tipos/estados indicados). */
  async consumed(parentLineIds: string[], childTypes: string[], statuses: string[], excludeChildDocId?: string) {
    const out = new Map<string, ReturnType<typeof D>>();
    if (!parentLineIds.length) return out;
    const exclude = excludeChildDocId ? Prisma.sql`AND c.id <> ${excludeChildDocId}::uuid` : Prisma.empty;
    const rows = await this.prisma.tx.$queryRaw<{ parent_line_id: string; q: string }[]>`
      SELECT ll.parent_line_id, SUM(ll.quantity)::text AS q
      FROM document_link_lines ll
      JOIN document_links l ON l.id = ll.link_id
      JOIN sales_documents c ON c.id = l.child_id AND c.company_id = l.company_id
      WHERE ll.company_id = ${this.prisma.companyId}::uuid
        AND ll.parent_line_id = ANY(${parentLineIds}::uuid[])
        AND c.doc_type = ANY(${childTypes}::text[]) AND c.status = ANY(${statuses}::text[])
        ${exclude}
      GROUP BY ll.parent_line_id`;
    for (const r of rows) out.set(r.parent_line_id, D(r.q));
    return out;
  }

  // ═════════════════════════ borradores ═════════════════════════

  async create(docType: SalesDocType, input: SalesDocInput, v: Viewer) {
    const tx = this.prisma.tx;
    const customer = await this.validateHeader(docType, input);
    const docDate = new Date(input.docDate ?? caracasToday());
    await this.validateParent(docType, input);
    const exchangeRate = await this.resolveRate(input, docDate);
    // Una nota de crédito conserva las alícuotas de la factura: la vigencia del impuesto se evalúa a la fecha de esta.
    const taxDate = docType === 'CREDIT_NOTE' && input.parentId ? (await this.prisma.tx.salesDocument.findFirst({ where: { id: input.parentId }, select: { docDate: true } }))?.docDate ?? docDate : docDate;
    const { lines, totals, priceListId } = await this.buildLines(docType, input, taxDate, exchangeRate, customer.priceListId);
    // Vendedor por omisión: el ligado al usuario que crea, o el del cliente.
    let sellerId = input.sellerId ?? null;
    if (!sellerId) sellerId = (await tx.seller.findFirst({ where: { userId: v.userId, deletedAt: null, isActive: true }, select: { id: true } }))?.id ?? customer.sellerId ?? null;

    const doc = await tx.salesDocument.create({
      data: {
        companyId: this.prisma.companyId, docType, status: 'DRAFT', docDate, validUntil: input.validUntil ? new Date(input.validUntil) : null,
        customerId: input.customerId, sellerId, warehouseId: input.warehouseId ?? null, priceListId, currencyId: input.currencyId, exchangeRate,
        paymentCondition: input.paymentCondition, creditDays: input.creditDays, reservesStock: input.reservesStock, notes: input.notes ?? null,
        ...this.totalsData(totals, exchangeRate), createdBy: this.prisma.userId, updatedBy: this.prisma.userId,
      },
    });
    await this.saveLines(doc.id, lines, input.parentId ?? null, docType);
    await this.audit.log(this.entity(docType), doc.id, 'CREATE', input);
    return this.get(docType, doc.id, v);
  }

  totalsData(totals: ReturnType<typeof calcDocument>, exchangeRate: string) {
    return {
      subtotal: totals.subtotal.toFixed(4), taxableBase: totals.taxableBase.toFixed(4), exemptBase: totals.exemptBase.toFixed(4),
      taxTotal: totals.taxTotal.toFixed(4), total: totals.total.toFixed(4), totalBase: toBase(totals.total, exchangeRate).toFixed(4),
    };
  }

  async saveLines(docId: string, lines: Awaited<ReturnType<SalesService['buildLines']>>['lines'], parentId: string | null, docType: SalesDocType) {
    const tx = this.prisma.tx;
    const companyId = this.prisma.companyId;
    await tx.documentLink.deleteMany({ where: { childId: docId } }); // cascada a document_link_lines
    await tx.salesDocumentLine.deleteMany({ where: { documentId: docId } });
    const created = await tx.salesDocumentLine.createManyAndReturn({
      data: lines.map((l, i) => ({
        companyId, documentId: docId, lineNo: i + 1, productId: l.productId, description: l.description, quantity: l.quantity, unitPrice: l.unitPrice,
        discountPct: l.discountPct, taxId: l.taxId, taxRate: l.taxRate, net: l.net, tax: l.tax, total: l.total, serials: l.serials,
      })),
    });
    created.sort((a, b) => a.lineNo - b.lineNo);
    if (parentId) {
      const parent = await tx.salesDocument.findFirstOrThrow({ where: { id: parentId } });
      const link = await tx.documentLink.create({ data: { companyId, parentType: parent.docType, parentId, childType: docType, childId: docId } });
      const maps = lines.map((l, i) => ({ parentLineId: l.parentLineId, childLineId: created[i].id, quantity: l.quantity })).filter(m => m.parentLineId);
      if (maps.length) await tx.documentLinkLine.createMany({ data: maps.map(m => ({ linkId: link.id, companyId, parentLineId: m.parentLineId!, childLineId: m.childLineId, quantity: m.quantity })) });
    }
  }

  async update(docType: SalesDocType, id: string, input: Partial<SalesDocInput> & { version?: number }, v: Viewer) {
    const tx = this.prisma.tx;
    const doc = await this.find(docType, id, v, true);
    if (doc.status !== 'DRAFT') throw new BusinessRuleException('Solo se pueden editar documentos en borrador', 'DOCUMENT_NOT_EDITABLE');
    if (input.version !== undefined && input.version !== doc.version) throw new ConflictError('El documento fue modificado por otro usuario', 'VERSION_CONFLICT');
    const existing = await tx.salesDocumentLine.findMany({ where: { documentId: id }, orderBy: { lineNo: 'asc' } });
    const link = await tx.documentLink.findFirst({ where: { childId: id } });
    const linkLines = link ? await tx.documentLinkLine.findMany({ where: { linkId: link.id } }) : [];
    const merged: SalesDocInput = {
      customerId: input.customerId ?? doc.customerId,
      sellerId: input.sellerId === undefined ? doc.sellerId : input.sellerId,
      warehouseId: input.warehouseId === undefined ? doc.warehouseId : input.warehouseId,
      priceListId: input.priceListId === undefined ? doc.priceListId : input.priceListId,
      currencyId: input.currencyId ?? doc.currencyId,
      exchangeRate: input.exchangeRate ?? (input.currencyId && input.currencyId !== doc.currencyId ? undefined : doc.exchangeRate.toString()),
      docDate: input.docDate ?? doc.docDate.toISOString().slice(0, 10),
      validUntil: input.validUntil === undefined ? doc.validUntil?.toISOString().slice(0, 10) ?? null : input.validUntil,
      paymentCondition: input.paymentCondition ?? (doc.paymentCondition as 'CASH' | 'CREDIT'),
      creditDays: input.creditDays ?? doc.creditDays,
      reservesStock: input.reservesStock ?? doc.reservesStock,
      notes: input.notes === undefined ? doc.notes : input.notes,
      parentId: input.parentId === undefined ? link?.parentId ?? null : input.parentId,
      lines: input.lines ?? existing.map(l => ({
        productId: l.productId, description: l.description, quantity: l.quantity.toString(), unitPrice: l.unitPrice.toString(),
        discountPct: l.discountPct.toString(), taxId: l.taxId, serials: l.serials, parentLineId: linkLines.find(x => x.childLineId === l.id)?.parentLineId ?? null,
      })),
    };
    const customer = await this.validateHeader(docType, merged);
    const docDate = new Date(merged.docDate!);
    await this.validateParent(docType, merged, id);
    const exchangeRate = await this.resolveRate(merged, docDate);
    const { lines, totals, priceListId } = await this.buildLines(docType, merged, docDate, exchangeRate, customer.priceListId);
    await tx.salesDocument.update({
      where: { id },
      data: {
        docDate, validUntil: merged.validUntil ? new Date(merged.validUntil) : null, customerId: merged.customerId, sellerId: merged.sellerId ?? null,
        warehouseId: merged.warehouseId ?? null, priceListId, currencyId: merged.currencyId, exchangeRate, paymentCondition: merged.paymentCondition,
        creditDays: merged.creditDays, reservesStock: merged.reservesStock, notes: merged.notes ?? null,
        ...this.totalsData(totals, exchangeRate), updatedBy: this.prisma.userId, version: { increment: 1 },
      },
    });
    await this.saveLines(id, lines, merged.parentId ?? null, docType);
    await this.audit.log(this.entity(docType), id, 'UPDATE', input);
    return this.get(docType, id, v);
  }

  async remove(docType: SalesDocType, id: string, v: Viewer) {
    const doc = await this.find(docType, id, v, true);
    if (doc.status !== 'DRAFT') throw new BusinessRuleException('Solo se pueden eliminar borradores; los demás se anulan', 'DOCUMENT_NOT_DELETABLE');
    await this.reopenBudgetOf(id);
    await this.prisma.tx.documentLink.deleteMany({ where: { childId: id } });
    await this.prisma.tx.salesDocument.delete({ where: { id } });
    await this.audit.log(this.entity(docType), id, 'DELETE');
  }

  // ═════════════════════════ cotizaciones ═════════════════════════

  async quoteAction(id: string, action: 'send' | 'accept' | 'reject', v: Viewer) {
    const tx = this.prisma.tx;
    const doc = await this.find('QUOTE', id, v, true);
    const today = new Date(caracasToday());
    if (action === 'send') {
      if (doc.status !== 'DRAFT') throw new BusinessRuleException(`La cotización está ${doc.status}`, 'INVALID_STATE');
      const number = await this.seq.next('SALES_QUOTE');
      await tx.salesDocument.update({ where: { id }, data: { status: 'SENT', number, version: { increment: 1 } } });
    } else {
      if (doc.status !== 'SENT') throw new BusinessRuleException(`La cotización está ${doc.status}`, 'INVALID_STATE');
      if (action === 'accept' && doc.validUntil && doc.validUntil < today) {
        await tx.salesDocument.update({ where: { id }, data: { status: 'EXPIRED' } });
        throw new BusinessRuleException('La cotización está vencida', 'QUOTE_EXPIRED');
      }
      await tx.salesDocument.update({ where: { id }, data: { status: action === 'accept' ? 'ACCEPTED' : 'REJECTED', version: { increment: 1 } } });
    }
    await this.audit.log('sales_quote', id, action.toUpperCase());
    return this.get('QUOTE', id, v);
  }

  /** Cotización aceptada → presupuesto/pedido; presupuesto confirmado → pedido. Crea el destino en borrador, enlazado línea a línea. */
  async convert(from: SalesDocType, to: SalesDocType, id: string, v: Viewer) {
    const tx = this.prisma.tx;
    const src = await this.find(from, id, v, true);
    if (from === 'QUOTE' && src.status !== 'ACCEPTED') throw new BusinessRuleException('Solo una cotización aceptada se convierte', 'INVALID_STATE');
    if (from === 'BUDGET' && src.status !== 'CONFIRMED') throw new BusinessRuleException('Solo un presupuesto confirmado se convierte en pedido', 'INVALID_STATE');
    const today = new Date(caracasToday());
    if (src.validUntil && src.validUntil < today) throw new BusinessRuleException('El documento está vencido', 'QUOTE_EXPIRED');
    const lines = await tx.salesDocumentLine.findMany({ where: { documentId: id }, orderBy: { lineNo: 'asc' } });
    const out = await this.create(to, {
      customerId: src.customerId, sellerId: src.sellerId, warehouseId: src.warehouseId, priceListId: src.priceListId, currencyId: src.currencyId,
      exchangeRate: src.exchangeRate.toString(), paymentCondition: src.paymentCondition as 'CASH' | 'CREDIT', creditDays: src.creditDays,
      reservesStock: to === 'QUOTE' ? false : src.reservesStock, notes: src.notes, parentId: id,
      lines: lines.map(l => ({
        productId: l.productId, description: l.description, quantity: l.quantity.toString(), unitPrice: l.unitPrice.toString(),
        discountPct: l.discountPct.toString(), taxId: l.taxId, parentLineId: l.id,
      })),
    }, v);
    if (from === 'BUDGET') {
      // El presupuesto se da por convertido y libera su reserva; el pedido reserva por su cuenta al confirmarse.
      if (src.stockReserved) await this.reserve(src, -1);
      await tx.salesDocument.update({ where: { id }, data: { status: 'CONVERTED', stockReserved: false, version: { increment: 1 } } });
    }
    return out;
  }

  /** Si se elimina/anula un pedido nacido de un presupuesto, este vuelve a CONFIRMED (sin reserva). */
  private async reopenBudgetOf(childId: string) {
    const tx = this.prisma.tx;
    const link = await tx.documentLink.findFirst({ where: { childId, parentType: 'BUDGET' } });
    if (!link) return;
    await tx.salesDocument.updateMany({ where: { id: link.parentId, status: 'CONVERTED' }, data: { status: 'CONFIRMED', version: { increment: 1 } } });
  }

  // ═════════════════════════ reservas ═════════════════════════

  /** Suma (+1) o libera (-1) la reserva del documento completo en `inventory_stock.reserved_qty`. */
  async reserve(doc: { id: string; warehouseId: string | null }, sign: 1 | -1) {
    const lines = await this.prisma.tx.salesDocumentLine.findMany({ where: { documentId: doc.id } });
    const byProduct = new Map<string, ReturnType<typeof D>>();
    for (const l of lines) byProduct.set(l.productId, (byProduct.get(l.productId) ?? ZERO).plus(D(l.quantity.toString())));
    await this.adjustReservation(doc.warehouseId, byProduct, sign);
  }

  /** Suma o libera reserva por producto (bloqueando filas en orden). Al sumar valida disponible = existencia − reservado. */
  async adjustReservation(warehouseId: string | null, byProduct: Map<string, ReturnType<typeof D>>, sign: 1 | -1) {
    const tx = this.prisma.tx;
    const companyId = this.prisma.companyId;
    if (!warehouseId) return;
    const wh = await tx.warehouse.findFirstOrThrow({ where: { id: warehouseId } });
    for (const [productId, qty] of [...byProduct].sort((a, b) => a[0].localeCompare(b[0]))) {
      await tx.$executeRaw`INSERT INTO inventory_stock (company_id, product_id, warehouse_id) VALUES (${companyId}::uuid, ${productId}::uuid, ${warehouseId}::uuid) ON CONFLICT DO NOTHING`;
      const [row] = await tx.$queryRaw<{ quantity: string; reserved_qty: string }[]>`
        SELECT quantity::text, reserved_qty::text FROM inventory_stock
        WHERE company_id = ${companyId}::uuid AND product_id = ${productId}::uuid AND warehouse_id = ${warehouseId}::uuid FOR UPDATE`;
      const reserved = D(row.reserved_qty);
      if (sign === 1) {
        const available = D(row.quantity).minus(reserved);
        if (!wh.allowNegativeStock && qty.gt(available)) {
          const p = await tx.product.findFirst({ where: { id: productId }, select: { sku: true } });
          throw new BusinessRuleException(`Existencia disponible insuficiente de ${p?.sku ?? productId} (disponible ${available.toString()}, solicitado ${qty.toString()})`, 'INSUFFICIENT_AVAILABLE_STOCK', [{ code: 'INSUFFICIENT_AVAILABLE_STOCK', message: productId }]);
        }
      }
      const next = sign === 1 ? reserved.plus(qty) : ZERO.plus(reserved.minus(qty).lt(0) ? ZERO : reserved.minus(qty));
      await tx.$executeRaw`UPDATE inventory_stock SET reserved_qty = ${next.toFixed(4)}::numeric, updated_at = now()
        WHERE company_id = ${companyId}::uuid AND product_id = ${productId}::uuid AND warehouse_id = ${warehouseId}::uuid`;
    }
  }

  // ═════════════════════════ confirmar / anular ═════════════════════════

  async confirm(docType: 'BUDGET' | 'ORDER', id: string, v: Viewer, overrideCredit = false) {
    const tx = this.prisma.tx;
    const doc = await this.find(docType, id, v, true);
    if (doc.status !== 'DRAFT') throw new BusinessRuleException(`El documento ya está ${doc.status}`, 'INVALID_STATE');
    if (doc.validUntil && doc.validUntil < new Date(caracasToday())) throw new BusinessRuleException('El documento está vencido', 'QUOTE_EXPIRED');
    const lines = await tx.salesDocumentLine.findMany({ where: { documentId: id }, orderBy: { lineNo: 'asc' } });
    if (!lines.length) throw new BusinessRuleException('El documento no tiene líneas', 'EMPTY_DOCUMENT');
    const link = await tx.documentLink.findFirst({ where: { childId: id } });
    const linkLines = link ? await tx.documentLinkLine.findMany({ where: { linkId: link.id } }) : [];
    const shell = {
      customerId: doc.customerId, sellerId: doc.sellerId, warehouseId: doc.warehouseId, currencyId: doc.currencyId, reservesStock: doc.reservesStock,
      paymentCondition: doc.paymentCondition as 'CASH' | 'CREDIT', creditDays: doc.creditDays, parentId: link?.parentId ?? null,
      lines: lines.map(l => ({ productId: l.productId, quantity: l.quantity.toString(), parentLineId: linkLines.find(x => x.childLineId === l.id)?.parentLineId ?? null })),
    } as unknown as SalesDocInput;
    const customer = await this.validateHeader(docType, shell);
    await this.validateParent(docType, shell, id);
    if (docType === 'ORDER' && doc.paymentCondition === 'CREDIT') await this.checkCredit(customer, doc, v, overrideCredit);

    const number = await this.seq.next(this.route(docType).seq);
    if (doc.reservesStock) await this.reserve(doc, 1);
    await tx.salesDocument.update({
      where: { id },
      data: { status: 'CONFIRMED', number, stockReserved: doc.reservesStock, confirmedAt: new Date(), confirmedBy: this.prisma.userId, version: { increment: 1 } },
    });
    await this.audit.log(this.entity(docType), id, 'CONFIRM', { number });
    return this.get(docType, id, v);
  }

  /**
   * Límite de crédito (en moneda base): Σ pedidos a crédito confirmados + cuentas por cobrar abiertas del cliente + este pedido.
   * `creditLimit = 0` = sin límite. (Cuando exista facturación, el pedido facturado dejará de contarse como pedido y pasará a CxC.)
   */
  async checkCredit(customer: { id: string; creditLimit: { toString(): string } }, doc: { id: string; totalBase: { toString(): string } }, v: Viewer, override: boolean, excludeOrderId?: string) {
    const limit = D(customer.creditLimit.toString());
    if (limit.lte(0)) return;
    const [row] = await this.prisma.tx.$queryRaw<{ s: string }[]>`
      SELECT COALESCE(SUM(total_base), 0)::text AS s FROM sales_documents
      WHERE company_id = ${this.prisma.companyId}::uuid AND customer_id = ${customer.id}::uuid AND doc_type = 'ORDER'
        AND status = 'CONFIRMED' AND payment_condition = 'CREDIT' AND id <> ${doc.id}::uuid AND id <> COALESCE(${excludeOrderId ?? null}::uuid, '00000000-0000-0000-0000-000000000000'::uuid)`;
    const exposure = D(row.s).plus(D(doc.totalBase.toString())).plus(await this.receivables.exposureBase(customer.id));
    if (exposure.lte(limit)) return;
    if (override && v.creditOverride) return;
    throw new BusinessRuleException(
      `El pedido excede el límite de crédito del cliente (límite ${limit.toFixed(2)}, exposición ${exposure.toFixed(2)})`, 'CREDIT_LIMIT_EXCEEDED',
      [{ code: 'CREDIT_LIMIT_EXCEEDED', message: exposure.toFixed(4) }],
    );
  }

  async cancel(docType: SalesDocType, id: string, reason: string, v: Viewer) {
    const tx = this.prisma.tx;
    const doc = await this.find(docType, id, v, true);
    if (QTY_TYPES.includes(docType)) throw new BusinessRuleException('Las facturas y notas se anulan desde su propio endpoint', 'INVALID_ACTION');
    const cancellable = docType === 'QUOTE' ? ['DRAFT', 'SENT', 'ACCEPTED'] : ['DRAFT', 'CONFIRMED'];
    if (!cancellable.includes(doc.status)) throw new BusinessRuleException(`No se puede anular un documento ${doc.status}`, 'INVALID_STATE');
    const children = await tx.documentLink.findMany({ where: { parentId: id } });
    if (children.length && (await tx.salesDocument.count({ where: { id: { in: children.map(c => c.childId) }, status: { not: 'CANCELLED' } } }))) {
      throw new BusinessRuleException('El documento tiene documentos derivados activos; anúlelos primero', 'HAS_DEPENDENT_DOCUMENTS');
    }
    if (doc.stockReserved) await this.reserve(doc, -1);
    await this.reopenBudgetOf(id);
    const wasConfirmed = doc.status !== 'DRAFT';
    await tx.salesDocument.update({
      where: { id },
      data: { status: 'CANCELLED', stockReserved: false, cancelledAt: new Date(), cancelledBy: this.prisma.userId, cancelReason: reason, version: { increment: 1 } },
    });
    await tx.documentCancellation.create({ data: { companyId: this.prisma.companyId, docType: `SALES_${docType}`, docId: id, reason, cancelledBy: this.prisma.userId } });
    await this.audit.log(this.entity(docType), id, 'CANCEL', { reason, wasConfirmed });
    return this.get(docType, id, v);
  }
}
