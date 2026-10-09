import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { D, Decimal, round, ZERO } from '@erp/domain';
import { PrismaService } from '../../common/db/prisma.service';
import { AuditService } from '../../common/audit/audit.service';
import { SequenceService } from '../../common/db/sequence.service';
import { BusinessRuleException, NotFoundError } from '../../common/errors/errors';
import { env } from '../../config/env';
import { caracasToday } from '../inventory/inventory-docs.service';
import { MoveRequest, PostingService } from '../inventory/posting.service';
import { ReceivablesService } from '../treasury/receivables.service';
import { TreasuryService } from '../treasury/treasury.service';
import { invoicePdf, InvoicePdfData } from './invoice-pdf';
import { SalesService } from './sales.service';
import { confirmInvoiceSchema, creditNoteSchema, debitNoteSchema, SalesDocInput, Viewer } from './sales.types';

const DAY = 86_400_000;
const entryStatus = (balance: Decimal, amount: Decimal) => (balance.isZero() ? 'PAID' : balance.eq(amount) ? 'OPEN' : 'PARTIALLY_PAID');

/**
 * Facturación: la factura descarga inventario (costo promedio), genera la cuenta por cobrar (crédito) o registra los pagos (contado, con IGTF),
 * y la nota de crédito devuelve al costo original. Numeración de factura y de control son INTERNAS y provisionales hasta definir la imprenta digital.
 */
@Injectable()
export class InvoicingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly seq: SequenceService,
    private readonly sales: SalesService,
    private readonly posting: PostingService,
    private readonly treasury: TreasuryService,
    private readonly receivables: ReceivablesService,
  ) {}

  /** Siguiente número de control. Punto único de reemplazo por el proveedor de imprenta digital. */
  private nextControlNo() { return this.seq.next('SALES_CONTROL'); }

  private async snapshot(customerId: string, sellerId: string | null) {
    const tx = this.prisma.tx;
    const [company, customer, seller] = await Promise.all([
      tx.company.findUniqueOrThrow({ where: { id: this.prisma.companyId } }),
      tx.customer.findFirstOrThrow({ where: { id: customerId } }),
      sellerId ? tx.seller.findFirst({ where: { id: sellerId }, select: { name: true } }) : null,
    ]);
    return {
      company: { rif: company.rif, legalName: company.legalName, tradeName: company.tradeName, fiscalAddress: company.fiscalAddress, isSpecialTaxpayer: company.isSpecialTaxpayer, isVatWithholdingAgent: company.isVatWithholdingAgent },
      customer: { rif: customer.rif, legalName: customer.legalName, address: customer.address, phone: customer.phone, isSpecialTaxpayer: customer.isSpecialTaxpayer },
      seller: seller?.name ?? null,
    };
  }

  // ═════════════════════════ emisión de factura ═════════════════════════

  async confirmInvoice(id: string, v: Viewer, body: z.infer<typeof confirmInvoiceSchema>) {
    const tx = this.prisma.tx;
    const companyId = this.prisma.companyId;
    const doc = await this.sales.find('INVOICE', id, v, true);
    if (doc.status !== 'DRAFT') throw new BusinessRuleException(`La factura ya está ${doc.status}`, 'INVALID_STATE');
    const lines = await tx.salesDocumentLine.findMany({ where: { documentId: id }, orderBy: { lineNo: 'asc' } });
    if (!lines.length) throw new BusinessRuleException('El documento no tiene líneas', 'EMPTY_DOCUMENT');
    if (!doc.warehouseId) throw new BusinessRuleException('La factura requiere depósito', 'WAREHOUSE_REQUIRED');
    const link = await tx.documentLink.findFirst({ where: { childId: id } });
    const linkLines = link ? await tx.documentLinkLine.findMany({ where: { linkId: link.id } }) : [];
    const shell = {
      customerId: doc.customerId, sellerId: doc.sellerId, warehouseId: doc.warehouseId, currencyId: doc.currencyId, reservesStock: false,
      paymentCondition: doc.paymentCondition as 'CASH' | 'CREDIT', creditDays: doc.creditDays, parentId: link?.parentId ?? null,
      lines: lines.map(l => ({ productId: l.productId, quantity: l.quantity.toString(), parentLineId: linkLines.find(x => x.childLineId === l.id)?.parentLineId ?? null })),
    } as unknown as SalesDocInput;
    const customer = await this.sales.validateHeader('INVOICE', shell);
    const order = await this.sales.validateParent('INVOICE', shell, id);
    const serialProducts0 = await tx.product.findMany({ where: { id: { in: lines.map(l => l.productId) }, trackingMode: 'SERIAL' }, select: { id: true, sku: true } });
    for (const sp of serialProducts0) {
      for (const l of lines.filter(x => x.productId === sp.id)) {
        if (l.serials.length !== Number(l.quantity)) throw new BusinessRuleException(`El producto ${sp.sku} se controla por seriales: indique ${l.quantity} serial(es)`, 'SERIALS_REQUIRED', [{ field: 'lines', code: 'SERIALS_REQUIRED', message: l.id }]);
      }
    }
    const cash = doc.paymentCondition === 'CASH';
    const payments = body.payments ?? [];
    if (!cash && payments.length) throw new BusinessRuleException('Una factura a crédito no lleva pagos: registre el cobro después', 'PAYMENTS_NOT_ALLOWED');
    if (cash && !payments.length) throw new BusinessRuleException('Una factura de contado requiere registrar los pagos (o cambie la condición a crédito)', 'PAYMENT_REQUIRED', [{ field: 'payments', code: 'REQUIRED' }]);
    if (!cash) await this.sales.checkCredit(customer, doc, v, !!body.overrideCredit, order?.id);

    // Pagos de contado y IGTF (se validan antes de tocar inventario).
    const company = await tx.company.findUniqueOrThrow({ where: { id: companyId } });
    const igtfTax = company.isIgtfCollector ? await tx.tax.findFirst({ where: { kind: 'IGTF', isActive: true, deletedAt: null, validFrom: { lte: doc.docDate }, OR: [{ validTo: null }, { validTo: { gte: doc.docDate } }] }, orderBy: { validFrom: 'desc' } }) : null;
    const igtfPct = D(igtfTax?.rate.toString() ?? 0);
    const docRate = D(doc.exchangeRate.toString());
    const total = D(doc.total.toString());
    const prepared = [] as { input: (typeof payments)[number]; amountDoc: Decimal; rate: Decimal; igtf: Decimal; applies: boolean; accountId: string | null }[];
    for (const [i, p] of payments.entries()) {
      const bad = (code: string, msg: string) => new BusinessRuleException(msg, code, [{ field: `payments[${i}]`, code }]);
      const method = await tx.paymentMethod.findFirst({ where: { id: p.paymentMethodId, deletedAt: null, isActive: true } });
      if (!method) throw bad('PAYMENT_METHOD_NOT_FOUND', 'Instrumento de pago inexistente o inactivo');
      if (['CREDIT', 'WITHHOLDING'].includes(method.type)) throw bad('PAYMENT_METHOD_INVALID', 'Este instrumento no sirve para pagos de la factura');
      if (method.requiresReference && !p.reference?.trim()) throw bad('REFERENCE_REQUIRED', 'El instrumento de pago requiere referencia');
      const cur = await this.prisma.currency.findUnique({ where: { id: p.currencyId } });
      if (!cur) throw bad('CURRENCY_NOT_FOUND', 'Moneda inexistente');
      const payRate = cur.code === 'VES' ? D(1) : p.exchangeRate ? D(p.exchangeRate) : D((await this.treasuryRate(p.currencyId, doc.docDate)));
      const amountDoc = p.currencyId === doc.currencyId ? D(p.amount) : round(D(p.amount).mul(payRate).div(docRate), 4);
      const applies = igtfPct.gt(0) && method.appliesIgtf;
      const igtf = applies ? round(amountDoc.mul(igtfPct).div(100), 4) : ZERO;
      if (!p.bankAccountId) throw bad('BANK_ACCOUNT_REQUIRED', 'Indique la cuenta bancaria o caja donde ingresa el pago');
      const acc = await this.treasury.activeAccount(p.bankAccountId, true);
      if (acc.currencyId !== p.currencyId) throw bad('BANK_CURRENCY_MISMATCH', 'La cuenta bancaria es de otra moneda que el pago');
      prepared.push({ input: p, amountDoc, rate: payRate, igtf, applies, accountId: acc.id });
    }
    const paid = prepared.reduce((a, p) => a.plus(p.amountDoc), ZERO);
    const igtfTotal = prepared.reduce((a, p) => a.plus(p.igtf), ZERO);
    if (cash && paid.minus(total.plus(igtfTotal)).abs().gt('0.01')) {
      throw new BusinessRuleException(`Los pagos (${paid.toFixed(2)}) no cuadran con el total a pagar (${total.plus(igtfTotal).toFixed(2)}: factura ${total.toFixed(2)} + IGTF ${igtfTotal.toFixed(2)})`, 'PAYMENT_MISMATCH', [{ field: 'payments', code: 'PAYMENT_MISMATCH', message: total.plus(igtfTotal).toFixed(4) }]);
    }

    // Reserva del pedido: la cantidad que se factura deja de estar apartada (si no, el propio pedido bloquearía la salida).
    if (order?.stockReserved) {
      const byProduct = new Map<string, Decimal>();
      for (const l of lines) if (linkLines.some(x => x.childLineId === l.id)) byProduct.set(l.productId, (byProduct.get(l.productId) ?? ZERO).plus(D(l.quantity.toString())));
      await this.sales.adjustReservation(order.warehouseId, byProduct, -1);
    }

    // Salida de inventario al costo promedio (FEFO en lotes; seriales → SOLD).
    const serialProducts = new Set((await tx.product.findMany({ where: { id: { in: lines.map(l => l.productId) }, trackingMode: 'SERIAL' }, select: { id: true } })).map(p => p.id));
    const moves: MoveRequest[] = lines.map(l => ({
      kind: 'EXIT', productId: l.productId, warehouseId: doc.warehouseId!, quantity: l.quantity.toString(), docLineId: l.id,
      ...(serialProducts.has(l.productId) ? { serials: l.serials, serialStatus: 'SOLD' as const } : {}),
    }));
    const posted = await this.posting.post({ docType: 'INVOICE', docId: id, moves });
    const costByLine = new Map<string, { q: Decimal; c: Decimal }>();
    for (const m of posted) {
      if (!m.docLineId) continue;
      const cur = costByLine.get(m.docLineId) ?? { q: ZERO, c: ZERO };
      costByLine.set(m.docLineId, { q: cur.q.plus(m.quantity.abs()), c: cur.c.plus(m.totalCost.abs()) });
    }
    for (const l of lines) {
      const x = costByLine.get(l.id);
      if (x && x.q.gt(0)) await tx.salesDocumentLine.update({ where: { id: l.id }, data: { unitCost: round(x.c.div(x.q), 6).toFixed(6) } });
    }

    const number = await this.seq.next('SALES_INVOICE');
    const controlNo = await this.nextControlNo();
    for (const p of prepared) {
      await tx.salesDocumentPayment.create({
        data: {
          companyId, documentId: id, paymentMethodId: p.input.paymentMethodId, bankAccountId: p.accountId, currencyId: p.input.currencyId, exchangeRate: p.rate.toFixed(8),
          amount: D(p.input.amount).toFixed(4), amountDoc: p.amountDoc.toFixed(4), appliesIgtf: p.applies, igtfAmount: p.igtf.toFixed(4), reference: p.input.reference?.trim() || null,
        },
      });
      await this.treasury.addMovement({ bankAccountId: p.accountId!, date: doc.docDate, kind: 'CUSTOMER_RECEIPT', amount: D(p.input.amount), reference: p.input.reference ?? number, description: `Factura ${number}`, sourceType: 'SALES_INVOICE', sourceId: id });
    }
    if (!cash) {
      await this.receivables.createEntry({
        customerId: doc.customerId, entryType: 'INVOICE', sourceType: 'SALES_INVOICE', sourceId: id, documentNo: number, issueDate: doc.docDate,
        dueDate: new Date(doc.docDate.getTime() + doc.creditDays * DAY), currencyId: doc.currencyId, exchangeRate: doc.exchangeRate.toString(), amount: total.toFixed(4),
      });
    }
    await tx.salesDocument.update({
      where: { id },
      data: {
        status: 'CONFIRMED', number, controlNo, igtfPct: igtfPct.toFixed(4), igtfAmount: igtfTotal.toFixed(4), fiscalSnapshot: await this.snapshot(doc.customerId, doc.sellerId),
        confirmedAt: new Date(), confirmedBy: this.prisma.userId, version: { increment: 1 },
      },
    });
    if (order) await this.refreshOrder(order.id);
    await this.audit.log('sales_invoice', id, 'CONFIRM', { number, controlNo, cash, igtf: igtfTotal.toString() });
    return this.sales.get('INVOICE', id, v);
  }

  /** Pedido confirmado → factura en borrador con las cantidades aún no facturadas (enlazada línea a línea). */
  async invoiceFromOrder(orderId: string, v: Viewer) {
    const tx = this.prisma.tx;
    const order = await this.sales.find('ORDER', orderId, v, true);
    if (!['CONFIRMED', 'PARTIALLY_INVOICED'].includes(order.status)) throw new BusinessRuleException(`Solo se factura un pedido confirmado (estado ${order.status})`, 'INVALID_STATE');
    if (!order.warehouseId) throw new BusinessRuleException('El pedido no tiene depósito: indíquelo para facturar', 'WAREHOUSE_REQUIRED');
    const lines = await tx.salesDocumentLine.findMany({ where: { documentId: orderId }, orderBy: { lineNo: 'asc' } });
    const used = await this.sales.consumed(lines.map(l => l.id), ['INVOICE'], ['DRAFT', 'CONFIRMED']);
    const pending = lines.map(l => ({ l, q: D(l.quantity.toString()).minus(used.get(l.id) ?? ZERO) })).filter(x => x.q.gt(0));
    if (!pending.length) throw new BusinessRuleException('El pedido no tiene cantidades pendientes de facturar', 'NOTHING_TO_INVOICE');
    return this.sales.create('INVOICE', {
      customerId: order.customerId, sellerId: order.sellerId, warehouseId: order.warehouseId, priceListId: order.priceListId, currencyId: order.currencyId, exchangeRate: order.exchangeRate.toString(),
      paymentCondition: order.paymentCondition as 'CASH' | 'CREDIT', creditDays: order.creditDays, reservesStock: false, notes: order.notes, parentId: orderId,
      lines: pending.map(x => ({ productId: x.l.productId, description: x.l.description, quantity: x.q.toString(), unitPrice: x.l.unitPrice.toString(), discountPct: x.l.discountPct.toString(), taxId: x.l.taxId, parentLineId: x.l.id })),
    }, v);
  }

  private async treasuryRate(currencyId: string, date: Date) {
    const r = await this.sales.rateOf(currencyId, date);
    return r.toString();
  }

  /** Estado del pedido según lo facturado: INVOICED al cubrir todas las líneas; PARTIALLY_INVOICED si hay facturas; si no, CONFIRMED. */
  private async refreshOrder(orderId: string) {
    const tx = this.prisma.tx;
    const order = await tx.salesDocument.findFirst({ where: { id: orderId, docType: 'ORDER' } });
    if (!order || !['CONFIRMED', 'PARTIALLY_INVOICED', 'INVOICED'].includes(order.status)) return;
    const lines = await tx.salesDocumentLine.findMany({ where: { documentId: orderId } });
    const inv = await this.sales.consumed(lines.map(l => l.id), ['INVOICE'], ['CONFIRMED']);
    const any = [...inv.values()].some(x => x.gt(0));
    const all = lines.every(l => (inv.get(l.id) ?? ZERO).gte(D(l.quantity.toString())));
    const status = all ? 'INVOICED' : any ? 'PARTIALLY_INVOICED' : 'CONFIRMED';
    if (status !== order.status || (all && order.stockReserved)) {
      await tx.salesDocument.update({ where: { id: orderId }, data: { status, ...(all ? { stockReserved: false } : {}) } });
    }
  }

  // ═════════════════════════ anulación ═════════════════════════

  /** Anulación directa (sin nota de crédito). Falta definir con el contador cuándo la ley exige nota de crédito en su lugar. */
  async cancelInvoice(id: string, reason: string, v: Viewer) {
    const tx = this.prisma.tx;
    const doc = await this.sales.find('INVOICE', id, v, true);
    if (doc.status !== 'CONFIRMED') throw new BusinessRuleException(`No se puede anular una factura ${doc.status}`, 'INVALID_STATE');
    const kids = await tx.documentLink.findMany({ where: { parentId: id, childType: 'CREDIT_NOTE' } });
    if (kids.length && (await tx.salesDocument.count({ where: { id: { in: kids.map(k => k.childId) }, status: 'CONFIRMED' } }))) {
      throw new BusinessRuleException('La factura tiene notas de crédito; no puede anularse', 'HAS_CREDIT_NOTES');
    }
    const entries = await tx.receivableEntry.findMany({ where: { sourceType: 'SALES_INVOICE', sourceId: id } });
    for (const e of entries) {
      if (!D(e.balance.toString()).eq(D(e.amount.toString()))) throw new BusinessRuleException('La cuenta por cobrar tiene cobros aplicados; anule primero los cobros', 'HAS_COLLECTIONS');
    }
    const movs = await tx.bankMovement.findMany({ where: { sourceType: 'SALES_INVOICE', sourceId: id, reversalOf: null } });
    for (const m of movs) {
      if (await tx.bankReconciliationItem.findFirst({ where: { movementId: m.id } })) throw new BusinessRuleException('Un pago de la factura ya fue conciliado con el banco; no se puede anular', 'PAYMENT_RECONCILED');
    }
    for (const m of movs) {
      await this.treasury.activeAccount(m.bankAccountId, true);
      await this.treasury.addMovement({ bankAccountId: m.bankAccountId, date: new Date(caracasToday()), kind: 'REVERSAL', amount: D(m.amount.toString()).neg(), reference: doc.number, description: `Anulación de la factura ${doc.number}`, sourceType: 'SALES_INVOICE', sourceId: id, reversalOf: m.id });
    }
    await this.posting.reverse('INVOICE', id);
    for (const e of entries) await tx.receivableEntry.update({ where: { id: e.id }, data: { status: 'CANCELLED', balance: '0' } });
    // Si venía de un pedido que reservaba, la cantidad vuelve a estar apartada.
    const link = await tx.documentLink.findFirst({ where: { childId: id, parentType: 'ORDER' } });
    if (link) {
      const order = await tx.salesDocument.findFirst({ where: { id: link.parentId } });
      if (order?.reservesStock && ['CONFIRMED', 'PARTIALLY_INVOICED', 'INVOICED'].includes(order.status)) {
        const lines = await tx.salesDocumentLine.findMany({ where: { documentId: id } });
        const byProduct = new Map<string, Decimal>();
        for (const l of lines) byProduct.set(l.productId, (byProduct.get(l.productId) ?? ZERO).plus(D(l.quantity.toString())));
        await this.sales.adjustReservation(order.warehouseId, byProduct, 1);
        await tx.salesDocument.update({ where: { id: order.id }, data: { stockReserved: true } });
      }
    }
    await tx.salesDocument.update({ where: { id }, data: { status: 'CANCELLED', cancelledAt: new Date(), cancelledBy: this.prisma.userId, cancelReason: reason, version: { increment: 1 } } });
    await tx.documentCancellation.create({ data: { companyId: this.prisma.companyId, docType: 'SALES_INVOICE', docId: id, reason, cancelledBy: this.prisma.userId } });
    if (link) await this.refreshOrder(link.parentId);
    await this.audit.log('sales_invoice', id, 'CANCEL', { reason });
    return this.sales.get('INVOICE', id, v);
  }

  // ═════════════════════════ nota de crédito ═════════════════════════

  /** Devolución total o parcial de una factura: reingresa al inventario al COSTO ORIGINAL y reduce/compensa la cuenta por cobrar. */
  async createCreditNote(invoiceId: string, input: z.infer<typeof creditNoteSchema>, v: Viewer) {
    const tx = this.prisma.tx;
    const inv = await this.sales.find('INVOICE', invoiceId, v, true);
    if (inv.status !== 'CONFIRMED') throw new BusinessRuleException(`Solo se devuelve una factura emitida (estado ${inv.status})`, 'INVALID_STATE');
    const invLines = new Map((await tx.salesDocumentLine.findMany({ where: { documentId: invoiceId } })).map(l => [l.id, l]));
    const serialProducts = new Set((await tx.product.findMany({ where: { id: { in: [...invLines.values()].map(l => l.productId) }, trackingMode: 'SERIAL' }, select: { id: true } })).map(p => p.id));
    const docInput: SalesDocInput = {
      customerId: inv.customerId, sellerId: inv.sellerId, warehouseId: inv.warehouseId, priceListId: inv.priceListId, currencyId: inv.currencyId, exchangeRate: inv.exchangeRate.toString(),
      paymentCondition: inv.paymentCondition as 'CASH' | 'CREDIT', creditDays: inv.creditDays, reservesStock: false, notes: input.notes ?? null, parentId: invoiceId,
      lines: input.lines.map((l, i) => {
        const pl = invLines.get(l.parentLineId);
        if (!pl) throw new BusinessRuleException('La línea no pertenece a la factura', 'INVALID_PARENT_LINE', [{ field: `lines[${i}]`, code: 'INVALID_PARENT_LINE' }]);
        if (serialProducts.has(pl.productId)) {
          const sold = new Set(pl.serials);
          for (const s of l.serials ?? []) if (!sold.has(s)) throw new BusinessRuleException(`El serial ${s} no fue vendido en esta factura`, 'SERIAL_NOT_SOLD', [{ field: `lines[${i}]`, code: 'SERIAL_NOT_SOLD' }]);
        }
        return { productId: pl.productId, description: pl.description, quantity: l.quantity, unitPrice: pl.unitPrice.toString(), discountPct: pl.discountPct.toString(), taxId: pl.taxId, parentLineId: pl.id, serials: l.serials };
      }),
    };
    const draft = await this.sales.create('CREDIT_NOTE', docInput, v);
    return this.confirmCreditNote(draft.id, v, input.refund);
  }

  private async confirmCreditNote(id: string, v: Viewer, refund?: { bankAccountId: string }) {
    const tx = this.prisma.tx;
    const doc = await this.sales.find('CREDIT_NOTE', id, v, true);
    const lines = await tx.salesDocumentLine.findMany({ where: { documentId: id }, orderBy: { lineNo: 'asc' } });
    const link = await tx.documentLink.findFirstOrThrow({ where: { childId: id } });
    const linkLines = await tx.documentLinkLine.findMany({ where: { linkId: link.id } });
    const parentLines = new Map((await tx.salesDocumentLine.findMany({ where: { documentId: link.parentId } })).map(l => [l.id, l]));
    const moves: MoveRequest[] = [];
    for (const l of lines) {
      const pl = parentLines.get(linkLines.find(x => x.childLineId === l.id)!.parentLineId)!;
      if (pl.unitCost === null) { continue; } // línea de servicio: no mueve inventario
      const prod = await tx.product.findFirstOrThrow({ where: { id: l.productId } });
      if (prod.isService) continue;
      const cost = pl.unitCost.toString();
      if (prod.trackingMode === 'LOT') {
        // reingresa a los mismos lotes de los que salió, en el orden original
        const originals = await tx.inventoryMovement.findMany({ where: { docType: 'INVOICE', docId: link.parentId, docLineId: pl.id, reversalOf: null }, orderBy: { seq: 'asc' } });
        let left = D(l.quantity.toString());
        for (const o of originals) {
          if (left.lte(0)) break;
          const take = Decimal.min(left, D(o.quantity.toString()).abs());
          moves.push({ kind: 'ENTRY', productId: l.productId, warehouseId: doc.warehouseId!, quantity: take.toString(), unitCost: cost, docLineId: l.id, lotId: o.lotId });
          left = left.minus(take);
        }
      } else {
        moves.push({ kind: 'ENTRY', productId: l.productId, warehouseId: doc.warehouseId!, quantity: l.quantity.toString(), unitCost: cost, docLineId: l.id, ...(prod.trackingMode === 'SERIAL' ? { serials: l.serials } : {}) });
      }
      await tx.salesDocumentLine.update({ where: { id: l.id }, data: { unitCost: cost } });
    }
    await this.posting.post({ docType: 'CREDIT_NOTE', docId: id, moves });

    const number = await this.seq.next('SALES_CREDIT_NOTE');
    const controlNo = await this.nextControlNo();
    const total = D(doc.total.toString());
    // Cuenta por cobrar: asiento negativo que se aplica de inmediato contra la factura si esta tiene saldo.
    const cn = await this.receivables.createEntry({
      customerId: doc.customerId, entryType: 'CREDIT_NOTE', sourceType: 'SALES_CREDIT_NOTE', sourceId: id, documentNo: number, issueDate: doc.docDate, dueDate: doc.docDate,
      currencyId: doc.currencyId, exchangeRate: doc.exchangeRate.toString(), amount: total.neg().toFixed(4),
    });
    const invEntry = await tx.receivableEntry.findFirst({ where: { sourceType: 'SALES_INVOICE', sourceId: link.parentId, status: { in: ['OPEN', 'PARTIALLY_PAID'] } } });
    if (invEntry && D(invEntry.balance.toString()).gt(0)) {
      const a = Decimal.min(total, D(invEntry.balance.toString()));
      const nb = D(invEntry.balance.toString()).minus(a);
      await tx.receivableEntry.update({ where: { id: invEntry.id }, data: { balance: nb.toFixed(4), status: entryStatus(nb, D(invEntry.amount.toString())) } });
      const cb = total.minus(a).neg();
      await tx.receivableEntry.update({ where: { id: cn.id }, data: { balance: cb.toFixed(4), status: entryStatus(cb, D(cn.amount.toString())) } });
    }
    await tx.salesDocument.update({
      where: { id },
      data: { status: 'CONFIRMED', number, controlNo, fiscalSnapshot: await this.snapshot(doc.customerId, doc.sellerId), confirmedAt: new Date(), confirmedBy: this.prisma.userId, version: { increment: 1 } },
    });
    if (refund) await this.refundCreditNote(id, cn.id, doc, refund.bankAccountId);
    await this.audit.log('sales_credit_note', id, 'CONFIRM', { number, controlNo, invoice: link.parentId, refund: !!refund });
    return this.sales.get('CREDIT_NOTE', id, v);
  }

  /** Devuelve en dinero el saldo a favor que dejó la nota de crédito (sale de la cuenta indicada). */
  private async refundCreditNote(docId: string, entryId: string, doc: { currencyId: string; exchangeRate: { toString(): string }; docDate: Date; number: string | null }, bankAccountId: string) {
    const tx = this.prisma.tx;
    const entry = await tx.receivableEntry.findFirstOrThrow({ where: { id: entryId } });
    const owed = D(entry.balance.toString()).neg();
    if (owed.lte(0)) throw new BusinessRuleException('La nota no deja saldo a favor que devolver (se aplicó a la factura pendiente)', 'NOTHING_TO_REFUND');
    const acc = await this.treasury.activeAccount(bankAccountId, true);
    let amountAcc = owed;
    if (acc.currencyId !== doc.currencyId) {
      const accRate = await this.sales.rateOf(acc.currencyId, new Date(caracasToday()));
      amountAcc = round(owed.mul(D(doc.exchangeRate.toString())).div(accRate), 4);
    }
    await this.treasury.addMovement({ bankAccountId: acc.id, date: new Date(caracasToday()), kind: 'CUSTOMER_REFUND', amount: amountAcc.neg(), reference: doc.number, description: `Devolución nota de crédito ${doc.number}`, sourceType: 'SALES_CREDIT_NOTE', sourceId: docId });
    await tx.receivableEntry.update({ where: { id: entryId }, data: { balance: '0', status: 'PAID' } });
  }

  // ═════════════════════════ nota de débito ═════════════════════════

  /** Cargo adicional a una factura (intereses, ajuste de precio, gastos…): una línea de concepto sin inventario; aumenta la cuenta por cobrar. */
  async createDebitNote(invoiceId: string, input: z.infer<typeof debitNoteSchema>, v: Viewer) {
    const tx = this.prisma.tx;
    const inv = await this.sales.find('INVOICE', invoiceId, v, true);
    if (inv.status !== 'CONFIRMED') throw new BusinessRuleException(`Solo se emite nota de débito sobre una factura emitida (estado ${inv.status})`, 'INVALID_STATE');
    let product = await tx.product.findFirst({ where: { sku: 'ND-CONCEPTO', deletedAt: null } });
    if (!product) {
      const unit = await tx.unit.findFirstOrThrow({ where: { deletedAt: null }, orderBy: { code: 'asc' } });
      product = await tx.product.create({ data: { companyId: this.prisma.companyId, sku: 'ND-CONCEPTO', name: 'Concepto de nota de débito', unitId: unit.id, isService: true, createdBy: this.prisma.userId } });
    }
    const iva = input.taxId === undefined ? await tx.tax.findFirst({ where: { code: 'IVA_GENERAL', deletedAt: null, isActive: true } }) : null;
    const draft = await this.sales.create('DEBIT_NOTE', {
      customerId: inv.customerId, sellerId: inv.sellerId, warehouseId: inv.warehouseId, currencyId: inv.currencyId, exchangeRate: inv.exchangeRate.toString(),
      paymentCondition: inv.paymentCondition as 'CASH' | 'CREDIT', creditDays: inv.creditDays, reservesStock: false, notes: input.notes ?? null,
      lines: [{ productId: product.id, description: input.concept, quantity: '1', unitPrice: input.amount, discountPct: '0', taxId: input.taxId ?? iva?.id ?? null }],
    }, v);
    await tx.documentLink.create({ data: { companyId: this.prisma.companyId, parentType: 'INVOICE', parentId: invoiceId, childType: 'DEBIT_NOTE', childId: draft.id } });
    const doc = await this.sales.find('DEBIT_NOTE', draft.id, v, true);
    const number = await this.seq.next('SALES_DEBIT_NOTE');
    const controlNo = await this.nextControlNo();
    await this.receivables.createEntry({
      customerId: doc.customerId, entryType: 'DEBIT_NOTE', sourceType: 'SALES_DEBIT_NOTE', sourceId: doc.id, documentNo: number, issueDate: doc.docDate,
      dueDate: new Date(doc.docDate.getTime() + inv.creditDays * DAY), currencyId: doc.currencyId, exchangeRate: doc.exchangeRate.toString(), amount: D(doc.total.toString()).toFixed(4),
    });
    await tx.salesDocument.update({ where: { id: doc.id }, data: { status: 'CONFIRMED', number, controlNo, fiscalSnapshot: await this.snapshot(doc.customerId, doc.sellerId), confirmedAt: new Date(), confirmedBy: this.prisma.userId, version: { increment: 1 } } });
    await this.audit.log('sales_debit_note', doc.id, 'CONFIRM', { number, controlNo, invoice: invoiceId });
    return this.sales.get('DEBIT_NOTE', doc.id, v);
  }

  // ═════════════════════════ PDF ═════════════════════════

  async pdf(docType: 'INVOICE' | 'CREDIT_NOTE' | 'DEBIT_NOTE', id: string, format: 'a4' | 'ticket', v: Viewer) {
    const tx = this.prisma.tx;
    const doc = await this.sales.get(docType, id, v);
    if (doc.status === 'DRAFT') throw new BusinessRuleException('El borrador no tiene PDF fiscal; emita el documento primero', 'DRAFT_NO_PDF');
    const snap = (doc.fiscalSnapshot ?? (await this.snapshot(doc.customerId, doc.sellerId))) as Awaited<ReturnType<InvoicingService['snapshot']>>;
    const cur = await this.prisma.currency.findUniqueOrThrow({ where: { id: doc.currencyId } });
    const taxes = new Map((await tx.tax.findMany({ where: { id: { in: doc.lines.map(l => l.taxId).filter(Boolean) as string[] } } })).map(t => [t.id, t]));
    const methods = new Map((await tx.paymentMethod.findMany()).map(m => [m.id, m.name]));
    const currencies = new Map((await this.prisma.currency.findMany()).map(c => [c.id, c.code]));
    const payments = (docType === 'INVOICE' ? ((doc as unknown as { payments: Awaited<ReturnType<typeof tx.salesDocumentPayment.findMany>> }).payments ?? []) : []);
    const parent = doc.links.parents[0];
    const parentDoc = parent ? await tx.salesDocument.findFirst({ where: { id: parent.id }, select: { number: true, docType: true } }) : null;
    const data: InvoicePdfData = {
      kind: docType, number: doc.number, controlNo: doc.controlNo, status: doc.status, docDate: doc.docDate.toISOString().slice(0, 10),
      dueDate: doc.paymentCondition === 'CREDIT' ? new Date(doc.docDate.getTime() + doc.creditDays * DAY).toISOString().slice(0, 10) : null,
      currency: cur.code, exchangeRate: doc.exchangeRate.toString(), paymentCondition: doc.paymentCondition, creditDays: doc.creditDays, seller: snap.seller, notes: doc.notes,
      origin: docType !== 'INVOICE' && parentDoc ? `Factura ${parentDoc.number}` : null,
      company: snap.company, customer: snap.customer,
      lines: doc.lines.map(l => {
        const t = l.taxId ? taxes.get(l.taxId) : undefined;
        return { sku: l.product?.sku ?? '', name: l.product?.name ?? '', description: l.description, quantity: l.quantity.toString(), unitPrice: l.unitPrice.toString(), discountPct: l.discountPct.toString(), taxRate: l.taxRate.toString(), net: l.net.toString(), exempt: !t || t.kind === 'EXEMPT' || t.kind === 'EXONERATED', serials: l.serials };
      }),
      subtotal: doc.subtotal.toString(), exemptBase: doc.exemptBase.toString(), taxTotal: doc.taxTotal.toString(), total: doc.total.toString(), totalBase: doc.totalBase.toString(),
      igtfPct: doc.igtfPct.toString(), igtfAmount: doc.igtfAmount.toString(),
      payments: payments.map(p => ({ method: methods.get(p.paymentMethodId) ?? '', currency: currencies.get(p.currencyId) ?? '', amount: p.amount.toString(), reference: p.reference })),
      legend: env.INVOICE_LEGEND,
    };
    const buffer = await invoicePdf(data, format);
    return { buffer, filename: `${docType === 'INVOICE' ? 'factura' : docType === 'CREDIT_NOTE' ? 'nota-credito' : 'nota-debito'}-${doc.number}${format === 'ticket' ? '-ticket' : ''}.pdf` };
  }
}
