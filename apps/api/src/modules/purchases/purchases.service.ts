import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { calcDocument, D, Decimal, round, toBase, ZERO } from '@erp/domain';
import { PrismaService } from '../../common/db/prisma.service';
import { AuditService } from '../../common/audit/audit.service';
import { SequenceService } from '../../common/db/sequence.service';
import { BusinessRuleException, ConflictError, NotFoundError } from '../../common/errors/errors';
import { Paged } from '../../common/http/paged';
import { ExchangeRatesService } from '../catalogs/exchange-rates';
import { caracasToday } from '../inventory/inventory-docs.service';
import { MoveRequest, PostingService } from '../inventory/posting.service';
import {
  PurchaseDocInput, PurchaseDocType, PurchaseLineInput, purchaseListSchema, PURCHASE_ROUTES, receiveSchema,
} from './purchases.types';

type Tx = import('../../common/db/tenant-context').Tx;
const ACTIVE = ['DRAFT', 'SENT', 'ACCEPTED', 'CONFIRMED', 'PARTIALLY_FULFILLED', 'FULFILLED', 'INVOICED', 'CLOSED'];
const REAL = ['CONFIRMED', 'PARTIALLY_FULFILLED', 'FULFILLED', 'INVOICED', 'CLOSED']; // documentos con efecto

/** Tipo de padre permitido por tipo de hijo (trazabilidad de document_links). */
const PARENT_OF: Partial<Record<PurchaseDocType, PurchaseDocType>> = {
  ORDER: 'QUOTE', DELIVERY_NOTE: 'ORDER', PURCHASE: 'DELIVERY_NOTE',
  DELIVERY_NOTE_RETURN: 'DELIVERY_NOTE', PURCHASE_RETURN: 'PURCHASE',
};

@Injectable()
export class PurchasesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly seq: SequenceService,
    private readonly posting: PostingService,
    private readonly rates: ExchangeRatesService,
  ) {}

  private entity(t: PurchaseDocType) { return `purchase_${t.toLowerCase()}`; }
  private route(t: PurchaseDocType) { return PURCHASE_ROUTES.find(r => r.docType === t)!; }

  // ═════════════════════════ consultas ═════════════════════════

  private async find(docType: PurchaseDocType, id: string, lock = false) {
    const tx = this.prisma.tx;
    if (lock) await tx.$queryRaw`SELECT id FROM purchase_documents WHERE id = ${id}::uuid AND company_id = ${this.prisma.companyId}::uuid FOR UPDATE`;
    const doc = await tx.purchaseDocument.findFirst({ where: { id, docType } });
    if (!doc) throw new NotFoundError('Documento', id);
    return doc;
  }

  async get(docType: PurchaseDocType, id: string) {
    const tx = this.prisma.tx;
    const doc = await this.find(docType, id);
    const lines = await tx.purchaseDocumentLine.findMany({ where: { documentId: id }, orderBy: { lineNo: 'asc' } });
    const [products, supplier, parents, children] = await Promise.all([
      tx.product.findMany({ where: { id: { in: lines.map(l => l.productId) } }, select: { id: true, sku: true, name: true } }),
      tx.supplier.findFirst({ where: { id: doc.supplierId }, select: { id: true, rif: true, legalName: true } }),
      tx.documentLink.findMany({ where: { childId: id } }),
      tx.documentLink.findMany({ where: { parentId: id } }),
    ]);
    const pm = new Map(products.map(p => [p.id, p]));
    const extra: Record<string, unknown> = {};
    if (docType === 'ORDER') {
      const received = await this.consumed(lines.map(l => l.id), ['DELIVERY_NOTE'], REAL);
      extra.lineStatus = lines.map(l => ({ lineId: l.id, ordered: l.quantity.toString(), received: (received.get(l.id) ?? ZERO).toString(), pending: D(l.quantity.toString()).minus(received.get(l.id) ?? ZERO).toString() }));
    }
    if (docType === 'DELIVERY_NOTE') {
      const used = await this.consumed(lines.map(l => l.id), ['PURCHASE', 'DELIVERY_NOTE_RETURN'], ACTIVE);
      extra.lineStatus = lines.map(l => ({ lineId: l.id, quantity: l.quantity.toString(), invoicedOrReturned: (used.get(l.id) ?? ZERO).toString(), available: D(l.quantity.toString()).minus(used.get(l.id) ?? ZERO).toString() }));
    }
    if (docType === 'PURCHASE') {
      extra.payable = await tx.payableEntry.findMany({ where: { purchaseDocumentId: id }, orderBy: { createdAt: 'asc' } });
      const used = await this.consumed(lines.map(l => l.id), ['PURCHASE_RETURN'], ACTIVE);
      extra.lineStatus = lines.map(l => ({ lineId: l.id, quantity: l.quantity.toString(), returned: (used.get(l.id) ?? ZERO).toString(), available: D(l.quantity.toString()).minus(used.get(l.id) ?? ZERO).toString() }));
    }
    return {
      ...doc, supplier, ...extra,
      lines: lines.map(l => ({ ...l, product: pm.get(l.productId) })),
      links: { parents: parents.map(p => ({ type: p.parentType, id: p.parentId })), children: children.map(c => ({ type: c.childType, id: c.childId })) },
    };
  }

  async list(docType: PurchaseDocType, q: z.infer<typeof purchaseListSchema>) {
    const where: any = { docType };
    if (q.status) where.status = { in: q.status.split(',') };
    if (q.supplierId) where.supplierId = q.supplierId;
    if (q.dateFrom || q.dateTo) where.docDate = { ...(q.dateFrom ? { gte: new Date(q.dateFrom) } : {}), ...(q.dateTo ? { lte: new Date(q.dateTo) } : {}) };
    if (q.search) where.OR = [{ number: { contains: q.search, mode: 'insensitive' } }, { supplierDocNo: { contains: q.search, mode: 'insensitive' } }];
    const [rows, total] = await Promise.all([
      this.prisma.tx.purchaseDocument.findMany({ where, orderBy: [{ createdAt: 'desc' }], skip: (q.page - 1) * q.limit, take: q.limit }),
      this.prisma.tx.purchaseDocument.count({ where }),
    ]);
    return Paged.of(rows, total, q.page, q.limit);
  }

  /** Σ cantidades de líneas hijas por línea padre (solo hijos de los tipos/estados indicados). */
  private async consumed(parentLineIds: string[], childTypes: string[], statuses: string[], excludeChildDocId?: string) {
    const out = new Map<string, Decimal>();
    if (!parentLineIds.length) return out;
    const exclude = excludeChildDocId ? Prisma.sql`AND c.id <> ${excludeChildDocId}::uuid` : Prisma.empty;
    const rows = await this.prisma.tx.$queryRaw<{ parent_line_id: string; q: string }[]>`
      SELECT ll.parent_line_id, SUM(ll.quantity)::text AS q
      FROM document_link_lines ll
      JOIN document_links l ON l.id = ll.link_id
      JOIN purchase_documents c ON c.id = l.child_id AND c.company_id = l.company_id
      WHERE ll.company_id = ${this.prisma.companyId}::uuid
        AND ll.parent_line_id = ANY(${parentLineIds}::uuid[])
        AND c.doc_type = ANY(${childTypes}::text[]) AND c.status = ANY(${statuses}::text[])
        ${exclude}
      GROUP BY ll.parent_line_id`;
    for (const r of rows) out.set(r.parent_line_id, D(r.q));
    return out;
  }

  // ═════════════════════════ borradores ═════════════════════════

  private async buildLines(docType: PurchaseDocType, input: PurchaseDocInput, docDate: Date, excludeDocId?: string) {
    const tx = this.prisma.tx;
    const productIds = [...new Set(input.lines.map(l => l.productId))];
    const products = new Map((await tx.product.findMany({ where: { id: { in: productIds }, deletedAt: null } })).map(p => [p.id, p]));
    const taxIds = [...new Set(input.lines.map(l => l.taxId ?? products.get(l.productId)?.taxId).filter(Boolean) as string[])];
    const taxes = new Map((await tx.tax.findMany({ where: { id: { in: taxIds }, deletedAt: null } })).map(t => [t.id, t]));
    const today = docDate;

    const resolved = input.lines.map((l, i) => {
      const bad = (code: string, msg: string) => new BusinessRuleException(msg, code, [{ field: `lines[${i}]`, code }]);
      const p = products.get(l.productId);
      if (!p) throw bad('PRODUCT_NOT_FOUND', 'Producto inexistente');
      if (!p.isActive) throw bad('PRODUCT_INACTIVE', `El producto ${p.sku} está inactivo`);
      const taxId = l.taxId ?? p.taxId ?? null;
      const tax = taxId ? taxes.get(taxId) : undefined;
      if (taxId && !tax) throw bad('TAX_NOT_FOUND', 'Impuesto inexistente');
      if (tax && (tax.validFrom > today || (tax.validTo && tax.validTo < today))) throw bad('TAX_NOT_VALID', `El impuesto ${tax.code} no está vigente en la fecha del documento`);
      if (p.trackingMode === 'LOT' && ['DELIVERY_NOTE', 'PURCHASE'].includes(docType) && !l.parentLineId && !l.lotNo) throw bad('LOT_REQUIRED', `El producto ${p.sku} requiere lote`);
      return { l, p, tax, taxId };
    });

    const totals = calcDocument(resolved.map(r => ({
      quantity: r.l.quantity, unitPrice: r.l.unitCost, discountPct: r.l.discountPct ?? 0,
      taxRate: r.tax?.rate.toString() ?? '0', taxExempt: !r.tax || r.tax.kind === 'EXEMPT' || r.tax.kind === 'EXONERATED',
    })));
    const lines = resolved.map((r, i) => ({
      productId: r.l.productId, description: r.l.description ?? null,
      quantity: r.l.quantity, unitCost: r.l.unitCost, discountPct: r.l.discountPct ?? '0',
      taxId: r.taxId, taxRate: totals.lines[i].taxRate.toString(),
      net: totals.lines[i].net.toFixed(4), tax: totals.lines[i].tax.toFixed(4), total: totals.lines[i].total.toFixed(4),
      lotNo: r.l.lotNo ?? null, expiryDate: r.l.expiryDate ? new Date(r.l.expiryDate) : null, parentLineId: r.l.parentLineId ?? null,
    }));
    return { lines, totals };
  }

  /** Valida el padre y las cantidades disponibles de las líneas con parentLineId. */
  private async validateParent(docType: PurchaseDocType, input: PurchaseDocInput, excludeDocId?: string) {
    const needed = PARENT_OF[docType];
    const withParent = input.lines.filter(l => l.parentLineId);
    const mandatory = docType === 'DELIVERY_NOTE_RETURN' || docType === 'PURCHASE_RETURN';
    if (!needed) {
      if (input.parentId || withParent.length) throw new BusinessRuleException('Este documento no admite documento origen', 'PARENT_NOT_ALLOWED');
      return null;
    }
    if (!input.parentId) {
      if (mandatory) throw new BusinessRuleException('Indique el documento que se devuelve (parentId)', 'PARENT_REQUIRED');
      if (withParent.length) throw new BusinessRuleException('Las líneas con origen requieren parentId', 'PARENT_REQUIRED');
      return null;
    }
    const parent = await this.prisma.tx.purchaseDocument.findFirst({ where: { id: input.parentId, docType: needed } });
    if (!parent) throw new BusinessRuleException(`El documento origen debe ser ${needed}`, 'INVALID_PARENT');
    if (!REAL.includes(parent.status) && !(needed === 'QUOTE' && parent.status === 'ACCEPTED')) {
      throw new BusinessRuleException(`El documento origen está ${parent.status}`, 'INVALID_PARENT_STATE');
    }
    if (parent.supplierId !== input.supplierId) throw new BusinessRuleException('El proveedor no coincide con el documento origen', 'SUPPLIER_MISMATCH');
    if (mandatory && withParent.length !== input.lines.length) throw new BusinessRuleException('Toda línea de una devolución debe indicar parentLineId', 'PARENT_LINE_REQUIRED');

    const parentLines = new Map((await this.prisma.tx.purchaseDocumentLine.findMany({ where: { documentId: parent.id } })).map(l => [l.id, l]));
    const childTypes = this.consumersOf(needed);
    const used = needed === 'QUOTE' ? new Map<string, Decimal>() : await this.consumed([...parentLines.keys()], childTypes, ACTIVE, excludeDocId);
    const asked = new Map<string, Decimal>();
    input.lines.forEach((l, i) => {
      if (!l.parentLineId) return;
      const pl = parentLines.get(l.parentLineId);
      if (!pl) throw new BusinessRuleException('La línea origen no pertenece al documento origen', 'INVALID_PARENT_LINE', [{ field: `lines[${i}]`, code: 'INVALID_PARENT_LINE' }]);
      if (pl.productId !== l.productId) throw new BusinessRuleException('El producto no coincide con la línea origen', 'PRODUCT_MISMATCH', [{ field: `lines[${i}]`, code: 'PRODUCT_MISMATCH' }]);
      asked.set(pl.id, (asked.get(pl.id) ?? ZERO).plus(D(l.quantity)));
    });
    if (needed !== 'QUOTE') {
      for (const [lineId, qty] of asked) {
        const pl = parentLines.get(lineId)!;
        const available = D(pl.quantity.toString()).minus(used.get(lineId) ?? ZERO);
        if (qty.gt(available)) {
          throw new BusinessRuleException(`Cantidad excede lo disponible del documento origen (${available.toString()})`, 'EXCEEDS_PARENT_QUANTITY', [{ code: 'EXCEEDS_PARENT_QUANTITY', message: lineId }]);
        }
      }
    }
    return parent;
  }

  /** Tipos de documento hijos que "consumen" cantidades de un padre. */
  private consumersOf(parentType: PurchaseDocType): string[] {
    switch (parentType) {
      case 'ORDER': return ['DELIVERY_NOTE'];
      case 'DELIVERY_NOTE': return ['PURCHASE', 'DELIVERY_NOTE_RETURN'];
      case 'PURCHASE': return ['PURCHASE_RETURN'];
      default: return [];
    }
  }

  private async resolveRate(input: { currencyId: string; exchangeRate?: string }, docDate: Date) {
    if (input.exchangeRate) {
      const cur = await this.prisma.currency.findUnique({ where: { id: input.currencyId } });
      if (!cur) throw new BusinessRuleException('Moneda inexistente', 'CURRENCY_NOT_FOUND');
      return cur.code === 'VES' ? '1' : input.exchangeRate;
    }
    const r = await this.rates.rateFor(input.currencyId, docDate);
    if (!r) throw new BusinessRuleException('No hay tasa de cambio para la moneda y fecha del documento', 'RATE_NOT_FOUND');
    return r.rate;
  }

  private async validateHeader(docType: PurchaseDocType, input: PurchaseDocInput) {
    const tx = this.prisma.tx;
    const supplier = await tx.supplier.findFirst({ where: { id: input.supplierId, deletedAt: null } });
    if (!supplier) throw new BusinessRuleException('Proveedor inexistente', 'SUPPLIER_NOT_FOUND');
    if (!supplier.isActive) throw new BusinessRuleException('El proveedor está inactivo', 'SUPPLIER_INACTIVE');
    if (input.warehouseId) {
      const wh = await tx.warehouse.findFirst({ where: { id: input.warehouseId, deletedAt: null, isActive: true } });
      if (!wh) throw new BusinessRuleException('Depósito inexistente o inactivo', 'WAREHOUSE_NOT_FOUND');
    }
    if (input.paymentCondition === 'CREDIT' && input.creditDays === 0) input.creditDays = supplier.creditDays;
    if (docType === 'QUOTE' && !input.expiresAt) { /* vigencia opcional */ }
    return supplier;
  }

  async create(docType: PurchaseDocType, input: PurchaseDocInput) {
    const tx = this.prisma.tx;
    const companyId = this.prisma.companyId;
    await this.validateHeader(docType, input);
    const docDate = new Date(input.docDate ?? caracasToday());
    await this.validateParent(docType, input);
    const exchangeRate = await this.resolveRate(input, docDate);
    const { lines, totals } = await this.buildLines(docType, input, docDate);
    const dueDate = input.paymentCondition === 'CREDIT' ? new Date(docDate.getTime() + input.creditDays * 86_400_000) : docDate;

    const doc = await tx.purchaseDocument.create({
      data: {
        companyId, docType, status: 'DRAFT', docDate, dueDate, expiresAt: input.expiresAt ? new Date(input.expiresAt) : null,
        supplierId: input.supplierId, warehouseId: input.warehouseId ?? null, currencyId: input.currencyId, exchangeRate,
        paymentCondition: input.paymentCondition, creditDays: input.creditDays,
        supplierDocNo: input.supplierDocNo ?? null, supplierControlNo: input.supplierControlNo ?? null, notes: input.notes ?? null,
        subtotal: totals.subtotal.toFixed(4), taxableBase: totals.taxableBase.toFixed(4), exemptBase: totals.exemptBase.toFixed(4),
        taxTotal: totals.taxTotal.toFixed(4), total: totals.total.toFixed(4), totalBase: toBase(totals.total, exchangeRate).toFixed(4),
        createdBy: this.prisma.userId, updatedBy: this.prisma.userId,
      },
    });
    await this.saveLines(doc.id, lines, input.parentId ?? null, docType);
    await this.audit.log(this.entity(docType), doc.id, 'CREATE', input);
    return this.get(docType, doc.id);
  }

  private async saveLines(docId: string, lines: Awaited<ReturnType<PurchasesService['buildLines']>>['lines'], parentId: string | null, docType: PurchaseDocType) {
    const tx = this.prisma.tx;
    const companyId = this.prisma.companyId;
    await tx.documentLink.deleteMany({ where: { childId: docId } }); // cascada a document_link_lines
    await tx.purchaseDocumentLine.deleteMany({ where: { documentId: docId } });
    const created = await tx.purchaseDocumentLine.createManyAndReturn({
      data: lines.map((l, i) => ({
        companyId, documentId: docId, lineNo: i + 1, productId: l.productId, description: l.description, quantity: l.quantity, unitCost: l.unitCost,
        discountPct: l.discountPct, taxId: l.taxId, taxRate: l.taxRate, net: l.net, tax: l.tax, total: l.total, lotNo: l.lotNo, expiryDate: l.expiryDate,
      })),
    });
    created.sort((a, b) => a.lineNo - b.lineNo);
    if (parentId) {
      const parentType = PARENT_OF[docType]!;
      const link = await tx.documentLink.create({ data: { companyId, parentType, parentId, childType: docType, childId: docId } });
      const maps = lines.map((l, i) => ({ parentLineId: l.parentLineId, childLineId: created[i].id, quantity: l.quantity })).filter(m => m.parentLineId);
      // Una línea de quote→order sin parentLineId explícito igual se enlaza por orden en convert-to-order (ver convert).
      if (maps.length) {
        await tx.documentLinkLine.createMany({ data: maps.map(m => ({ linkId: link.id, companyId, parentLineId: m.parentLineId!, childLineId: m.childLineId, quantity: m.quantity })) });
      }
    }
  }

  async update(docType: PurchaseDocType, id: string, input: Partial<PurchaseDocInput> & { version?: number }) {
    const tx = this.prisma.tx;
    const doc = await this.find(docType, id, true);
    if (doc.status !== 'DRAFT') throw new BusinessRuleException('Solo se pueden editar documentos en borrador', 'DOCUMENT_NOT_EDITABLE');
    if (input.version !== undefined && input.version !== doc.version) throw new ConflictError('El documento fue modificado por otro usuario', 'VERSION_CONFLICT');
    const existingLines = await tx.purchaseDocumentLine.findMany({ where: { documentId: id }, orderBy: { lineNo: 'asc' } });
    const link = await tx.documentLink.findFirst({ where: { childId: id } });
    const linkLines = link ? await tx.documentLinkLine.findMany({ where: { linkId: link.id } }) : [];
    const merged: PurchaseDocInput = {
      supplierId: input.supplierId ?? doc.supplierId,
      warehouseId: input.warehouseId === undefined ? doc.warehouseId : input.warehouseId,
      currencyId: input.currencyId ?? doc.currencyId,
      exchangeRate: input.exchangeRate ?? (input.currencyId && input.currencyId !== doc.currencyId ? undefined : doc.exchangeRate.toString()),
      docDate: input.docDate ?? doc.docDate.toISOString().slice(0, 10),
      expiresAt: input.expiresAt === undefined ? doc.expiresAt?.toISOString().slice(0, 10) ?? null : input.expiresAt,
      paymentCondition: input.paymentCondition ?? (doc.paymentCondition as 'CASH' | 'CREDIT'),
      creditDays: input.creditDays ?? doc.creditDays,
      supplierDocNo: input.supplierDocNo === undefined ? doc.supplierDocNo : input.supplierDocNo,
      supplierControlNo: input.supplierControlNo === undefined ? doc.supplierControlNo : input.supplierControlNo,
      notes: input.notes === undefined ? doc.notes : input.notes,
      parentId: input.parentId === undefined ? link?.parentId ?? null : input.parentId,
      lines: input.lines ?? existingLines.map(l => ({
        productId: l.productId, description: l.description, quantity: l.quantity.toString(), unitCost: l.unitCost.toString(), discountPct: l.discountPct.toString(),
        taxId: l.taxId, lotNo: l.lotNo, expiryDate: l.expiryDate?.toISOString().slice(0, 10) ?? null,
        parentLineId: linkLines.find(x => x.childLineId === l.id)?.parentLineId ?? null,
      })),
    };
    await this.validateHeader(docType, merged);
    const docDate = new Date(merged.docDate!);
    await this.validateParent(docType, merged, id);
    const exchangeRate = await this.resolveRate(merged, docDate);
    const { lines, totals } = await this.buildLines(docType, merged, docDate, id);
    await tx.purchaseDocument.update({
      where: { id },
      data: {
        docDate, dueDate: merged.paymentCondition === 'CREDIT' ? new Date(docDate.getTime() + merged.creditDays * 86_400_000) : docDate,
        expiresAt: merged.expiresAt ? new Date(merged.expiresAt) : null, supplierId: merged.supplierId, warehouseId: merged.warehouseId ?? null,
        currencyId: merged.currencyId, exchangeRate, paymentCondition: merged.paymentCondition, creditDays: merged.creditDays,
        supplierDocNo: merged.supplierDocNo ?? null, supplierControlNo: merged.supplierControlNo ?? null, notes: merged.notes ?? null,
        subtotal: totals.subtotal.toFixed(4), taxableBase: totals.taxableBase.toFixed(4), exemptBase: totals.exemptBase.toFixed(4),
        taxTotal: totals.taxTotal.toFixed(4), total: totals.total.toFixed(4), totalBase: toBase(totals.total, exchangeRate).toFixed(4),
        updatedBy: this.prisma.userId, version: { increment: 1 },
      },
    });
    await this.saveLines(id, lines, merged.parentId ?? null, docType);
    await this.audit.log(this.entity(docType), id, 'UPDATE', input);
    return this.get(docType, id);
  }

  async remove(docType: PurchaseDocType, id: string) {
    const doc = await this.find(docType, id, true);
    if (doc.status !== 'DRAFT') throw new BusinessRuleException('Solo se pueden eliminar borradores; los demás se anulan', 'DOCUMENT_NOT_DELETABLE');
    await this.prisma.tx.documentLink.deleteMany({ where: { childId: id } });
    await this.prisma.tx.purchaseDocument.delete({ where: { id } });
    await this.audit.log(this.entity(docType), id, 'DELETE');
  }

  // ═════════════════════════ cotizaciones ═════════════════════════

  async quoteAction(id: string, action: 'send' | 'accept' | 'reject') {
    const tx = this.prisma.tx;
    const doc = await this.find('QUOTE', id, true);
    const today = new Date(caracasToday());
    if (action === 'send') {
      if (doc.status !== 'DRAFT') throw new BusinessRuleException(`La cotización está ${doc.status}`, 'INVALID_STATE');
      const number = await this.seq.next('PURCHASE_QUOTE');
      await tx.purchaseDocument.update({ where: { id }, data: { status: 'SENT', number, version: { increment: 1 } } });
    } else {
      if (!['SENT', 'ACCEPTED'].includes(doc.status) || (action === 'reject' && doc.status === 'ACCEPTED')) throw new BusinessRuleException(`La cotización está ${doc.status}`, 'INVALID_STATE');
      if (action === 'accept' && doc.expiresAt && doc.expiresAt < today) {
        await tx.purchaseDocument.update({ where: { id }, data: { status: 'EXPIRED' } });
        throw new BusinessRuleException('La cotización está vencida', 'QUOTE_EXPIRED');
      }
      if (action === 'accept' && doc.status === 'ACCEPTED') throw new BusinessRuleException('La cotización ya fue aceptada', 'INVALID_STATE');
      await tx.purchaseDocument.update({ where: { id }, data: { status: action === 'accept' ? 'ACCEPTED' : 'REJECTED', version: { increment: 1 } } });
    }
    await this.audit.log('purchase_quote', id, action.toUpperCase());
    return this.get('QUOTE', id);
  }

  /** Cotización aceptada → orden de compra en borrador con las mismas líneas (enlazadas). */
  async convertQuoteToOrder(quoteId: string) {
    const tx = this.prisma.tx;
    const quote = await this.find('QUOTE', quoteId, true);
    if (quote.status !== 'ACCEPTED') throw new BusinessRuleException('Solo una cotización aceptada se convierte en orden', 'INVALID_STATE');
    const already = await tx.documentLink.findFirst({ where: { parentId: quoteId, childType: 'ORDER' } });
    if (already) {
      const o = await tx.purchaseDocument.findFirst({ where: { id: already.childId, status: { not: 'CANCELLED' } } });
      if (o) throw new ConflictError('La cotización ya fue convertida en una orden', 'ALREADY_CONVERTED');
    }
    const lines = await tx.purchaseDocumentLine.findMany({ where: { documentId: quoteId }, orderBy: { lineNo: 'asc' } });
    return this.create('ORDER', {
      supplierId: quote.supplierId, warehouseId: quote.warehouseId, currencyId: quote.currencyId, exchangeRate: quote.exchangeRate.toString(),
      paymentCondition: quote.paymentCondition as 'CASH' | 'CREDIT', creditDays: quote.creditDays, notes: quote.notes, parentId: quoteId,
      lines: lines.map(l => ({
        productId: l.productId, description: l.description, quantity: l.quantity.toString(), unitCost: l.unitCost.toString(), discountPct: l.discountPct.toString(),
        taxId: l.taxId, parentLineId: l.id,
      })),
    });
  }

  // ═════════════════════════ confirmar ═════════════════════════

  async confirm(docType: PurchaseDocType, id: string) {
    const tx = this.prisma.tx;
    const doc = await this.find(docType, id, true);
    if (doc.status !== 'DRAFT') throw new BusinessRuleException(`El documento ya está ${doc.status}`, 'INVALID_STATE');
    if (docType === 'QUOTE') throw new BusinessRuleException('Las cotizaciones se envían (send), no se confirman', 'INVALID_ACTION');
    const lines = await tx.purchaseDocumentLine.findMany({ where: { documentId: id }, orderBy: { lineNo: 'asc' } });
    if (!lines.length) throw new BusinessRuleException('El documento no tiene líneas', 'EMPTY_DOCUMENT');

    // Revalidar contra el estado actual (cantidades disponibles del padre, proveedor activo…)
    const link = await tx.documentLink.findFirst({ where: { childId: id } });
    const linkLines = link ? await tx.documentLinkLine.findMany({ where: { linkId: link.id } }) : [];
    await this.validateHeader(docType, {
      supplierId: doc.supplierId, warehouseId: doc.warehouseId, currencyId: doc.currencyId, paymentCondition: doc.paymentCondition as 'CASH' | 'CREDIT',
      creditDays: doc.creditDays, lines: [],
    } as unknown as PurchaseDocInput);
    await this.validateParent(docType, {
      supplierId: doc.supplierId, parentId: link?.parentId ?? null,
      lines: lines.map(l => ({ productId: l.productId, quantity: l.quantity.toString(), unitCost: '0', parentLineId: linkLines.find(x => x.childLineId === l.id)?.parentLineId ?? null })),
    } as unknown as PurchaseDocInput, id);

    const number = await this.seq.next(this.route(docType).seq);
    const date = new Date(caracasToday());
    switch (docType) {
      case 'ORDER': break;
      case 'DELIVERY_NOTE': await this.postReceipt(doc, lines, linkLines.map(x => x.childLineId)); break;
      case 'PURCHASE': await this.postPurchase(doc, lines, linkLines, number); break;
      case 'DELIVERY_NOTE_RETURN': await this.postReturn(doc, lines, linkLines, 'DELIVERY_NOTE_RETURN'); break;
      case 'PURCHASE_RETURN': await this.postReturn(doc, lines, linkLines, 'PURCHASE_RETURN'); break;
    }
    await tx.purchaseDocument.update({
      where: { id },
      data: { status: 'CONFIRMED', number, confirmedAt: new Date(), confirmedBy: this.prisma.userId, version: { increment: 1 } },
    });
    await this.refreshParents(docType, link?.parentId ?? null);
    await this.audit.log(this.entity(docType), id, 'CONFIRM', { number, date: date.toISOString().slice(0, 10) });
    return this.get(docType, id);
  }

  /** Costo unitario del documento → moneda de valoración de la empresa (precisión de costo). */
  private async valuationCost(doc: { currencyId: string; exchangeRate: Decimal | { toString(): string }; docDate: Date }, line: { net: { toString(): string }; quantity: { toString(): string } }) {
    const company = await this.prisma.company.findUniqueOrThrow({ where: { id: this.prisma.companyId } });
    const unitDoc = D(line.net.toString()).div(D(line.quantity.toString()));
    if (doc.currencyId === company.valuationCurrencyId) return round(unitDoc, 6);
    const bs = unitDoc.mul(D(doc.exchangeRate.toString()));
    const v = await this.rates.rateFor(company.valuationCurrencyId, doc.docDate);
    if (!v) throw new BusinessRuleException('No hay tasa de la moneda de valoración para la fecha del documento', 'RATE_NOT_FOUND');
    return round(bs.div(D(v.rate)), 6);
  }

  /** Nota de entrega confirmada → entrada de inventario. */
  private async postReceipt(doc: any, lines: any[], _unused: string[]) {
    if (!doc.warehouseId) throw new BusinessRuleException('La nota de entrega requiere depósito', 'WAREHOUSE_REQUIRED');
    const moves: MoveRequest[] = [];
    for (const l of lines) {
      moves.push({
        kind: 'ENTRY', productId: l.productId, warehouseId: doc.warehouseId, quantity: l.quantity.toString(),
        unitCost: (await this.valuationCost(doc, l)).toString(), docLineId: l.id, lotNo: l.lotNo, expiryDate: l.expiryDate?.toISOString().slice(0, 10) ?? null,
      });
    }
    await this.posting.post({ docType: 'DELIVERY_NOTE', docId: doc.id, moves });
  }

  /** Compra confirmada: entrada de lo no recibido por nota de entrega + cuenta por pagar. */
  private async postPurchase(doc: any, lines: any[], linkLines: { childLineId: string; parentLineId: string }[], _number: string) {
    const tx = this.prisma.tx;
    if (!doc.supplierDocNo) throw new BusinessRuleException('Indique el número de factura del proveedor', 'SUPPLIER_DOC_REQUIRED', [{ field: 'supplierDocNo', code: 'REQUIRED' }]);
    const direct = lines.filter(l => !linkLines.some(x => x.childLineId === l.id)); // sin nota de entrega previa → entran ahora
    if (direct.length) {
      if (!doc.warehouseId) throw new BusinessRuleException('La compra requiere depósito', 'WAREHOUSE_REQUIRED');
      const moves: MoveRequest[] = [];
      for (const l of direct) {
        moves.push({
          kind: 'ENTRY', productId: l.productId, warehouseId: doc.warehouseId, quantity: l.quantity.toString(),
          unitCost: (await this.valuationCost(doc, l)).toString(), docLineId: l.id, lotNo: l.lotNo, expiryDate: l.expiryDate?.toISOString().slice(0, 10) ?? null,
        });
      }
      await this.posting.post({ docType: 'PURCHASE', docId: doc.id, moves });
    }
    const cash = doc.paymentCondition === 'CASH';
    // Compra de contado: se asume pagada al registrarla (el pago/banco se modela en CxP/Bancos, fases 5 y 9).
    await tx.payableEntry.create({
      data: {
        companyId: this.prisma.companyId, supplierId: doc.supplierId, purchaseDocumentId: doc.id, entryType: 'INVOICE',
        dueDate: doc.dueDate ?? doc.docDate, currencyId: doc.currencyId, exchangeRate: doc.exchangeRate,
        amount: doc.total, balance: cash ? '0' : doc.total, status: cash ? 'PAID' : 'OPEN',
      },
    });
    await this.touchProductSuppliers(doc, lines);
  }

  private async touchProductSuppliers(doc: any, lines: any[]) {
    const tx = this.prisma.tx;
    for (const l of lines) {
      const cost = await this.valuationCost(doc, l);
      await tx.productSupplier.upsert({
        where: { companyId_productId_supplierId: { companyId: this.prisma.companyId, productId: l.productId, supplierId: doc.supplierId } },
        update: { lastCost: cost.toFixed(6) },
        create: { companyId: this.prisma.companyId, productId: l.productId, supplierId: doc.supplierId, lastCost: cost.toFixed(6) },
      });
    }
  }

  /** Devoluciones: salida al costo original; las de compra además ajustan la cuenta por pagar. */
  private async postReturn(doc: any, lines: any[], linkLines: { childLineId: string; parentLineId: string }[], type: 'DELIVERY_NOTE_RETURN' | 'PURCHASE_RETURN') {
    const tx = this.prisma.tx;
    if (!doc.warehouseId) throw new BusinessRuleException('La devolución requiere depósito', 'WAREHOUSE_REQUIRED');
    const parentLineIds = lines.map(l => linkLines.find(x => x.childLineId === l.id)!.parentLineId);
    let costs = await this.posting.originalCosts(parentLineIds);
    if (type === 'PURCHASE_RETURN') {
      // Las líneas de la compra que vinieron de una nota de entrega tienen su costo en el movimiento de la nota.
      const missing = parentLineIds.filter(p => !costs.has(p));
      if (missing.length) {
        const up = await tx.documentLinkLine.findMany({ where: { childLineId: { in: missing } } });
        const upCosts = await this.posting.originalCosts(up.map(u => u.parentLineId));
        for (const u of up) if (upCosts.has(u.parentLineId)) costs.set(u.childLineId, upCosts.get(u.parentLineId)!);
      }
    }
    const moves: MoveRequest[] = lines.map((l, i) => ({
      kind: 'RETURN_OUT', productId: l.productId, warehouseId: doc.warehouseId, quantity: l.quantity.toString(),
      unitCost: costs.get(parentLineIds[i])?.toString(), // si no hay costo original, el motor usa el promedio vigente
      docLineId: l.id, lotNo: l.lotNo,
    }));
    await this.posting.post({ docType: type, docId: doc.id, moves });

    if (type === 'PURCHASE_RETURN') {
      const link = await tx.documentLink.findFirstOrThrow({ where: { childId: doc.id } });
      const parentEntry = await tx.payableEntry.findFirst({ where: { purchaseDocumentId: link.parentId, entryType: 'INVOICE', status: { not: 'CANCELLED' } } });
      const total = D(doc.total.toString());
      let applied = ZERO;
      if (parentEntry) {
        applied = Decimal.min(total, D(parentEntry.balance.toString()));
        const newBal = D(parentEntry.balance.toString()).minus(applied);
        await tx.payableEntry.update({ where: { id: parentEntry.id }, data: { balance: newBal.toFixed(4), status: newBal.isZero() ? 'PAID' : 'PARTIALLY_PAID' } });
      }
      await tx.payableEntry.create({
        data: {
          companyId: this.prisma.companyId, supplierId: doc.supplierId, purchaseDocumentId: doc.id, entryType: 'RETURN',
          dueDate: doc.docDate, currencyId: doc.currencyId, exchangeRate: doc.exchangeRate,
          amount: total.neg().toFixed(4), balance: total.minus(applied).neg().toFixed(4), status: total.minus(applied).isZero() ? 'PAID' : 'OPEN',
        },
      });
    }
  }

  /** Recalcula el estado de los documentos padre afectados (orden recibida, nota facturada). */
  private async refreshParents(childType: PurchaseDocType, parentId: string | null) {
    if (!parentId) return;
    const parentType = PARENT_OF[childType];
    if (parentType === 'ORDER') await this.refreshOrder(parentId);
    if (parentType === 'DELIVERY_NOTE') await this.refreshDeliveryNote(parentId);
  }

  private async refreshOrder(orderId: string) {
    const tx = this.prisma.tx;
    const order = await tx.purchaseDocument.findFirst({ where: { id: orderId, docType: 'ORDER' } });
    if (!order || !['CONFIRMED', 'PARTIALLY_FULFILLED', 'FULFILLED'].includes(order.status)) return;
    const lines = await tx.purchaseDocumentLine.findMany({ where: { documentId: orderId } });
    const received = await this.consumed(lines.map(l => l.id), ['DELIVERY_NOTE'], REAL);
    const total = lines.reduce((a, l) => a.plus(D(l.quantity.toString())), ZERO);
    const got = lines.reduce((a, l) => a.plus(Decimal.min(received.get(l.id) ?? ZERO, D(l.quantity.toString()))), ZERO);
    const status = got.isZero() ? 'CONFIRMED' : got.gte(total) ? 'FULFILLED' : 'PARTIALLY_FULFILLED';
    if (status !== order.status) await tx.purchaseDocument.update({ where: { id: orderId }, data: { status } });
  }

  private async refreshDeliveryNote(dnId: string) {
    const tx = this.prisma.tx;
    const dn = await tx.purchaseDocument.findFirst({ where: { id: dnId, docType: 'DELIVERY_NOTE' } });
    if (!dn || !['CONFIRMED', 'INVOICED'].includes(dn.status)) return;
    const lines = await tx.purchaseDocumentLine.findMany({ where: { documentId: dnId } });
    const invoiced = await this.consumed(lines.map(l => l.id), ['PURCHASE'], REAL);
    const returned = await this.consumed(lines.map(l => l.id), ['DELIVERY_NOTE_RETURN'], REAL);
    const anyInvoiced = [...invoiced.values()].some(v => v.gt(0));
    const covered = lines.every(l => (invoiced.get(l.id) ?? ZERO).plus(returned.get(l.id) ?? ZERO).gte(D(l.quantity.toString())));
    const status = anyInvoiced && covered ? 'INVOICED' : 'CONFIRMED';
    if (status !== dn.status) await tx.purchaseDocument.update({ where: { id: dnId }, data: { status } });
  }

  // ═════════════════════════ recepción de una orden ═════════════════════════

  /** Orden confirmada → nota de entrega (confirmada) por las cantidades recibidas. */
  async receive(orderId: string, input: z.infer<typeof receiveSchema>) {
    const tx = this.prisma.tx;
    const order = await this.find('ORDER', orderId, true);
    if (!['CONFIRMED', 'PARTIALLY_FULFILLED'].includes(order.status)) throw new BusinessRuleException(`No se puede recibir una orden ${order.status}`, 'INVALID_STATE');
    const orderLines = new Map((await tx.purchaseDocumentLine.findMany({ where: { documentId: orderId } })).map(l => [l.id, l]));
    const dn = await this.create('DELIVERY_NOTE', {
      supplierId: order.supplierId, warehouseId: input.warehouseId ?? order.warehouseId, currencyId: order.currencyId, exchangeRate: order.exchangeRate.toString(),
      paymentCondition: order.paymentCondition as 'CASH' | 'CREDIT', creditDays: order.creditDays, supplierDocNo: input.supplierDocNo ?? null,
      notes: input.notes ?? null, parentId: orderId,
      lines: input.lines.map((r, i) => {
        const ol = orderLines.get(r.orderLineId);
        if (!ol) throw new BusinessRuleException('La línea no pertenece a la orden', 'INVALID_PARENT_LINE', [{ field: `lines[${i}]`, code: 'INVALID_PARENT_LINE' }]);
        return {
          productId: ol.productId, description: ol.description, quantity: r.quantity, unitCost: ol.unitCost.toString(), discountPct: ol.discountPct.toString(),
          taxId: ol.taxId, lotNo: r.lotNo ?? ol.lotNo, expiryDate: r.expiryDate ?? ol.expiryDate?.toISOString().slice(0, 10) ?? null, parentLineId: ol.id,
        };
      }),
    });
    return this.confirm('DELIVERY_NOTE', dn.id);
  }

  /** Nota de entrega confirmada → compra (borrador) con las líneas aún no facturadas ni devueltas. */
  async convertDeliveryNoteToPurchase(dnId: string) {
    const tx = this.prisma.tx;
    const dn = await this.find('DELIVERY_NOTE', dnId, true);
    if (dn.status !== 'CONFIRMED') throw new BusinessRuleException(`Solo una nota de entrega confirmada se factura (estado: ${dn.status})`, 'INVALID_STATE');
    const lines = await tx.purchaseDocumentLine.findMany({ where: { documentId: dnId }, orderBy: { lineNo: 'asc' } });
    const used = await this.consumed(lines.map(l => l.id), ['PURCHASE', 'DELIVERY_NOTE_RETURN'], ACTIVE);
    const pending = lines.map(l => ({ l, q: D(l.quantity.toString()).minus(used.get(l.id) ?? ZERO) })).filter(x => x.q.gt(0));
    if (!pending.length) throw new BusinessRuleException('La nota de entrega no tiene cantidades pendientes de facturar', 'NOTHING_TO_INVOICE');
    return this.create('PURCHASE', {
      supplierId: dn.supplierId, warehouseId: dn.warehouseId, currencyId: dn.currencyId, exchangeRate: dn.exchangeRate.toString(),
      paymentCondition: dn.paymentCondition as 'CASH' | 'CREDIT', creditDays: dn.creditDays, supplierDocNo: dn.supplierDocNo, notes: dn.notes, parentId: dnId,
      lines: pending.map(x => ({
        productId: x.l.productId, description: x.l.description, quantity: x.q.toString(), unitCost: x.l.unitCost.toString(), discountPct: x.l.discountPct.toString(),
        taxId: x.l.taxId, lotNo: x.l.lotNo, expiryDate: x.l.expiryDate?.toISOString().slice(0, 10) ?? null, parentLineId: x.l.id,
      })),
    });
  }

  // ═════════════════════════ anulación ═════════════════════════

  async cancel(docType: PurchaseDocType, id: string, reason: string) {
    const tx = this.prisma.tx;
    const doc = await this.find(docType, id, true);
    if (doc.status === 'CANCELLED') throw new BusinessRuleException('El documento ya está anulado', 'INVALID_STATE');
    const link = await tx.documentLink.findFirst({ where: { childId: id } });
    const wasConfirmed = REAL.includes(doc.status);

    if (docType === 'QUOTE') {
      if (!['DRAFT', 'SENT', 'ACCEPTED'].includes(doc.status)) throw new BusinessRuleException(`No se puede anular una cotización ${doc.status}`, 'INVALID_STATE');
    }
    if (docType === 'ORDER' && wasConfirmed) {
      const lines = await tx.purchaseDocumentLine.findMany({ where: { documentId: id } });
      const rec = await this.consumed(lines.map(l => l.id), ['DELIVERY_NOTE'], ACTIVE);
      if ([...rec.values()].some(v => v.gt(0))) throw new BusinessRuleException('La orden tiene recepciones; anule primero las notas de entrega', 'ORDER_HAS_RECEIPTS');
    }
    if (docType === 'DELIVERY_NOTE' && wasConfirmed) {
      if (doc.status === 'INVOICED') throw new BusinessRuleException('La nota de entrega está facturada; anule primero la compra', 'DOCUMENT_INVOICED');
      const lines = await tx.purchaseDocumentLine.findMany({ where: { documentId: id } });
      const used = await this.consumed(lines.map(l => l.id), ['PURCHASE', 'DELIVERY_NOTE_RETURN'], ACTIVE);
      if ([...used.values()].some(v => v.gt(0))) throw new BusinessRuleException('La nota de entrega tiene compras o devoluciones asociadas; anúlelas primero', 'HAS_DEPENDENT_DOCUMENTS');
      await this.posting.reverse('DELIVERY_NOTE', id);
    }
    if (docType === 'PURCHASE' && wasConfirmed) {
      const lines = await tx.purchaseDocumentLine.findMany({ where: { documentId: id } });
      const rets = await this.consumed(lines.map(l => l.id), ['PURCHASE_RETURN'], ACTIVE);
      if ([...rets.values()].some(v => v.gt(0))) throw new BusinessRuleException('La compra tiene devoluciones; anúlelas primero', 'HAS_DEPENDENT_DOCUMENTS');
      const entry = await tx.payableEntry.findFirst({ where: { purchaseDocumentId: id, entryType: 'INVOICE' } });
      if (entry && entry.status !== 'CANCELLED' && doc.paymentCondition === 'CREDIT' && !D(entry.balance.toString()).eq(D(entry.amount.toString()))) {
        throw new BusinessRuleException('La cuenta por pagar tiene pagos aplicados', 'PAYABLE_HAS_PAYMENTS');
      }
      await this.posting.reverse('PURCHASE', id);
      if (entry) await tx.payableEntry.update({ where: { id: entry.id }, data: { status: 'CANCELLED', balance: '0' } });
    }
    if ((docType === 'DELIVERY_NOTE_RETURN' || docType === 'PURCHASE_RETURN') && wasConfirmed) {
      await this.posting.reverse(docType, id);
      if (docType === 'PURCHASE_RETURN') {
        const ret = await tx.payableEntry.findFirst({ where: { purchaseDocumentId: id, entryType: 'RETURN' } });
        if (ret && link) {
          // monto aplicado a la factura = total devuelto − saldo a favor remanente (balance ≤ 0)
          const A = D(ret.amount.toString()).neg().plus(D(ret.balance.toString()));
          const parentEntry = await tx.payableEntry.findFirst({ where: { purchaseDocumentId: link.parentId, entryType: 'INVOICE' } });
          if (parentEntry && A.gt(0)) {
            const newBal = D(parentEntry.balance.toString()).plus(A);
            await tx.payableEntry.update({ where: { id: parentEntry.id }, data: { balance: newBal.toFixed(4), status: newBal.gte(D(parentEntry.amount.toString())) ? 'OPEN' : 'PARTIALLY_PAID' } });
          }
          await tx.payableEntry.update({ where: { id: ret.id }, data: { status: 'CANCELLED', balance: '0' } });
        }
      }
    }

    await tx.purchaseDocument.update({
      where: { id },
      data: { status: 'CANCELLED', cancelledAt: new Date(), cancelledBy: this.prisma.userId, cancelReason: reason, version: { increment: 1 } },
    });
    await tx.documentCancellation.create({ data: { companyId: this.prisma.companyId, docType: `PURCHASE_${docType}`, docId: id, reason, cancelledBy: this.prisma.userId } });
    if (wasConfirmed) await this.refreshParents(docType, link?.parentId ?? null);
    await this.audit.log(this.entity(docType), id, 'CANCEL', { reason, wasConfirmed });
    return this.get(docType, id);
  }
}
